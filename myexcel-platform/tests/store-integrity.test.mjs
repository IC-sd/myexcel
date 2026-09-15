import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../server/store.mjs';
import { orderFixture } from './fixtures/business-model.mjs';

const tables = ['workbooks', 'workbook_versions', 'workbook_permissions', 'audit_logs'];
const counts = (store) => Object.fromEntries(tables.map((table) => [table, store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));

for (const failingTable of tables.slice(1)) {
  test(`creating a workbook is atomic when ${failingTable} fails`, () => {
    const store = new Store(':memory:');
    try {
      const admin = store.listUsers().find((user) => user.role === 'admin');
      const before = counts(store);
      store.db.exec(`CREATE TRIGGER fail_create BEFORE INSERT ON ${failingTable} BEGIN SELECT RAISE(ABORT, 'creation-test-failure'); END;`);
      assert.throws(() => store.createWorkbook({ name: 'must not survive', userId: admin.id }), /creation-test-failure/);
      assert.deepEqual(counts(store), before, 'no partial workbook, history, permissions or audit may remain');
      store.db.exec('DROP TRIGGER fail_create');
      const saved = store.createWorkbook({ name: 'retry succeeds', userId: admin.id });
      assert.equal(saved.version, 1);
      assert.deepEqual(counts(store), Object.fromEntries(tables.map((table) => [table, before[table] + 1])));
    } finally { store.close(); }
  });
}

test('publishing rejects breaking structural changes against the previous release', () => {
  const store = new Store(':memory:');
  try {
    const admin = store.listUsers().find((user) => user.role === 'admin');
    const { model, snapshot } = orderFixture();
    const book = store.createWorkbook({ name: '采购单', snapshot: structuredClone(snapshot), userId: admin.id });
    let version = book.version;
    const design = (businessModel) => { const result = store.saveDesign({ id: book.id, templateConfig: { businessModel }, dataSourceConfig: { type: 'static' }, expectedVersion: version, userId: admin.id }); version = result.version; return result; };
    design(structuredClone(model));
    const published = store.publishWorkbook({ id: book.id, expectedVersion: version, userId: admin.id });
    assert.equal(published.publishedVersion, 2);

    // Safe change (add a field) publishes fine.
    const safeModel = structuredClone(model);
    safeModel.entities[0].fields.push({ id: 'contact', label: '联系人', type: 'text', required: false });
    design(safeModel);
    assert.equal(store.publishWorkbook({ id: book.id, expectedVersion: version, userId: admin.id }).publishedVersion, 3);

    // Breaking change (change a field type) is rejected before publishing.
    const breakingModel = structuredClone(safeModel);
    breakingModel.entities[1].fields[1].type = 'text';
    design(breakingModel);
    assert.throws(() => store.publishWorkbook({ id: book.id, expectedVersion: version, userId: admin.id }), (error) => error.statusCode === 422 && /类型由/.test(error.message));
    assert.equal(store.getWorkbook(book.id).publishedVersion, 3, 'published version unchanged after rejection');
  } finally { store.close(); }
});
