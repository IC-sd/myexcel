import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { createApplication } from '../server/app.mjs';
import { xlsxToSnapshot } from '../server/workbook-codec.mjs';
import { orderFixture } from './fixtures/business-model.mjs';

test('model preview is read-only, permission/version checked and invalid releases are blocked', async () => {
  const context = await startTestApp();
  try {
    const cookie = await login(context.baseUrl, 'admin', 'Admin123!');
    const viewer = await login(context.baseUrl, 'viewer', 'Viewer123!');
    const editor = await login(context.baseUrl, 'editor', 'Editor123!');
    const { model, snapshot } = orderFixture();
    const admin = context.app.store.authenticate('admin', 'Admin123!');
    const book = context.app.store.createWorkbook({ name: '绑定测试', snapshot, userId: admin.id });
    const path = `/api/workbooks/${book.id}`;
    const preview = (who, version, businessModel = model) => jsonRequest(context.baseUrl, `${path}/design/preview`, { method: 'POST', cookie: who, body: { businessModel, expectedVersion: version } });
    assert.equal((await preview(undefined, 1)).response.status, 401);
    assert.equal((await preview(viewer, 1)).response.status, 403);
    assert.equal((await preview(editor, 1)).response.status, 403);
    assert.equal((await preview(cookie, 0)).response.status, 409);
    assert.equal((await preview(cookie, undefined)).response.status, 428);
    const beforeAudit = context.app.store.listAudit(book.id).length;
    const result = await preview(cookie, 1);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.persisted, false);
    assert.deepEqual(result.payload.relationPreview, []);
    assert.equal(result.payload.record.details.items[0].values.quantity, 2.5);
    assert.equal(context.app.store.getWorkbook(book.id).version, 1);
    assert.equal(context.app.store.listAudit(book.id).length, beforeAudit);
    const invalid = structuredClone(model);
    invalid.document.fields[0].cell = 'C6';
    const denied = await preview(cookie, 1, invalid);
    assert.equal(denied.response.status, 422);
    assert.match(denied.payload.issues[0].message, /公式/);
    const design = (businessModel, expectedVersion) => jsonRequest(context.baseUrl, `${path}/design`, { method: 'PUT', cookie, body: { templateConfig: { businessModel }, dataSourceConfig: {}, expectedVersion } });
    assert.equal((await design(invalid, 1)).response.status, 422);
    assert.equal(context.app.store.getWorkbook(book.id).version, 1);
    const saved = await design(model, 1);
    assert.equal(saved.response.status, 200);
    assert.deepEqual(saved.payload.workbook.templateConfig.businessModel, model);
    const release = await jsonRequest(context.baseUrl, `${path}/publish`, { method: 'POST', cookie, body: { expectedVersion: 2 } });
    assert.equal(release.response.status, 200);
    assert.deepEqual(context.app.store.getPublishedWorkbook(book.id).templateConfig.businessModel, model);
    // A subsequent layout edit may invalidate bindings; publish must revalidate it.
    snapshot.sheets.form.cellData[1][1] = { f: '=1' };
    context.app.store.saveWorkbook({ id: book.id, name: book.name, description: '', snapshot, expectedVersion: 2, userId: admin.id });
    const broken = await jsonRequest(context.baseUrl, `${path}/publish`, { method: 'POST', cookie, body: { expectedVersion: 3 } });
    assert.equal(broken.response.status, 422);
    assert.equal(context.app.store.getPublishedWorkbook(book.id).version, 2);
  } finally { await context.close(); }
});

test('XLSX import persists an explicit compatibility report with the new workbook', async () => {
  const context = await startTestApp();
  try {
    const cookie = await login(context.baseUrl, 'admin', 'Admin123!');
    const malformed = await fetch(`${context.baseUrl}/api/workbooks/import`, { method: 'POST', headers: { Cookie: cookie, 'X-File-Name': '%E0%A4%A' }, body: Buffer.from('not-used') });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /文件名编码/);
    const sheet = XLSX.utils.aoa_to_sheet([[1, 2]]);
    sheet.C1 = { f: 'UNSUPPORTED(A1)' }; sheet['!ref'] = 'A1:C1';
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '导入');
    const response = await fetch(`${context.baseUrl}/api/workbooks/import`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-File-Name': encodeURIComponent('兼容性.xlsx') }, body: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.report.summary.unsupportedFormulas, 1);
    assert.equal(payload.workbook.templateConfig.compatibilityReport.format, 'xlsx');
    assert.equal(context.app.store.getWorkbook(payload.workbook.id).templateConfig.compatibilityReport.formulas[0].supported, false);
  } finally { await context.close(); }
});

async function startTestApp() {
  const directory = mkdtempSync(join(tmpdir(), 'myexcel-api-'));
  const app = createApplication({ databasePath: join(directory, 'test.db') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  return {
    app,
    directory,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function jsonRequest(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  return { response, payload };
}

test('malformed JSON shapes and cookies fail safely without breaking a valid session', async () => {
  const context = await startTestApp();
  try {
    for (const body of ['null', '[]', '123', 'true', '"text"', '{broken']) {
      const response = await fetch(`${context.baseUrl}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      assert.equal(response.status, 400, body);
      assert.match((await response.json()).error, /JSON/);
    }
    const cookie = await login(context.baseUrl, 'admin', 'Admin123!');
    const valid = await jsonRequest(context.baseUrl, '/api/auth/me', { cookie: `${cookie}; unrelated=%E0%A4%A; malformed` });
    assert.equal(valid.response.status, 200);
    assert.equal(valid.payload.user.username, 'admin');
    const invalid = await jsonRequest(context.baseUrl, '/api/auth/me', { cookie: 'myexcel_session=%E0%A4%A' });
    assert.equal(invalid.response.status, 401);
    assert.equal((await jsonRequest(context.baseUrl, '/api/auth/logout', { method: 'POST', cookie: 'myexcel_session=%E0%A4%A' })).response.status, 200);
  } finally { await context.close(); }
});

test('permissions reject invalid batches atomically and report effective fixed roles', async () => {
  const context = await startTestApp();
  try {
    const store = context.app.store;
    const cookie = await login(context.baseUrl, 'admin', 'Admin123!');
    const editorCookie = await login(context.baseUrl, 'editor', 'Editor123!');
    const id = store.listWorkbooks()[0].id;
    const users = Object.fromEntries(store.listUsers().map((user) => [user.role, user]));
    const path = `/api/workbooks/${id}/permissions`;
    const before = store.getPermissions(id);
    const audit = store.listAudit(id);
    const entry = (role, accessLevel) => ({ userId: users[role].id, accessLevel });
    for (const permissions of [undefined, null, {}, [null], [entry('editor', 'invalid')],
      [entry('editor', 'view'), { userId: 'missing', accessLevel: 'edit' }],
      [entry('editor', 'view'), entry('editor', 'design')],
      [entry('viewer', 'design')], [entry('admin', 'view')]]) {
      const result = await jsonRequest(context.baseUrl, path, { method: 'PUT', cookie, body: { permissions } });
      assert.equal(result.response.status, 400, JSON.stringify(permissions));
      assert.deepEqual(store.getPermissions(id), before);
      assert.deepEqual(store.listAudit(id), audit);
    }
    assert.equal((await jsonRequest(context.baseUrl, path, { method: 'PUT', cookie: editorCookie, body: { permissions: [] } })).response.status, 403);
    assert.equal((await jsonRequest(context.baseUrl, '/api/workbooks/missing/permissions', { cookie })).response.status, 404);
    assert.equal((await jsonRequest(context.baseUrl, '/api/workbooks/missing/permissions', { method: 'PUT', cookie, body: { permissions: [] } })).response.status, 404);
    const saved = await jsonRequest(context.baseUrl, path, { method: 'PUT', cookie, body: { permissions: [entry('editor', 'design')] } });
    assert.equal(saved.response.status, 200);
    assert.equal(store.getWorkbookAccess(users.editor, id), 'design');
    // Older data may contain misleading overrides for globally fixed roles.
    const insert = store.db.prepare('INSERT OR REPLACE INTO workbook_permissions (workbook_id, user_id, access_level) VALUES (?, ?, ?)');
    insert.run(id, users.viewer.id, 'design');
    insert.run(id, users.admin.id, 'view');
    for (const permission of store.getPermissions(id)) {
      assert.equal(permission.accessLevel, store.getWorkbookAccess(users[permission.role], id));
    }
  } finally { await context.close(); }
});

test('authentication and role boundaries work', async () => {
  const context = await startTestApp();
  try {
    const adminCookie = await login(context.baseUrl, 'admin', 'Admin123!');
    const viewerCookie = await login(context.baseUrl, 'viewer', 'Viewer123!');

    const adminList = await jsonRequest(context.baseUrl, '/api/workbooks', { cookie: adminCookie });
    assert.equal(adminList.response.status, 200);
    assert.equal(adminList.payload.workbooks.length, 1);

    const viewerList = await jsonRequest(context.baseUrl, '/api/workbooks', { cookie: viewerCookie });
    assert.equal(viewerList.response.status, 200);
    assert.ok(viewerList.payload.workbooks.every((item) => item.status === 'published'));

    const denied = await jsonRequest(context.baseUrl, '/api/workbooks', {
      method: 'POST',
      cookie: viewerCookie,
      body: { name: '不应创建' },
    });
    assert.equal(denied.response.status, 403);

    const allowed = await jsonRequest(context.baseUrl, '/api/workbooks', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '测试工作簿' },
    });
    assert.equal(allowed.response.status, 201);
    assert.equal(allowed.payload.workbook.version, 1);
  } finally {
    await context.close();
  }
});

test('saving creates versions and rejects stale writes', async () => {
  const context = await startTestApp();
  try {
    const cookie = await login(context.baseUrl, 'editor', 'Editor123!');
    const list = await jsonRequest(context.baseUrl, '/api/workbooks', { cookie });
    const id = list.payload.workbooks[0].id;
    const loaded = await jsonRequest(context.baseUrl, `/api/workbooks/${id}`, { cookie });
    const workbook = loaded.payload.workbook;
    workbook.snapshot.sheets.orders.cellData[4] = { 0: { v: 'T004' }, 2: { v: 10 } };

    const saved = await jsonRequest(context.baseUrl, `/api/workbooks/${id}`, {
      method: 'PUT',
      cookie,
      body: {
        name: workbook.name,
        description: workbook.description,
        expectedVersion: workbook.version,
        snapshot: workbook.snapshot,
      },
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.workbook.version, 2);

    const stale = await jsonRequest(context.baseUrl, `/api/workbooks/${id}`, {
      method: 'PUT',
      cookie,
      body: {
        name: workbook.name,
        expectedVersion: 1,
        snapshot: workbook.snapshot,
      },
    });
    assert.equal(stale.response.status, 409);

    const versions = await jsonRequest(context.baseUrl, `/api/workbooks/${id}/versions`, { cookie });
    assert.deepEqual(versions.payload.versions.map((item) => item.version), [2, 1]);
  } finally {
    await context.close();
  }
});

test('template design, publishing, permissions and audit form a complete lifecycle', async () => {
  const context = await startTestApp();
  try {
    const adminCookie = await login(context.baseUrl, 'admin', 'Admin123!');
    const editorCookie = await login(context.baseUrl, 'editor', 'Editor123!');
    const list = await jsonRequest(context.baseUrl, '/api/workbooks', { cookie: adminCookie });
    const id = list.payload.workbooks[0].id;

    const designed = await jsonRequest(context.baseUrl, `/api/workbooks/${id}/design`, {
      method: 'PUT', cookie: adminCookie,
      body: {
        expectedVersion: 1,
        templateConfig: { fields: [{ key: 'orderNo', label: '订单号', sheet: '订单数据', cell: 'A:A' }], formulas: [] },
        dataSourceConfig: { type: 'synthetic', name: '测试数据' },
      },
    });
    assert.equal(designed.response.status, 200);
    assert.equal(designed.payload.workbook.templateConfig.fields[0].key, 'orderNo');

    const published = await jsonRequest(context.baseUrl, `/api/workbooks/${id}/publish`, { method: 'POST', cookie: adminCookie, body: { expectedVersion: 2 } });
    assert.equal(published.response.status, 200);
    assert.equal(published.payload.workbook.status, 'published');
    const publicView = await jsonRequest(context.baseUrl, `/api/published/${id}`, { cookie: editorCookie });
    assert.equal(publicView.response.status, 200);
    assert.equal(publicView.payload.workbook.publishedVersion, 2);

    const permissions = await jsonRequest(context.baseUrl, `/api/workbooks/${id}/permissions`, { cookie: adminCookie });
    const restricted = permissions.payload.permissions.map((item) => ({ ...item, accessLevel: item.username === 'editor' ? 'view' : item.accessLevel }));
    const savedPermissions = await jsonRequest(context.baseUrl, `/api/workbooks/${id}/permissions`, {
      method: 'PUT', cookie: adminCookie, body: { permissions: restricted },
    });
    assert.equal(savedPermissions.response.status, 200);

    const workbook = (await jsonRequest(context.baseUrl, `/api/workbooks/${id}`, { cookie: editorCookie })).payload.workbook;
    const denied = await jsonRequest(context.baseUrl, `/api/workbooks/${id}`, {
      method: 'PUT', cookie: editorCookie,
      body: { name: workbook.name, expectedVersion: workbook.version, snapshot: workbook.snapshot },
    });
    assert.equal(denied.response.status, 403);

    const audit = await jsonRequest(context.baseUrl, `/api/workbooks/${id}/audit`, { cookie: adminCookie });
    assert.ok(audit.payload.audit.some((item) => item.action === 'publish'));
    assert.ok(audit.payload.audit.some((item) => item.action === 'permission'));
  } finally {
    await context.close();
  }
});

test('synthetic workbook benchmark needs no real business data', async () => {
  const context = await startTestApp();
  try {
    const cookie = await login(context.baseUrl, 'admin', 'Admin123!');
    const created = await jsonRequest(context.baseUrl, '/api/benchmarks/workbook', {
      method: 'POST', cookie, body: { rowCount: 500 },
    });
    assert.equal(created.response.status, 201);
    assert.match(created.payload.workbook.name, /500条/);
    assert.equal(created.payload.workbook.snapshot.sheetOrder.length, 3);
    assert.equal(Object.keys(created.payload.workbook.snapshot.sheets.records.cellData).length, 501);
    assert.match(created.payload.workbook.snapshot.sheets.summary.cellData[7][1].v, /合成记录/);
  } finally {
    await context.close();
  }
});

test('read-only routes and exports never leak new drafts; published configuration is immutable', async () => {
  const context = await startTestApp();
  try {
    const admin = await login(context.baseUrl, 'admin', 'Admin123!');
    const viewer = await login(context.baseUrl, 'viewer', 'Viewer123!');
    const request = (path, options = {}) => jsonRequest(context.baseUrl, path, { cookie: admin, ...options });
    const first = (await request('/api/workbooks')).payload.workbooks[0];
    const id = first.id;
    assert.equal((await request(`/api/workbooks/${id}`, { cookie: viewer })).response.status, 404);
    assert.equal((await request(`/api/workbooks/${id}/design`, { method: 'PUT', body: { templateConfig: {}, dataSourceConfig: {} } })).response.status, 428);
    let result = await request(`/api/workbooks/${id}/design`, { method: 'PUT', body: {
      expectedVersion: 1, templateConfig: { title: '公开配置' }, dataSourceConfig: { name: '公开来源' },
    } });
    assert.equal(result.payload.workbook.version, 2);
    assert.equal((await request(`/api/workbooks/${id}/publish`, { method: 'POST', body: { expectedVersion: 1 } })).response.status, 409);
    result = await request(`/api/workbooks/${id}/publish`, { method: 'POST', body: { expectedVersion: 2 } });
    assert.equal(result.response.status, 200);
    const original = (await request(`/api/published/${id}`)).payload.workbook;
    const auditCount = context.app.store.listAudit(id).length;
    await request(`/api/workbooks/${id}/publish`, { method: 'POST', body: { expectedVersion: 2 } });
    assert.equal(context.app.store.listAudit(id).length, auditCount, 'duplicate publication is idempotent');
    const draft = result.payload.workbook;
    draft.snapshot.sheets.orders.cellData[1][0] = { v: 'SECRET_DRAFT' };
    await request(`/api/workbooks/${id}`, { method: 'PUT', body: {
      expectedVersion: 2, name: 'SECRET_TITLE', description: 'SECRET_DESCRIPTION', snapshot: draft.snapshot,
    } });
    await request(`/api/workbooks/${id}/design`, { method: 'PUT', body: {
      expectedVersion: 3, templateConfig: { title: 'SECRET_CONFIG' }, dataSourceConfig: { name: 'SECRET_SOURCE' },
    } });
    assert.equal((await request(`/api/workbooks/${id}/design`, { method: 'PUT', body: {
      expectedVersion: 3, templateConfig: {}, dataSourceConfig: {},
    } })).response.status, 409);
    assert.deepEqual((await request(`/api/published/${id}`)).payload.workbook, original);
    assert.deepEqual((await request(`/api/workbooks/${id}`, { cookie: viewer })).payload.workbook, original);
    const visible = (await request('/api/workbooks', { cookie: viewer })).payload.workbooks;
    assert.equal(visible.length, 1);
    assert.equal(visible[0].version, 2);
    assert.ok(!JSON.stringify(visible).includes('SECRET'));
    assert.equal((await request(`/api/workbooks/${id}/versions`, { cookie: viewer })).response.status, 403);
    const exported = await fetch(`${context.baseUrl}/api/workbooks/${id}/export`, { headers: { Cookie: viewer } });
    const converted = xlsxToSnapshot(Buffer.from(await exported.arrayBuffer()));
    assert.ok(!JSON.stringify(converted).includes('SECRET_DRAFT'));
    assert.equal(context.app.store.getWorkbook(id).version, 4);
  } finally { await context.close(); }
});

test('failed publication rolls back release, pointer and audit together', async () => {
  const context = await startTestApp();
  try {
    const store = context.app.store;
    const id = store.listWorkbooks()[0].id;
    const userId = store.listUsers().find((user) => user.role === 'admin').id;
    store.db.exec("CREATE TEMP TRIGGER reject_publish BEFORE INSERT ON audit_logs WHEN NEW.action = 'publish' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => store.publishWorkbook({ id, expectedVersion: 1, userId }), /test failure/);
    assert.equal(store.getPublishedWorkbook(id), null);
    assert.equal(store.getWorkbook(id).publishedVersion, null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workbook_releases').get().n, 0);
    store.db.exec('DROP TRIGGER reject_publish');
    store.publishWorkbook({ id, expectedVersion: 1, userId });
    store.migrate();
    assert.equal(store.getPublishedWorkbook(id).legacyInferred, false);
  } finally { await context.close(); }
});

test('published version rollback repoints the fixed release without discarding the current draft', async () => {
  const context = await startTestApp();
  try {
    const user = context.app.store.authenticate('admin', 'Admin123!');
    const first = context.app.store.createWorkbook({ name: '回滚验证', userId: user.id });
    context.app.store.publishWorkbook({ id: first.id, expectedVersion: 1, userId: user.id });
    const changed = structuredClone(first.snapshot); changed.sheets[changed.sheetOrder[0]].cellData[0][0].v = '第二发布版';
    context.app.store.saveWorkbook({ id: first.id, name: first.name, snapshot: changed, expectedVersion: 1, userId: user.id });
    context.app.store.publishWorkbook({ id: first.id, expectedVersion: 2, userId: user.id });
    const rolled = context.app.store.rollbackPublishedWorkbook({ id: first.id, version: 1, expectedVersion: 2, userId: user.id });
    assert.equal(rolled.version, 2, 'current draft version remains intact');
    assert.equal(rolled.publishedVersion, 1);
    assert.deepEqual(context.app.store.getPublishedWorkbook(first.id).snapshot, first.snapshot);
    assert.ok(context.app.store.listAudit(first.id).some((item) => item.action === 'rollback'));
  } finally { await context.close(); }
});
