import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { Store } from './store.mjs';
import { importXlsxWorkbook, snapshotToXlsx } from './workbook-codec.mjs';
import { createSyntheticWorkbookBenchmark } from './benchmark.mjs';
import { extractBusinessRecord, validateBusinessModel } from '../shared/business-model.mjs';
import { BusinessRecords } from './business/records.mjs';
import { LocalBusinessRecords } from './business/local-records.mjs';
import { handleRuntime } from './business/runtime-api.mjs';
import { createTemplatePackage, importTemplatePackage, TEMPLATE_PACKAGE_VERSION, validateTemplatePackage } from './template-package.mjs';
import { openApiV1 } from './openapi.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload));
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').flatMap((part) => {
    const index = part.indexOf('=');
    if (index < 1) return [];
    try { return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))]]; }
    catch { return []; }
  }));
}

async function readBody(request, limit = 30 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求内容过大'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request, limit = 2 * 1024 * 1024) {
  const body = await readBody(request, limit);
  if (!body.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON 格式错误'), { statusCode: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('JSON 请求内容必须是对象'), { statusCode: 400 });
  }
  return parsed;
}

function requireUser(store, request, response, minimumRole = 'viewer') {
  const user = store.getUserBySession(parseCookies(request).myexcel_session);
  if (!user) {
    json(response, 401, { error: '请先登录' });
    return null;
  }
  if (!store.hasRole(user, minimumRole)) {
    json(response, 403, { error: '当前账号没有此操作权限' });
    return null;
  }
  return user;
}

function serveStatic(staticDirectory, pathname, response) {
  if (!staticDirectory) return false;
  const base = resolve(staticDirectory);
  let target = resolve(base, `.${pathname}`);
  if (!target.startsWith(`${base}${sep}`) && target !== base) return false;
  if (existsSync(target) && statSync(target).isDirectory()) target = resolve(target, 'index.html');
  if (!existsSync(target) || !statSync(target).isFile()) target = resolve(base, 'index.html');
  if (!existsSync(target)) return false;
  response.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
  createReadStream(target).pipe(response);
  return true;
}

export function createApplication({ databasePath, staticDirectory = null, businessPool = null, businessRecords = null }) {
  const store = new Store(databasePath);
  const records = businessRecords || (businessPool ? new BusinessRecords(businessPool) : new LocalBusinessRecords(`${databasePath}.records.json`));

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname;

    try {
      if (path === '/api/health' && request.method === 'GET') return json(response, 200, { ok: true, service: 'generic-sheet-app-builder' });
      if ((path === '/api/v1' || path === '/api/v1/') && request.method === 'GET') return json(response, 200, { name: 'generic-sheet-app-builder', apiVersion: 'v1', templatePackageVersion: TEMPLATE_PACKAGE_VERSION, documentation: '/api/v1/openapi.json' });
      if (path === '/api/v1/openapi.json' && request.method === 'GET') return json(response, 200, openApiV1);
      if (path.startsWith('/api/v1/apps/')) {
        const runtimePath = path.replace(/^\/api\/v1\/apps\//, '/api/runtime/');
        return await handleRuntime({ path: runtimePath, url: new URL(`${runtimePath}${url.search}`, 'http://127.0.0.1'), request, response, store, records, json, readJson, requireUser });
      }
      if (path.startsWith('/api/runtime/')) return await handleRuntime({ path, url, request, response, store, records, json, readJson, requireUser });

      if (path === '/api/v1/template-packages/validate' && request.method === 'POST') {
        const user = requireUser(store, request, response, 'editor');
        if (!user) return;
        const report = validateTemplatePackage(await readJson(request, 10 * 1024 * 1024));
        return json(response, report.valid ? 200 : 422, report.valid ? { report } : { error: '模板包兼容性校验未通过', issues: report.issues, report });
      }

      if (path === '/api/v1/template-packages' && request.method === 'POST') {
        const user = requireUser(store, request, response, 'editor');
        if (!user) return;
        const imported = importTemplatePackage(await readJson(request, 10 * 1024 * 1024));
        const workbook = store.createWorkbook({ ...imported, userId: user.id });
        return json(response, 201, { workbook, report: imported.report });
      }

      const packageMatch = path.match(/^\/api\/v1\/templates\/([^/]+)\/package$/);
      if (packageMatch && request.method === 'GET') {
        const user = requireUser(store, request, response);
        if (!user) return;
        if (!store.hasWorkbookAccess(user, packageMatch[1], 'view')) return json(response, 403, { error: '没有此模板包的导出权限' });
        const workbook = url.searchParams.get('published') === '1' || !store.hasWorkbookAccess(user, packageMatch[1], 'edit')
          ? store.getPublishedWorkbook(packageMatch[1]) : store.getWorkbook(packageMatch[1]);
        if (!workbook) return json(response, 404, { error: '模板不存在或尚未发布' });
        const payload = createTemplatePackage(workbook);
        const encodedName = encodeURIComponent(`${workbook.name}.mxapp.json`);
        return json(response, 200, payload, { 'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}` });
      }

      if (path === '/api/auth/login' && request.method === 'POST') {
        const { username, password } = await readJson(request);
        const user = store.authenticate(String(username ?? ''), String(password ?? ''));
        if (!user) return json(response, 401, { error: '账号或密码错误' });
        const session = store.createSession(user.id);
        return json(response, 200, { user }, {
          'Set-Cookie': `myexcel_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
        });
      }

      if (path === '/api/auth/me' && request.method === 'GET') {
        const user = requireUser(store, request, response);
        if (!user) return;
        return json(response, 200, { user });
      }

      if (path === '/api/auth/logout' && request.method === 'POST') {
        const token = parseCookies(request).myexcel_session;
        store.deleteSession(token);
        return json(response, 200, { ok: true }, { 'Set-Cookie': 'myexcel_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }

      if (path === '/api/workbooks' && request.method === 'GET') {
        const user = requireUser(store, request, response);
        if (!user) return;
        return json(response, 200, { workbooks: store.listWorkbooks(user) });
      }

      if (path === '/api/users' && request.method === 'GET') {
        const user = requireUser(store, request, response, 'admin');
        if (!user) return;
        return json(response, 200, { users: store.listUsers() });
      }

      if (path === '/api/benchmarks/workbook' && request.method === 'POST') {
        const user = requireUser(store, request, response, 'admin');
        if (!user) return;
        const body = await readJson(request);
        const snapshot = createSyntheticWorkbookBenchmark(body.rowCount, body.columnCount);
        const workbook = store.createWorkbook({
          name: snapshot.name,
          description: '不含真实数据的多工作表、公式与宽表性能基准',
          snapshot,
          userId: user.id,
        });
        return json(response, 201, { workbook });
      }

      if (path === '/api/workbooks' && request.method === 'POST') {
        const user = requireUser(store, request, response, 'editor');
        if (!user) return;
        const body = await readJson(request);
        const name = String(body.name ?? '').trim();
        if (!name) return json(response, 400, { error: '工作簿名称不能为空' });
        const workbook = store.createWorkbook({ name, description: String(body.description ?? ''), userId: user.id });
        return json(response, 201, { workbook });
      }

      if (path === '/api/workbooks/import' && request.method === 'POST') {
        const user = requireUser(store, request, response, 'editor');
        if (!user) return;
        let fileName;
        try { fileName = decodeURIComponent(String(request.headers['x-file-name'] ?? '导入工作簿.xlsx')); }
        catch { return json(response, 400, { error: '导入文件名编码无效' }); }
        if (fileName.length > 255 || /[\u0000-\u001f\u007f]/.test(fileName)) return json(response, 400, { error: '导入文件名无效' });
        if (!fileName.toLowerCase().endsWith('.xlsx')) return json(response, 400, { error: '当前仅接受 .xlsx 文件' });
        const buffer = await readBody(request);
        const name = fileName.replace(/\.xlsx$/i, '') || '导入工作簿';
        const imported = importXlsxWorkbook(buffer, name);
        const workbook = store.createWorkbook({ name, description: `从 ${fileName} 导入`, snapshot: imported.snapshot, templateConfig: { compatibilityReport: imported.report }, userId: user.id });
        return json(response, 201, { workbook, report: imported.report });
      }

      const workbookMatch = path.match(/^\/api\/workbooks\/([^/]+)$/);
      if (workbookMatch && request.method === 'GET') {
        const user = requireUser(store, request, response);
        if (!user) return;
        if (!store.hasWorkbookAccess(user, workbookMatch[1], 'view')) return json(response, 403, { error: '没有此工作簿的查看权限' });
        const workbook = store.hasWorkbookAccess(user, workbookMatch[1], 'edit')
          ? store.getWorkbook(workbookMatch[1]) : store.getPublishedWorkbook(workbookMatch[1]);
        return workbook ? json(response, 200, { workbook }) : json(response, 404, { error: '工作簿不存在' });
      }

      if (workbookMatch && request.method === 'PUT') {
        const user = requireUser(store, request, response, 'editor');
        if (!user) return;
        if (!store.hasWorkbookAccess(user, workbookMatch[1], 'edit')) return json(response, 403, { error: '没有此工作簿的编辑权限' });
        if ((store.getWorkbook(workbookMatch[1])?.templateConfig.businessModel || store.getPublishedWorkbook(workbookMatch[1])?.templateConfig.businessModel) && !store.hasWorkbookAccess(user, workbookMatch[1], 'design')) return json(response, 403, { error: '业务模板只能由设计人员修改；请通过业务记录入口保存填报数据' });
        const body = await readJson(request);
        if (!body.snapshot || typeof body.snapshot !== 'object') return json(response, 400, { error: '工作簿数据无效' });
        const name = String(body.name ?? '').trim();
        if (!name) return json(response, 400, { error: '工作簿名称不能为空' });
        const result = store.saveWorkbook({
          id: workbookMatch[1],
          name,
          description: String(body.description ?? ''),
          snapshot: body.snapshot,
          expectedVersion: body.expectedVersion,
          userId: user.id,
        });
        if (result.status === 'missing') return json(response, 404, { error: '工作簿不存在' });
        if (result.status === 'conflict') return json(response, 409, { error: '工作簿已被其他人更新，请刷新后重试', currentVersion: result.currentVersion });
        return json(response, 200, { workbook: result.workbook });
      }

      const versionsMatch = path.match(/^\/api\/workbooks\/([^/]+)\/versions$/);
      if (versionsMatch && request.method === 'GET') {
        const user = requireUser(store, request, response);
        if (!user) return;
        if (!store.hasWorkbookAccess(user, versionsMatch[1], 'edit')) return json(response, 403, { error: '只读人员不能查看草稿历史' });
        if (!store.getWorkbook(versionsMatch[1])) return json(response, 404, { error: '工作簿不存在' });
        return json(response, 200, { versions: store.listVersions(versionsMatch[1]) });
      }

      const exportMatch = path.match(/^\/api\/workbooks\/([^/]+)\/export$/);
      if (exportMatch && request.method === 'GET') {
        const user = requireUser(store, request, response);
        if (!user) return;
        if (!store.hasWorkbookAccess(user, exportMatch[1], 'view')) return json(response, 403, { error: '没有此工作簿的导出权限' });
        const workbook = url.searchParams.get('published') === '1' || !store.hasWorkbookAccess(user, exportMatch[1], 'edit')
          ? store.getPublishedWorkbook(exportMatch[1]) : store.getWorkbook(exportMatch[1]);
        if (!workbook) return json(response, 404, { error: '工作簿不存在' });
        const buffer = snapshotToXlsx(workbook.snapshot);
        const encodedName = encodeURIComponent(`${workbook.name}.xlsx`);
        response.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
          'Content-Length': buffer.length,
        });
        return response.end(buffer);
      }

      const previewMatch = path.match(/^\/api\/workbooks\/([^/]+)\/design\/preview$/);
      if (previewMatch && request.method === 'POST') {
        const user = requireUser(store, request, response, 'editor');
        if (!user) return;
        if (!store.hasWorkbookAccess(user, previewMatch[1], 'design')) return json(response, 403, { error: '没有此模板的设计权限' });
        const workbook = store.getWorkbook(previewMatch[1]);
        if (!workbook) return json(response, 404, { error: '工作簿不存在' });
        const body = await readJson(request);
        store.assertExpectedVersion(workbook, body.expectedVersion);
        const report = validateBusinessModel(body.businessModel, workbook.snapshot);
        if (!report.valid) return json(response, 422, { error: '业务模型校验未通过', issues: report.issues });
        const previewRole = ['admin', 'editor', 'viewer'].includes(body.previewRole) ? body.previewRole : user.role;
        const canRead = (sourceId) => Boolean(store.getPublishedWorkbook(sourceId)) && store.hasWorkbookAccess(user, sourceId, 'view');
        let record;
        if (body.recordId) {
          if (!records) return json(response, 503, { error: '关系预览需要已配置的 MySQL 业务库' });
          const loaded = await records.get(body.recordId, user, canRead);
          if (loaded.record.templateId !== workbook.id) return json(response, 422, { error: '测试记录不属于当前模板' });
          record = loaded.record;
        } else record = extractBusinessRecord(body.businessModel, workbook.snapshot);
        const relationPreview = records ? await records.previewRelations({ release: { ...workbook, templateConfig: { businessModel: body.businessModel } }, record, actor: { ...user, role: previewRole }, templateAllowed: canRead }) : [];
        return json(response, 200, { record, relationPreview, previewRole, sourceVersion: workbook.version, persisted: false });
      }

      const designMatch = path.match(/^\/api\/workbooks\/([^/]+)\/design$/);
      if (designMatch && request.method === 'PUT') {
        const user = requireUser(store, request, response, 'editor');
        if (!user) return;
        if (!store.hasWorkbookAccess(user, designMatch[1], 'design')) return json(response, 403, { error: '没有此模板的设计权限' });
        const body = await readJson(request);
        const workbook = store.saveDesign({
          id: designMatch[1], templateConfig: body.templateConfig, dataSourceConfig: body.dataSourceConfig,
          expectedVersion: body.expectedVersion, userId: user.id,
        });
        return workbook ? json(response, 200, { workbook }) : json(response, 404, { error: '工作簿不存在' });
      }

      const publishMatch = path.match(/^\/api\/workbooks\/([^/]+)\/publish$/);
      if (publishMatch && request.method === 'POST') {
        const user = requireUser(store, request, response, 'editor');
        if (!user) return;
        if (!store.hasWorkbookAccess(user, publishMatch[1], 'design')) return json(response, 403, { error: '没有此模板的发布权限' });
        const body = await readJson(request);
        const workbook = store.publishWorkbook({ id: publishMatch[1], expectedVersion: body.expectedVersion, userId: user.id });
        return workbook ? json(response, 200, { workbook }) : json(response, 404, { error: '工作簿不存在' });
      }

      const releasesMatch = path.match(/^\/api\/workbooks\/([^/]+)\/releases$/);
      if (releasesMatch && request.method === 'GET') {
        const user = requireUser(store, request, response, 'editor');
        if (!user) return;
        if (!store.hasWorkbookAccess(user, releasesMatch[1], 'design')) return json(response, 403, { error: '没有此模板的版本查看权限' });
        return json(response, 200, { releases: store.listReleases(releasesMatch[1]) });
      }
      const rollbackMatch = path.match(/^\/api\/workbooks\/([^/]+)\/rollback$/);
      if (rollbackMatch && request.method === 'POST') {
        const user = requireUser(store, request, response, 'editor');
        if (!user) return;
        if (!store.hasWorkbookAccess(user, rollbackMatch[1], 'design')) return json(response, 403, { error: '没有此模板的发布回滚权限' });
        const body = await readJson(request);
        const workbook = store.rollbackPublishedWorkbook({ id: rollbackMatch[1], version: body.version, expectedVersion: body.expectedVersion, userId: user.id });
        return workbook ? json(response, 200, { workbook }) : json(response, 404, { error: '工作簿不存在' });
      }

      const permissionMatch = path.match(/^\/api\/workbooks\/([^/]+)\/permissions$/);
      if (permissionMatch && request.method === 'GET') {
        const user = requireUser(store, request, response, 'editor');
        if (!user) return;
        if (!store.hasWorkbookAccess(user, permissionMatch[1], 'design')) return json(response, 403, { error: '没有此模板的权限管理权限' });
        if (!store.getWorkbook(permissionMatch[1])) return json(response, 404, { error: '工作簿不存在' });
        return json(response, 200, { permissions: store.getPermissions(permissionMatch[1]) });
      }
      if (permissionMatch && request.method === 'PUT') {
        const user = requireUser(store, request, response, 'admin');
        if (!user) return;
        const body = await readJson(request);
        const permissions = store.savePermissions({ id: permissionMatch[1], permissions: body.permissions, userId: user.id });
        return json(response, 200, { permissions });
      }

      const auditMatch = path.match(/^\/api\/workbooks\/([^/]+)\/audit$/);
      if (auditMatch && request.method === 'GET') {
        const user = requireUser(store, request, response, 'editor');
        if (!user) return;
        if (!store.hasWorkbookAccess(user, auditMatch[1], 'design')) return json(response, 403, { error: '没有此模板的审计查看权限' });
        return json(response, 200, { audit: store.listAudit(auditMatch[1]) });
      }

      const publishedMatch = path.match(/^\/api\/published\/([^/]+)$/);
      if (publishedMatch && request.method === 'GET') {
        const user = requireUser(store, request, response);
        if (!user) return;
        if (!store.hasWorkbookAccess(user, publishedMatch[1], 'view')) return json(response, 403, { error: '没有此发布页面的查看权限' });
        const workbook = store.getPublishedWorkbook(publishedMatch[1]);
        return workbook ? json(response, 200, { workbook }) : json(response, 404, { error: '该模板尚未发布' });
      }

      if (path.startsWith('/api/')) return json(response, 404, { error: '接口不存在' });
      if (serveStatic(staticDirectory, path, response)) return;
      json(response, 404, { error: '页面不存在' });
    } catch (error) {
      if (!error.statusCode || error.statusCode >= 500) console.error(error);
      json(response, error.statusCode ?? 500, { error: error.statusCode ? error.message : '服务器内部错误', ...(error.statusCode === 422 && error.issues ? { issues: error.issues } : {}) });
    }
  });

  return {
    server,
    store,
    records,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        store.close();
        if (error) rejectClose(error);
        else resolveClose();
      });
    }),
  };
}
