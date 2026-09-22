import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApplication } from '../server/app.mjs';
import { createTemplatePackage, importTemplatePackage, validateTemplatePackage } from '../server/template-package.mjs';
import { orderFixture } from './fixtures/business-model.mjs';

async function application() {
  const directory = mkdtempSync(join(tmpdir(), 'myexcel-package-'));
  const app = createApplication({ databasePath: join(directory, 'metadata.db') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const loginResponse = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Admin123!' }) });
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const call = async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(base + path, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { response, payload: await response.json() };
  };
  return { app, call, close: async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('template package is versioned, contains only reusable design, and receives a new workbook identity', () => {
  const { model, snapshot } = orderFixture();
  const source = { id: 'private-id', name: '通用订单模板', description: '合成模板', snapshot, templateConfig: { businessModel: model }, dataSourceConfig: { type: 'static', name: '合成来源', connection: 'PRIVATE_CONNECTION', password: 'PRIVATE_PASSWORD' }, createdAt: 'private', updatedAt: 'private' };
  const payload = createTemplatePackage(source);
  assert.equal(payload.format, 'myexcel-template-package');
  assert.equal(payload.version, 1);
  assert.equal(payload.id, undefined);
  assert.equal(JSON.stringify(payload).includes('private-id'), false);
  assert.deepEqual(payload.template.dataSourceConfig, { type: 'static', name: '合成来源' });
  assert.equal(JSON.stringify(payload).includes('PRIVATE_'), false);
  assert.equal(validateTemplatePackage(payload).valid, true);
  const imported = importTemplatePackage(payload);
  assert.notEqual(imported.snapshot.id, snapshot.id);
  assert.deepEqual(imported.templateConfig.businessModel, model);
  assert.deepEqual(imported.snapshot.sheets, snapshot.sheets);
});

test('template package rejects unsupported versions and invalid business bindings', () => {
  const { model, snapshot } = orderFixture();
  const payload = createTemplatePackage({ name: '示例', description: '', snapshot, templateConfig: { businessModel: model }, dataSourceConfig: {} });
  payload.version = 99;
  payload.template.templateConfig.businessModel.document.fields[0].cell = 'ZZZ9999999';
  const report = validateTemplatePackage(payload);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((item) => item.path === 'version'));
  assert.ok(report.issues.some((item) => item.path.includes('businessModel')));
});

test('template package rejects unsafe workbook dimensions and stored cell coordinates', () => {
  const { model, snapshot } = orderFixture();
  const payload = createTemplatePackage({ name: '示例', description: '', snapshot, templateConfig: { businessModel: model }, dataSourceConfig: {} });
  payload.template.snapshot.sheets.form.rowCount = 2000000;
  payload.template.snapshot.sheets.form.cellData[9999999] = { 0: { v: '越界' } };
  const report = validateTemplatePackage(payload);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((item) => item.message.includes('超出支持范围')));
  assert.ok(report.issues.some((item) => item.message.includes('行坐标')));
});

test('template package migrates between two clean instances without records or permissions', async () => {
  const source = await application();
  const target = await application();
  try {
    const admin = source.app.store.authenticate('admin', 'Admin123!');
    const { model, snapshot } = orderFixture();
    const workbook = source.app.store.createWorkbook({ name: '可迁移通用模板', description: '只含合成结构', snapshot, templateConfig: { businessModel: model }, dataSourceConfig: { type: 'static' }, userId: admin.id });
    const sourceEditor = source.app.store.listUsers().find((user) => user.username === 'editor');
    source.app.store.savePermissions({ id: workbook.id, permissions: [{ userId: sourceEditor.id, accessLevel: 'design' }], userId: admin.id });
    const exported = await source.call(`/api/v1/templates/${workbook.id}/package`);
    assert.equal(exported.response.status, 200);
    const validated = await target.call('/api/v1/template-packages/validate', { method: 'POST', body: exported.payload });
    assert.equal(validated.response.status, 200);
    const imported = await target.call('/api/v1/template-packages', { method: 'POST', body: exported.payload });
    assert.equal(imported.response.status, 201);
    assert.notEqual(imported.payload.workbook.id, workbook.id);
    assert.notEqual(imported.payload.workbook.snapshot.id, workbook.snapshot.id);
    assert.deepEqual(imported.payload.workbook.templateConfig.businessModel, model);
    assert.deepEqual(imported.payload.workbook.snapshot.sheets, snapshot.sheets);
    assert.equal(target.app.store.getPermissions(imported.payload.workbook.id).find((row) => row.username === 'editor').accessLevel, 'edit', 'instance-specific permission overrides are not transferred');
    assert.equal((await target.call(`/api/v1/apps/${imported.payload.workbook.id}/records`)).response.status, 404, 'imported package remains a draft and has no transferred records');
  } finally {
    await source.close();
    await target.close();
  }
});
