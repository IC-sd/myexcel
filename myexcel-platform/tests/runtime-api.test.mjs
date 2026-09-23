import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApplication } from '../server/app.mjs';
import { orderFixture } from './fixtures/business-model.mjs';
import { mysqlEnabled, mysqlContext } from './fixtures/mysql-context.mjs';

async function application(pool = null) {
  const directory = mkdtempSync(join(tmpdir(), 'myexcel-runtime-api-'));
  const app = createApplication({ databasePath: join(directory, 'metadata.db'), businessPool: pool });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function login(username, password) { const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }); return response.headers.get('set-cookie').split(';')[0]; }
  async function call(path, cookie, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  }
  return { app, base, call, login, async close() { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function publish(store, model, snapshot, adminId) {
  const book = store.createWorkbook({ name: model.document.entityId, snapshot, userId: adminId });
  store.saveDesign({ id: book.id, templateConfig: { businessModel: model }, dataSourceConfig: {}, expectedVersion: 1, userId: adminId });
  return store.publishWorkbook({ id: book.id, expectedVersion: 2, userId: adminId });
}

test('runtime uses zero-dependency local records by default', async () => {
  const c = await application();
  try {
    assert.equal((await c.call('/api/runtime/status')).status, 401);
    const cookie = await c.login('admin', 'Admin123!');
    const contract = await c.call('/api/v1/openapi.json');
    assert.equal(contract.status, 200);
    assert.equal(contract.body.openapi, '3.1.0');
    assert.ok(contract.body.paths['/apps/{templateId}/records']);
    assert.equal(contract.body.paths['/template-packages/validate'].post.responses['200'].content['application/json'].schema.properties.report.$ref, '#/components/schemas/PackageValidation');
    assert.deepEqual((await c.call('/api/runtime/status', cookie)).body, { configured: true, storage: 'local-json' });
    assert.equal((await c.call('/api/runtime/unknown/records', cookie)).status, 404);
    const owner = c.app.store.authenticate('admin', 'Admin123!');
    const { model, snapshot } = orderFixture();
    const sourceModel = { schemaVersion: 1, dataSpaceId: 'local_demo', entities: [model.entities[0]], document: { entityId: 'supplier', fields: [{ fieldId: 'name', sheetId: 'form', cell: 'A2' }], details: [] } };
    const source = publish(c.app.store, sourceModel, snapshot, owner.id);
    const path = `/api/v1/apps/${source.id}`;
    const created = await c.call(`${path}/records`, cookie, { templateVersion: 2, requestId: randomUUID(), record: { entityId: 'supplier', values: { name: '本地合成资料' }, details: {} } });
    assert.equal(created.status, 201);
    const loaded = await c.call(`${path}/records/${created.body.record.id}`, cookie);
    assert.equal(loaded.status, 200);
    assert.equal(loaded.body.record.values.name, '本地合成资料');
    assert.equal((await c.call(`${path}/records/${created.body.record.id}/audit`, cookie)).body.audit.length, 1);
  } finally { await c.close(); }
});

test('runtime API saves and reopens MySQL records without modifying template drafts or leaking ownership', { skip: !mysqlEnabled }, async () => {
  const mysql = await mysqlContext(); const c = await application(mysql.pool);
  try {
    const adminCookie = await c.login('admin', 'Admin123!');
    const editorCookie = await c.login('editor', 'Editor123!');
    const viewerCookie = await c.login('viewer', 'Viewer123!');
    const owner = c.app.store.authenticate('admin', 'Admin123!');
    const { model, snapshot } = orderFixture(); model.dataSpaceId = 'api_shared';
    model.rules = { workflow: { initialState: 'draft', states: ['draft', 'submitted'], transitions: [] } };
    model.fieldPolicies = [{ entityId: 'supplier', fieldId: 'name', role: 'editor', state: 'hidden' }];
    const sourceModel = { schemaVersion: 1, dataSpaceId: model.dataSpaceId, entities: [model.entities[0]], document: { entityId: 'supplier', fields: [{ fieldId: 'name', sheetId: 'form', cell: 'A2' }], details: [] } };
    const source = publish(c.app.store, sourceModel, snapshot, owner.id);
    const order = publish(c.app.store, model, snapshot, owner.id);
    const sourcePath = `/api/runtime/${source.id}`; const orderPath = `/api/runtime/${order.id}`;
    const supplier = await c.call(`${sourcePath}/records`, editorCookie, { templateVersion: 2, requestId: randomUUID(), record: { entityId: 'supplier', values: { name: '同名资料' }, details: {} } });
    assert.equal(supplier.status, 201);
    const options = await c.call(`${orderPath}/references/supplier`, editorCookie);
    assert.equal(options.body.records[0].id, supplier.body.record.id);
    assert.equal(options.body.records[0].values.name, undefined);
    assert.equal((await c.call(`${orderPath}/references/supplier`, viewerCookie)).body.records.length, 0);
    const record = { entityId: 'order', values: { supplier_id: supplier.body.record.id, date: '2026-09-03' }, details: { items: [{ entityId: 'item', values: { name: '材料', quantity: 10 } }] } };
    const request = { templateVersion: 2, requestId: randomUUID(), record };
    const created = await c.call(`${orderPath}/records`, editorCookie, request);
    assert.equal(created.status, 201);
    const id = created.body.record.id;
    assert.equal((await c.call(`${orderPath}/records?dateFieldId=date&dateFrom=2026-02-30`, editorCookie)).status, 422);
    assert.equal((await c.call(`${orderPath}/records?dateFieldId=date&dateFrom=2026-09-04&dateTo=2026-09-03`, editorCookie)).status, 422);
    assert.equal((await c.call(`${orderPath}/records?workflowState=draft`, editorCookie)).status, 200);
    assert.equal((await c.call(`${orderPath}/records?workflowState=unknown`, editorCookie)).status, 422);
    assert.equal((await c.call(`${orderPath}/records`, editorCookie, request)).body.record.id, id);
    assert.equal(c.app.store.getWorkbook(order.id).version, 2, 'runtime save cannot change template version');
    assert.deepEqual(c.app.store.getWorkbook(order.id).snapshot, order.snapshot);
    assert.equal((await c.call(`${orderPath}/records/${id}`, viewerCookie)).status, 404);
    assert.equal((await c.call(`${orderPath}/records/${id}/export`, viewerCookie)).status, 404);
    assert.equal((await c.call(`${orderPath}/records/${id}/audit`, viewerCookie)).status, 404);
    assert.equal((await c.call(`${orderPath}/records`, viewerCookie, request)).status, 403);
    assert.equal((await c.call(`${orderPath}/records/${id}/export`, editorCookie)).status, 200);
    assert.equal((await c.call(`${orderPath}/records/${id}`, adminCookie)).status, 200);
    assert.equal((await c.call(`/api/workbooks/${order.id}`, editorCookie, { snapshot, name: '不能改模板', expectedVersion: 2 }, 'PUT')).status, 403);
    const loaded = await c.call(`${orderPath}/records/${id}`, editorCookie);
    assert.deepEqual(loaded.body.release.model, model, 'record endpoint exposes the runtime model used by the record editor');
    assert.equal(loaded.body.release.templateConfig, undefined, 'runtime projection must not expose internal template configuration');
    assert.equal(loaded.body.snapshot.sheets.form.cellData[5][1].v, 10);
    // Publish a new layout version; historical data still uses release v2.
    const next = structuredClone(order.snapshot); next.sheets.form.cellData[0][0].v = '新布局';
    c.app.store.saveWorkbook({ id: order.id, name: order.name, snapshot: next, expectedVersion: 2, userId: owner.id });
    c.app.store.publishWorkbook({ id: order.id, expectedVersion: 3, userId: owner.id });
    const currentSchema = await c.call(`${orderPath}/schema`, editorCookie);
    assert.equal(currentSchema.body.template.version, 3);
    assert.equal(currentSchema.body.template.snapshot.sheets.form.cellData[0][0].v, '新布局');
    assert.equal((await c.call(`${orderPath}/records`, editorCookie, { ...request, requestId: randomUUID() })).status, 409);
    const history = await c.call(`${orderPath}/records/${id}`, editorCookie);
    assert.equal(history.body.release.version, 2);
    assert.notEqual(history.body.snapshot.sheets.form.cellData[0][0].v, '新布局');
    const update = { templateVersion: 2, expectedVersion: 1, requestId: randomUUID(), record: history.body.record };
    assert.equal((await c.call(`${orderPath}/records/${id}`, editorCookie, update, 'PUT')).body.record.version, 2);
    assert.equal((await c.call(`${orderPath}/records/${id}`, editorCookie, { ...update, requestId: randomUUID() }, 'PUT')).status, 409);
    const auditRows = Array.from({ length: 105 }, (_, index) => [randomUUID(), id, owner.id, 'update', index + 3, 2, new Date(Date.now() + index).toISOString(), null, JSON.stringify({})]);
    await mysql.pool.query(`INSERT INTO mx_audit (id, record_id, actor_id, action, revision, template_version, created_at, before_json, after_json) VALUES ${auditRows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`, auditRows.flat());
    assert.equal((await c.call(`${orderPath}/records/${id}/audit`, editorCookie)).body.audit.length, 107, 'history endpoint must return the complete record history');
  } finally { await c.close(); await mysql.close(); }
});
