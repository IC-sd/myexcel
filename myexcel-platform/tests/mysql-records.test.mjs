import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BusinessRecords, normalizeRecord, recordProjection, runtimeTemplateProjection } from '../server/business/records.mjs';
import { databaseName, mysqlConfig, migrateBusinessDatabase } from '../server/business/mysql.mjs';
import { orderFixture } from './fixtures/business-model.mjs';
import { mysqlEnabled, mysqlContext } from './fixtures/mysql-context.mjs';
import { typedValue } from '../shared/business-model.mjs';
import { demoDefinitions } from '../server/business/demo.mjs';

const actor = { id: 'owner-a', role: 'editor' };
const other = { id: 'owner-b', role: 'editor' };
const adminActor = { id: 'admin', role: 'admin' };
const allow = () => true;
const releaseFrom = (model, snapshot, name = '合成单据') => ({ id: randomUUID(), version: 2, name, snapshot, templateConfig: { businessModel: model } });
async function fixture(context) {
  const records = new BusinessRecords(context.pool);
  const { model, snapshot } = orderFixture(); model.dataSpaceId = 'test_shared';
  const release = releaseFrom(model, snapshot);
  const supplierModel = { schemaVersion: 1, dataSpaceId: model.dataSpaceId, entities: [model.entities[0]], document: { entityId: 'supplier', fields: [{ fieldId: 'name', sheetId: 'form', cell: 'A2' }], details: [] } };
  const supplierRelease = releaseFrom(supplierModel, snapshot, '供应商资料');
  const supplier = await records.save({ release: supplierRelease, actor, templateAllowed: allow, requestId: randomUUID(), input: { entityId: 'supplier', values: { name: '同名供应商' }, details: {} } });
  const input = { entityId: 'order', values: { supplier_id: supplier.record.id, date: '2026-09-03' }, details: { items: [
    { entityId: 'item', values: { name: '第一物料', quantity: 2.5 } }, { entityId: 'item', values: { name: '第二物料', quantity: 4 } },
  ] } };
  const save = (data = input, options = {}) => records.save({ release, actor, templateAllowed: allow, requestId: randomUUID(), input: data, ...options });
  return { records, release, supplierRelease, supplier, input, save };
}

test('business database configuration cannot silently select an existing or system database', () => {
  assert.equal(mysqlConfig({}), null);
  for (const name of ['mysql', 'legacy-app', 'sheetapp_a; DROP DATABASE mysql', '']) assert.throws(() => databaseName(name));
  assert.throws(() => mysqlConfig({ MYEXCEL_MYSQL_DATABASE: 'sheetapp_dev', MYEXCEL_MYSQL_USER: 'root' }), /密码/);
  assert.equal(mysqlConfig({ MYEXCEL_MYSQL_DATABASE: 'sheetapp_dev', MYEXCEL_MYSQL_USER: 'dev', MYEXCEL_MYSQL_PASSWORD: 'fixture-only' }).database, 'sheetapp_dev');
});

test('fixed decimals preserve precision and reject implicit rounding or float coercion', () => {
  const field = { label: '金额', type: 'decimal', scale: 2, required: true };
  assert.equal(typedValue('9007199254740991.12', field, 'amount'), '9007199254740991.12');
  assert.equal(typedValue('0002.5', field, 'amount'), '2.50');
  assert.equal(typedValue('-0.00', field, 'amount'), '0.00');
  for (const value of ['1.234', 0.1, '1e3', 'NaN', '12345678901234567.89']) assert.throws(() => typedValue(value, field, 'amount'), { statusCode: 422 });
});

test('record input rejects unbound fields and wrong detail IDs', () => {
  const { model } = orderFixture();
  const input = { entityId: 'order', values: { supplier_id: 'x', date: '2026-09-03', ownerId: 'attacker' }, details: { items: [] } };
  assert.throws(() => normalizeRecord(model, input), { statusCode: 422 });
  delete input.values.ownerId;
  input.details.items = [{ id: 'not-an-id', entityId: 'item', values: {} }];
  assert.throws(() => normalizeRecord(model, input), { statusCode: 422 });
});

test('mysql migrations are repeatable and reject changed checksums', { skip: !mysqlEnabled }, async () => {
  const c = await mysqlContext();
  try {
    await migrateBusinessDatabase(c.pool);
    const [[count]] = await c.pool.query('SELECT COUNT(*) AS n FROM mx_migrations'); assert.equal(count.n, 2);
    await c.pool.query("UPDATE mx_migrations SET checksum = REPEAT('0', 64)");
    await assert.rejects(migrateBusinessDatabase(c.pool), /校验和/);
  } finally { await c.close(); }
});

test('mysql persists master/detail identities, reference links, audit, and historical template projection', { skip: !mysqlEnabled }, async () => {
  const c = await mysqlContext();
  try {
    const f = await fixture(c); const saved = await f.save();
    assert.equal(saved.record.version, 1);
    assert.equal(saved.record.details.items.length, 2);
    assert.ok(saved.record.details.items[0].id);
    const [[count]] = await c.pool.query('SELECT COUNT(*) AS n FROM mx_references'); assert.equal(count.n, 3);
    const loaded = await f.records.get(saved.record.id, actor, allow);
    assert.deepEqual(loaded.record, saved.record);
    const projected = recordProjection(loaded);
    assert.equal(projected.snapshot.sheets.form.cellData[1][1].v, f.supplier.record.id);
    assert.equal(projected.snapshot.sheets.form.cellData[5][1].v, 2.5);
    assert.equal(projected.snapshot.sheets.form.cellData[5][2].v, undefined, 'discard stale formula cache');
    const hidden = structuredClone(loaded);
    hidden.release.templateConfig.businessModel.fieldPolicies = [{ entityId: 'order', fieldId: 'supplier_id', role: 'viewer', state: 'hidden' }];
    const viewerProjection = recordProjection(hidden, { role: 'viewer' });
    assert.equal(viewerProjection.record.values.supplier_id, undefined);
    assert.equal(viewerProjection.release.snapshot.sheets.form.cellData[1][1].v, undefined);
    hidden.release.snapshot.sheets.form.cellData[1][1].f = '=B3';
    const hiddenTemplate = runtimeTemplateProjection(hidden.release, { role: 'viewer' });
    assert.equal(hiddenTemplate.snapshot.sheets.form.cellData[1][1].v, undefined);
    assert.equal(hiddenTemplate.snapshot.sheets.form.cellData[1][1].f, undefined);
    const renamed = structuredClone(loaded.record); renamed.details.items.reverse();
    const updated = await f.save(renamed, { id: saved.record.id, expectedVersion: 1 });
    assert.equal(updated.record.version, 2);
    assert.equal(updated.record.details.items[0].id, saved.record.details.items[1].id, 'sort must move IDs with rows');
    assert.equal(updated.record.details.items[0].values.name, '第二物料');
    const [[audit]] = await c.pool.execute('SELECT COUNT(*) AS n FROM mx_audit WHERE record_id = ?', [saved.record.id]); assert.equal(audit.n, 2);
  } finally { await c.close(); }
});

test('mysql serializes duplicate requests and rejects same-key different content', { skip: !mysqlEnabled }, async () => {
  const c = await mysqlContext();
  try {
    const f = await fixture(c); const requestId = randomUUID();
    const [a, b] = await Promise.all([f.save(f.input, { requestId }), f.save(f.input, { requestId })]);
    assert.equal(a.record.id, b.record.id); assert.notEqual(a.replayed, b.replayed);
    const [[count]] = await c.pool.query("SELECT COUNT(*) AS n FROM mx_records WHERE entity_id = 'order'"); assert.equal(count.n, 1);
    await assert.rejects(f.save({ ...f.input, values: { ...f.input.values, date: '2026-09-04' } }, { requestId }), { statusCode: 409 });
  } finally { await c.close(); }
});

test('mysql checks stale writes, ownership and cross-owner references on the server', { skip: !mysqlEnabled }, async () => {
  const c = await mysqlContext();
  try {
    const f = await fixture(c); const saved = await f.save();
    await assert.rejects(f.save(saved.record, { id: saved.record.id, expectedVersion: 0 }), { statusCode: 409 });
    await assert.rejects(f.records.get(saved.record.id, other, allow), { statusCode: 404 });
    await assert.rejects(f.save(f.input, { actor: other }), { statusCode: 422 });
    await assert.rejects(f.save(saved.record, { actor: other, id: saved.record.id, expectedVersion: 1 }), { statusCode: 404 });
    await assert.rejects(f.save(f.input, { actor: { ...actor, role: 'viewer' } }), { statusCode: 403 });
    assert.equal((await f.records.get(saved.record.id, adminActor, allow)).record.id, saved.record.id);
    const options = { spaceId: 'test_shared', entityId: 'order', templateIds: [f.release.id], actor: other };
    assert.deepEqual(await f.records.list(options), []);
    assert.equal((await f.records.list({ ...options, actor })).length, 1);
    await assert.rejects(f.records.list({ ...options, limit: '1;DELETE' }), { statusCode: 422 });
    await assert.rejects(f.records.get(saved.record.id, actor, () => false), { statusCode: 404 });
  } finally { await c.close(); }
});

test('mysql missing relationships and audit failures roll back all record/request changes', { skip: !mysqlEnabled }, async () => {
  const c = await mysqlContext();
  try {
    const f = await fixture(c);
    const invalid = structuredClone(f.input); invalid.values.supplier_id = randomUUID();
    await assert.rejects(f.save(invalid), { statusCode: 422 });
    let [[count]] = await c.pool.query('SELECT COUNT(*) AS n FROM mx_records'); assert.equal(count.n, 1);
    await c.pool.query("CREATE TRIGGER mx_test_audit_fail BEFORE INSERT ON mx_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected audit failure'");
    await assert.rejects(f.save(), /injected audit failure/);
    [[count]] = await c.pool.query('SELECT COUNT(*) AS n FROM mx_records'); assert.equal(count.n, 1);
    [[count]] = await c.pool.query('SELECT COUNT(*) AS n FROM mx_requests'); assert.equal(count.n, 1);
  } finally { await c.close(); }
});

test('mysql refuses foreign detail IDs and schema changes without a migration', { skip: !mysqlEnabled }, async () => {
  const c = await mysqlContext();
  try {
    const f = await fixture(c); const a = await f.save(); const b = await f.save();
    const changed = structuredClone(a.record); changed.details.items[0].id = b.record.details.items[0].id;
    await assert.rejects(f.save(changed, { id: a.record.id, expectedVersion: 1 }), { statusCode: 422 });
    const release = structuredClone(f.release); release.version++;
    release.templateConfig.businessModel.entities[2].fields[2].required = false;
    await assert.rejects(f.save(f.input, { release }), { statusCode: 409 });
    const [[count]] = await c.pool.execute('SELECT COUNT(*) AS n FROM mx_releases WHERE template_id = ? AND version = ?', [release.id, release.version]); assert.equal(count.n, 0);
  } finally { await c.close(); }
});

test('configured lookup, server calculation, cross-template aggregate, workflow and idempotent writeback form one transaction-safe loop', { skip: !mysqlEnabled }, async () => {
  const c = await mysqlContext();
  try {
    const records = new BusinessRecords(c.pool), definitions = Object.fromEntries(demoDefinitions().map((item) => [item.key, item]));
    const release = (key) => ({ id: randomUUID(), version: 1, name: definitions[key].name, snapshot: definitions[key].snapshot, templateConfig: { businessModel: definitions[key].model } });
    const contactRelease = release('contact'), itemRelease = release('catalog_item'), requestRelease = release('request');
    const contact = await records.save({ release: contactRelease, actor, templateAllowed: allow, requestId: randomUUID(), input: { entityId: 'contact', values: { name: '合成联系人', contact: '示例联系方式', status_note: null }, details: {} } });
    const item = await records.save({ release: itemRelease, actor, templateAllowed: allow, requestId: randomUUID(), input: { entityId: 'catalog_item', values: { name: '合成目录条目', code: 'ITEM-01', reference_value: '12.50' }, details: {} } });
    const request = await records.save({ release: requestRelease, actor, templateAllowed: allow, requestId: randomUUID(), input: { entityId: 'request', values: { number: 'REQ-001', date: '2026-09-08', contact_id: contact.record.id, contact_snapshot: null, total_quantity: null }, details: { items: [
      { entityId: 'request_item', values: { catalog_item_id: item.record.id, quantity: 2, confirmed_value: null } },
      { entityId: 'request_item', values: { catalog_item_id: item.record.id, quantity: 3, confirmed_value: null } },
    ] } } });
    assert.equal(request.record.values.contact_snapshot, '示例联系方式');
    assert.equal(request.record.values.total_quantity, 5);
    assert.deepEqual(request.record.details.items.map((detail) => detail.values.confirmed_value), ['12.50', '12.50']);
    const summary = await records.aggregate({ release: requestRelease, templateIds: [contactRelease.id, itemRelease.id, requestRelease.id], actor, templateAllowed: allow });
    assert.equal(summary[0].groups[contact.record.id], 5);
    const stamp = new Date().toISOString();
    const extra = Array.from({ length: 120 }, (_, index) => [
      randomUUID(), 'generic_relation_demo', 'request', requestRelease.id, requestRelease.version, null, null, 0, 1, 'draft', actor.id,
      JSON.stringify({ number: `REQ-BULK-${index}`, date: '2026-09-08', contact_id: contact.record.id, contact_snapshot: '示例联系方式', total_quantity: 1 }), stamp, stamp,
    ]);
    await c.pool.query(`INSERT INTO mx_records (id, space_id, entity_id, template_id, template_version, parent_id, detail_key, ordinal, revision, workflow_state, owner_id, values_json, created_at, updated_at) VALUES ${extra.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`, extra.flat());
    const completeSummary = await records.aggregate({ release: requestRelease, templateIds: [contactRelease.id, itemRelease.id, requestRelease.id], actor, templateAllowed: allow });
    assert.equal(completeSummary[0].groups[contact.record.id], 125, 'aggregate must not silently stop after the first 100 records');
    const submitKey = randomUUID();
    const submitted = await records.transition({ id: request.record.id, transitionId: 'submit', expectedVersion: 1, requestId: submitKey, actor, templateAllowed: allow });
    assert.equal(submitted.record.workflowState, 'submitted');
    assert.equal((await records.transition({ id: request.record.id, transitionId: 'submit', expectedVersion: 1, requestId: submitKey, actor, templateAllowed: allow })).replayed, true);
    const approved = await records.transition({ id: request.record.id, transitionId: 'approve', expectedVersion: 2, requestId: randomUUID(), actor: adminActor, templateAllowed: allow });
    assert.equal(approved.record.workflowState, 'approved');
    assert.equal((await records.get(contact.record.id, actor, allow)).record.values.status_note, '最近申请已确认');
    const [[events]] = await c.pool.execute('SELECT COUNT(*) AS n FROM mx_workflow_events WHERE record_id = ?', [request.record.id]); assert.equal(events.n, 2);
  } finally { await c.close(); }
});

test('recordScope all lets editors collaborate while own keeps records private', { skip: !mysqlEnabled }, async () => {
  const c = await mysqlContext();
  try {
    const records = new BusinessRecords(c.pool);
    const { model, snapshot } = orderFixture(); model.dataSpaceId = 'scope_shared';
    const supplierModel = { schemaVersion: 1, recordScope: 'all', dataSpaceId: 'scope_shared', entities: [model.entities[0]], document: { entityId: 'supplier', fields: [{ fieldId: 'name', sheetId: 'form', cell: 'A2' }], details: [] } };
    const supplierRelease = releaseFrom(supplierModel, snapshot, '供应商资料');
    const supplier = await records.save({ release: supplierRelease, actor, templateAllowed: allow, requestId: randomUUID(), input: { entityId: 'supplier', values: { name: '协作供应商' }, details: {} } });
    const input = () => ({ entityId: 'order', values: { supplier_id: supplier.record.id, date: '2026-09-03' }, details: { items: [] } });

    // Default own scope: editor B can neither list nor open editor A's record.
    const ownRelease = releaseFrom(model, snapshot);
    const own = await records.save({ release: ownRelease, actor, templateAllowed: allow, requestId: randomUUID(), input: input() });
    await assert.rejects(records.get(own.record.id, other, allow), /无权访问/);
    const ownList = await records.list({ spaceId: 'scope_shared', entityId: 'order', templateIds: [ownRelease.id], actor: other, templateId: ownRelease.id });
    assert.equal(ownList.length, 0);
    assert.equal((await records.list({ spaceId: 'scope_shared', entityId: 'order', templateIds: [ownRelease.id], actor: other, scope: 'template' })).length, 0);

    // recordScope 'all': editor B opens, edits and lists editor A's record.
    const sharedModel = structuredClone(model); sharedModel.recordScope = 'all';
    const sharedRelease = releaseFrom(sharedModel, snapshot);
    const shared = await records.save({ release: sharedRelease, actor, templateAllowed: allow, requestId: randomUUID(), input: input() });
    const seen = await records.get(shared.record.id, other, allow);
    assert.equal(seen.record.id, shared.record.id);
    const sharedList = await records.list({ spaceId: 'scope_shared', entityId: 'order', templateIds: [sharedRelease.id], actor: other, templateId: sharedRelease.id, scope: 'all' });
    assert.equal(sharedList.length, 1);
    assert.equal((await records.list({ spaceId: 'scope_shared', entityId: 'order', templateIds: [sharedRelease.id], actor: other, scope: 'template' })).length, 1);
    await records.save({ release: sharedRelease, id: shared.record.id, expectedVersion: shared.record.version, actor: other, templateAllowed: allow, requestId: randomUUID(), input: input() });
  } finally { await c.close(); }
});

test('relationship preview distinguishes match, no-match and permission denial without writes', { skip: !mysqlEnabled }, async () => {
  const c = await mysqlContext();
  try {
    const f = await fixture(c);
    const matched = await f.records.previewRelations({ release: f.release, record: f.input, actor, templateAllowed: allow });
    assert.equal(matched.find((item) => item.fieldId === 'supplier_id').status, 'matched');
    assert.equal(matched.find((item) => item.fieldId === 'supplier_id').cardinality, 'stable-id-unique');
    const denied = await f.records.previewRelations({ release: f.release, record: f.input, actor: other, templateAllowed: allow });
    assert.equal(denied.find((item) => item.fieldId === 'supplier_id').status, 'permission-denied');
    const missing = structuredClone(f.input); missing.values.supplier_id = randomUUID();
    const noMatch = await f.records.previewRelations({ release: f.release, record: missing, actor, templateAllowed: allow });
    assert.equal(noMatch.find((item) => item.fieldId === 'supplier_id').status, 'no-match');
    const [[writes]] = await c.pool.query("SELECT COUNT(*) AS n FROM mx_records WHERE entity_id = 'order'");
    assert.equal(writes.n, 0);
  } finally { await c.close(); }
});
