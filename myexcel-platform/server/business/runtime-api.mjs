import { recordProjection, runtimeTemplateProjection, visibleEntityValues, visibleRecord } from './records.mjs';
import { validateBusinessModel } from '../../shared/business-model.mjs';
import { snapshotToXlsx } from '../workbook-codec.mjs';

export async function handleRuntime({ path, url, request, response, store, records, json, readJson, requireUser }) {
  const user = requireUser(store, request, response);
  if (!user) return;
  if (path === '/api/runtime/status' && request.method === 'GET') return json(response, 200, { configured: Boolean(records), storage: records?.storage || null });
  if (!records) return json(response, 503, { error: '业务记录存储不可用' });
  const match = path.match(/^\/api\/runtime\/([^/]+)\/(schema|records|references|summary)(?:\/([^/]+))?(?:\/(export|audit|workflow))?$/);
  if (!match) return json(response, 404, { error: '运行接口不存在' });
  const [, templateId, resource, id, action] = match;
  const canRead = (sourceId) => Boolean(store.getPublishedWorkbook(sourceId)) && store.hasWorkbookAccess(user, sourceId, 'view');
  let readableTemplateIds;
  const templateIds = () => readableTemplateIds ||= store.listWorkbooks(user).filter((book) => canRead(book.id)).map((book) => book.id);
  if (!canRead(templateId)) return json(response, 404, { error: '应用未发布或无权访问' });
  const published = store.getPublishedWorkbook(templateId);
  const model = published.templateConfig?.businessModel;
  if (!validateBusinessModel(model, published.snapshot).valid || published.legacyInferred) return json(response, 422, { error: '请先配置并发布有效业务模型' });

  const recordScope = model.recordScope === 'all' ? 'all' : 'own';

  if (resource === 'schema' && !id && request.method === 'GET') return json(response, 200, { template: runtimeTemplateProjection(published, user),
    canWrite: user.role !== 'viewer' && store.hasWorkbookAccess(user, templateId, 'edit'), recordScope, role: user.role });

  if (resource === 'summary' && !id && request.method === 'GET') return json(response, 200, { summaries: await records.aggregate({ release: published, templateIds: templateIds(), actor: user, templateAllowed: canRead }) });

  if ((resource === 'records' && !id || resource === 'references' && id && !action) && request.method === 'GET') {
    const entityId = resource === 'records' ? model.document.entityId : id;
    if (resource === 'references' && !model.entities.some((entity) => entity.fields.some((field) => field.type === 'reference' && field.targetEntityId === entityId))) return json(response, 422, { error: '该实体不是模型中配置的关联目标' });
    const dateFieldId = resource === 'records' ? url.searchParams.get('dateFieldId') : null;
    const dateFrom = resource === 'records' ? url.searchParams.get('dateFrom') : null;
    const dateTo = resource === 'records' ? url.searchParams.get('dateTo') : null;
    const workflowState = resource === 'records' ? url.searchParams.get('workflowState') : null;
    if ((dateFrom || dateTo) && !model.document.fields.some((binding) => binding.fieldId === dateFieldId && model.entities.find((entity) => entity.id === model.document.entityId).fields.some((field) => field.id === dateFieldId && field.type === 'date'))) return json(response, 422, { error: '日期筛选字段必须是当前业务单据已绑定的日期字段' });
    if (workflowState && !model.rules?.workflow?.states?.includes(workflowState)) return json(response, 422, { error: '流程状态不属于当前业务单据' });
    const limit = Number(url.searchParams.get('limit') || 30), offset = Number(url.searchParams.get('offset') || 0);
    const options = await records.list({ spaceId: model.dataSpaceId || templateId, entityId, templateIds: templateIds(), actor: user,
      templateId: resource === 'records' ? templateId : null, scope: resource === 'records' ? recordScope : 'template', dateFieldId, dateFrom, dateTo, workflowState, limit, offset });
    return json(response, 200, { records: resource === 'records' ? options.map((record) => visibleRecord(model, record, user.role)) : options.map((record) => ({ ...record, values: visibleEntityValues(model, entityId, record.values, user.role) })), limit, offset });
  }

  if (resource === 'records' && id && request.method === 'GET') {
    const loaded = await records.get(id, user, canRead);
    if (loaded.record.templateId !== templateId) return json(response, 404, { error: '记录不属于此模板' });
    if (action === 'audit') {
      return json(response, 200, { audit: await records.audit(id) });
    }
    if (action === 'workflow') return json(response, 405, { error: '流程操作必须使用 POST' });
    const projection = recordProjection(loaded, user);
    if (action === 'export') {
      const buffer = snapshotToXlsx(projection.snapshot);
      response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${loaded.release.name}-${id}.xlsx`)}` });
      return response.end(buffer);
    }
    return json(response, 200, projection);
  }


  if (resource === 'records' && id && action === 'workflow' && request.method === 'POST') {
    if (user.role === 'viewer' || !store.hasWorkbookAccess(user, templateId, 'edit')) return json(response, 403, { error: '没有流程处理权限' });
    const body = await readJson(request);
    const result = await records.transition({ id, transitionId: body.transitionId, expectedVersion: body.expectedVersion, requestId: body.requestId, actor: user, templateAllowed: canRead });
    return json(response, 200, recordProjection(result, user));
  }

  if (resource === 'records' && !action && (request.method === 'POST' && !id || request.method === 'PUT' && id)) {
    if (user.role === 'viewer' || !store.hasWorkbookAccess(user, templateId, 'edit')) return json(response, 403, { error: '没有此应用的业务记录填写权限' });
    const body = await readJson(request);
    const release = id ? (await records.get(id, user, canRead)).release : published;
    if (release.id !== templateId) return json(response, 404, { error: '记录不属于此模板' });
    if (body.templateVersion !== release.version) return json(response, 409, { error: '模板版本已变化；新单据请刷新，历史单据请使用原版本' });
    const saved = await records.save({ release, id: id || null, expectedVersion: body.expectedVersion, requestId: body.requestId, input: body.record, actor: user, templateAllowed: canRead });
    return json(response, id || saved.replayed ? 200 : 201, recordProjection(saved, user));
  }
  return json(response, 404, { error: '运行接口不存在' });
}
