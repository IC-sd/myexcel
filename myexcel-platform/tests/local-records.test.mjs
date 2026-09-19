import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalBusinessRecords } from '../server/business/local-records.mjs';
import { seedDemo } from '../server/business/demo.mjs';
import { Store } from '../server/store.mjs';
import { orderFixture } from './fixtures/business-model.mjs';

const actor = { id: 'local-owner', role: 'editor' };
const allow = () => true;
const releaseFrom = (model, snapshot, name) => ({ id: randomUUID(), version: 2, name, snapshot, templateConfig: { businessModel: model } });

test('local records persist a master-detail relationship without MySQL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sheetapp-local-records-'));
  const path = join(directory, 'records.json');
  try {
    const records = new LocalBusinessRecords(path);
    const { model, snapshot } = orderFixture(); model.dataSpaceId = 'local_shared';
    model.entities[1].fields.push({ id: 'supplier_name', label: '资料名称', type: 'text', required: false });
    model.document.fields.push({ fieldId: 'supplier_name', sheetId: 'form', cell: 'C2' });
    model.rules = { lookups: [{ id: 'supplier_name', entityId: 'order', referenceFieldId: 'supplier_id', targetFieldId: 'name', destinationFieldId: 'supplier_name', strategy: 'snapshot' }], aggregates: [{ id: 'orders_by_supplier', label: '按资料计数', entityId: 'order', fieldId: 'date', groupByFieldId: 'supplier_id', operation: 'count' }] };
    const supplierModel = { schemaVersion: 1, dataSpaceId: model.dataSpaceId, entities: [model.entities[0]], document: { entityId: 'supplier', fields: [{ fieldId: 'name', sheetId: 'form', cell: 'A2' }], details: [] } };
    const supplierRelease = releaseFrom(supplierModel, snapshot, '资料目录');
    const orderRelease = releaseFrom(model, snapshot, '通用申请');
    const supplier = await records.save({ release: supplierRelease, actor, templateAllowed: allow, requestId: randomUUID(), input: { entityId: 'supplier', values: { name: '本地资料 A' }, details: {} } });
    const input = { entityId: 'order', values: { supplier_id: supplier.record.id, supplier_name: null, date: '2026-09-16' }, details: { items: [{ entityId: 'item', values: { name: '条目一', quantity: 2 } }] } };
    const created = await records.save({ release: orderRelease, actor, templateAllowed: allow, requestId: randomUUID(), input });
    assert.equal(created.record.values.supplier_name, '本地资料 A');
    assert.equal(created.record.details.items.length, 1);
    assert.match(created.record.details.items[0].id, /^[0-9a-f-]{36}$/);
    assert.equal((await records.audit(created.record.id)).length, 1);
    assert.equal((await records.aggregate({ release: orderRelease, templateIds: [supplierRelease.id, orderRelease.id], actor, templateAllowed: allow }))[0].groups[supplier.record.id], 1);

    const reopened = new LocalBusinessRecords(path);
    const loaded = await reopened.get(created.record.id, actor, allow);
    assert.equal(loaded.record.values.supplier_name, '本地资料 A');
    assert.equal((await reopened.list({ spaceId: model.dataSpaceId, entityId: 'order', templateIds: [orderRelease.id], actor })).length, 1);
    const replay = await reopened.save({ release: orderRelease, actor, templateAllowed: allow, requestId: 'local-replay-key', input });
    const repeated = await reopened.save({ release: orderRelease, actor, templateAllowed: allow, requestId: 'local-replay-key', input });
    assert.equal(repeated.record.id, replay.record.id);
    assert.equal(repeated.replayed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh local mode seeds a reproducible three-template demo once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sheetapp-local-demo-'));
  const store = new Store(join(directory, 'metadata.db'));
  try {
    const records = new LocalBusinessRecords(join(directory, 'records.json'));
    await seedDemo({ store, records });
    await seedDemo({ store, records });
    const demos = store.listWorkbooks().filter((book) => book.description.startsWith('builtin:generic-demo:'));
    assert.equal(demos.length, 3);
    assert.ok(demos.every((book) => book.status === 'published'));
    const admin = store.listUsers().find((user) => user.role === 'admin');
    const request = demos.map((book) => store.getPublishedWorkbook(book.id)).find((book) => book.templateConfig.businessModel.document.entityId === 'request');
    const rows = await records.list({ spaceId: 'generic_relation_demo', entityId: 'request', templateId: request.id, templateIds: demos.map((book) => book.id), actor: admin });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.values.contact_snapshot === '示例联系方式' && row.values.total_quantity === 2));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
