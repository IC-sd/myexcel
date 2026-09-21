import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareBusinessInputSnapshot } from '../shared/business-model.mjs';
import { orderFixture } from './fixtures/business-model.mjs';
import { deferred, installWindow, mountLogic, settle } from './fixtures/component-logic.mjs';

const command = 'sheet.mutation.set-range-values';
function gridHarness() {
  const listeners = new Map();
  let snapshot = null;
  let creates = 0;
  const permissionModes = [];
  const api = {
    Event: { BeforeCommandExecute: 'before', CommandExecuted: 'after' },
    Enum: { SheetValueChangeType: { SET_RANGE_VALUES: command }, SheetSkeletonChangeType: { INSERT_ROW: 'insert-row' } },
    createWorkbook(next) {
      creates++;
      snapshot = structuredClone(next);
      return { getId: () => 'runtime-unit', save: async () => structuredClone(snapshot),
        getWorkbookPermission: () => ({ setMode: async (mode) => permissionModes.push(mode) }) };
    },
    addEvent(name, callback) { listeners.set(name, callback); return { dispose: () => listeners.delete(name) }; },
    disposeUnit() {},
  };
  return { api, get snapshot() { return snapshot; }, get creates() { return creates; }, permissionModes,
    fire(name, event) { listeners.get(name)?.(event); } };
}
function schema(model, snapshot, canWrite = true) {
  return { template: { name: '订单', version: 1, model, snapshot }, canWrite, recordScope: 'own' };
}
function loadedRecord(model, snapshot) {
  const record = { id: 'record-id', version: 1, templateVersion: 1, values: { supplier_id: 'supplier-id', date: '2026-09-05' },
    details: { items: [{ id: 'detail-id', entityId: 'item', values: { name: '原行', quantity: 2 } }] } };
  return { record, release: { model }, snapshot };
}
function editEvent(row, col, subUnitId = 'form') {
  return { id: command, params: { unitId: 'runtime-unit', subUnitId, cellValue: { [row]: { [col]: { v: 'changed' } } } } };
}

test('record list commits paging only after success and blocks leaving while a record opens', async (t) => {
  installWindow(t);
  const { model, snapshot } = orderFixture();
  const gate = deferred();
  let failPage = false;
  const grid = gridHarness();
  const api = {
    runtimeSchema: async () => schema(model, snapshot),
    listRecords: async (_id, offset) => { if (offset === 30 && failPage) throw new Error('offline'); return { records: [{ id: offset ? 'next' : 'old', values: {}, version: 1 }] }; },
    getRecord: async () => gate.promise,
  };
  const view = await mountLogic('BusinessRecords', { props: { workbookId: 'book' }, api, univerAPI: grid.api });
  t.after(() => view.close());
  assert.equal(view.state.rows[0].id, 'old');
  failPage = true;
  await view.state.page(30);
  assert.equal(view.state.offset, 0);
  assert.equal(view.state.rows[0].id, 'old');
  failPage = false;
  await view.state.page(30);
  assert.equal(view.state.offset, 30);
  const pending = view.state.open('record-id');
  await settle();
  assert.equal(view.state.busy, true);
  assert.equal(view.exposed.mayLeave(), false);
  gate.resolve(loadedRecord(model, snapshot));
  await pending;
  assert.equal(view.state.busy, false);
  assert.equal(grid.creates, 1);
});

test('grid accepts only bound value cells and keeps list-refresh failure separate from save success', async (t) => {
  installWindow(t);
  const { model, snapshot } = orderFixture();
  let listing = 0;
  let payload;
  const grid = gridHarness();
  const savedRecord = { id: 'saved', version: 1, templateVersion: 1, values: { supplier_id: 'supplier-id', date: '2026-09-05' },
    details: { items: [{ id: 'stable-detail', entityId: 'item', values: { name: '粘贴行', quantity: 5 } }] } };
  const savedSnapshot = structuredClone(snapshot);
  savedSnapshot.sheets.form.cellData[1][1].v = 'supplier-id';
  savedSnapshot.sheets.form.cellData[2][1].v = '2026-09-05';
  savedSnapshot.sheets.form.cellData[5][0].v = '粘贴行';
  savedSnapshot.sheets.form.cellData[5][1].v = 5;
  const api = {
    runtimeSchema: async () => schema(model, snapshot),
    listRecords: async () => { if (listing++) throw new Error('refresh offline'); return { records: [] }; },
    saveRecord: async (_book, _id, body) => { payload = body; return { record: savedRecord, release: { model }, snapshot: savedSnapshot, replayed: false }; },
  };
  const view = await mountLogic('BusinessRecords', { props: { workbookId: 'book' }, api, univerAPI: grid.api });
  t.after(() => view.close());
  await view.state.newRecord();
  assert.ok(grid.snapshot, view.state.message);
  assert.equal(grid.snapshot.sheets.form.cellData[1][1].v, null, 'new record must not inherit template sample values');
  grid.snapshot.sheets.form.cellData[1][1].v = 'supplier-id';
  grid.snapshot.sheets.form.cellData[2][1].v = '2026-09-05';
  grid.snapshot.sheets.form.cellData[5][0].v = '粘贴行';
  grid.snapshot.sheets.form.cellData[5][1].v = 5;
  const blocked = editEvent(0, 0);
  grid.fire('before', blocked);
  assert.equal(blocked.cancel, true);
  assert.equal(view.state.dirty, false);
  grid.fire('after', editEvent(5, 0));
  assert.equal(view.state.dirty, true);
  await view.state.save();
  assert.equal(payload.record.details.items[0].values.name, '粘贴行');
  assert.equal(view.state.dirty, false);
  assert.equal(view.state.form.id, 'saved');
  assert.match(view.state.message, /已保存到/);
  assert.match(view.state.message, /列表刷新失败/);
  assert.doesNotMatch(view.state.message, /未确认保存成功/);
});

test('edits made while saving stay in the grid and remain dirty', async (t) => {
  installWindow(t);
  const { model, snapshot } = orderFixture();
  const grid = gridHarness();
  const gate = deferred();
  const opened = loadedRecord(model, prepareBusinessInputSnapshot(model, snapshot));
  const api = { runtimeSchema: async () => schema(model, snapshot), listRecords: async () => ({ records: [] }),
    getRecord: async () => opened, saveRecord: async () => gate.promise };
  const view = await mountLogic('BusinessRecords', { props: { workbookId: 'book' }, api, univerAPI: grid.api });
  t.after(() => view.close());
  await view.state.open('record-id');
  grid.fire('after', editEvent(5, 0));
  const pending = view.state.save();
  await settle();
  grid.snapshot.sheets.form.cellData[5][0].v = '保存期间的新修改';
  grid.fire('after', editEvent(5, 0));
  gate.resolve({ ...opened, record: { ...opened.record, version: 2 }, replayed: false });
  await pending;
  assert.equal(grid.creates, 1, 'successful save must not replace a grid changed during the request');
  assert.equal(grid.snapshot.sheets.form.cellData[5][0].v, '保存期间的新修改');
  assert.equal(view.state.dirty, true);
  assert.match(view.state.message, /仍保留为未保存/);
});

test('viewer opens the historical grid in viewer mode and cannot save', async (t) => {
  installWindow(t);
  const { model, snapshot } = orderFixture();
  const grid = gridHarness();
  const api = { runtimeSchema: async () => schema(model, snapshot, false), listRecords: async () => ({ records: [] }),
    getRecord: async () => loadedRecord(model, snapshot) };
  const view = await mountLogic('BusinessRecords', { props: { workbookId: 'book' }, api, univerAPI: grid.api });
  t.after(() => view.close());
  await view.state.open('record-id');
  assert.deepEqual(grid.permissionModes, ['viewer']);
  assert.equal(view.state.canSave, false);
  assert.match(view.state.scopeMessage, /只读访问/);
  assert.match(view.state.emptyListMessage, /没有可查看的自有记录/);
  grid.fire('after', editEvent(5, 0));
  assert.equal(view.state.dirty, false);
});

test('administrator scope message matches server-side all-record access', async (t) => {
  installWindow(t);
  const { model, snapshot } = orderFixture();
  const grid = gridHarness();
  const api = { runtimeSchema: async () => ({ ...schema(model, snapshot), role: 'admin' }), listRecords: async () => ({ records: [] }) };
  const view = await mountLogic('BusinessRecords', { props: { workbookId: 'book' }, api, univerAPI: grid.api });
  t.after(() => view.close());
  assert.equal(view.state.scopeMessage, '系统管理员可查看全部记录。');
});

test('role field policies block read cells in the browser grid', async (t) => {
  installWindow(t);
  const { model, snapshot } = orderFixture();
  model.fieldPolicies = [{ entityId: 'order', fieldId: 'date', role: 'editor', state: 'read' }];
  const grid = gridHarness();
  const api = {
    runtimeSchema: async () => ({ ...schema(model, snapshot), role: 'editor' }),
    listRecords: async () => ({ records: [] }),
  };
  const view = await mountLogic('BusinessRecords', { props: { workbookId: 'book' }, api, univerAPI: grid.api });
  t.after(() => view.close());
  await view.state.newRecord();
  const blocked = editEvent(2, 1);
  grid.fire('before', blocked);
  assert.equal(blocked.cancel, true, 'read-only bound cells must not be editable in the grid');
});

test('workflow states use stable string ids and readable Chinese labels', async (t) => {
  installWindow(t);
  const { model, snapshot } = orderFixture();
  model.rules = { workflow: { initialState: 'draft', states: ['draft', 'submitted', 'approved', 'returned'], transitions: [] } };
  const grid = gridHarness();
  const api = { runtimeSchema: async () => ({ ...schema(model, snapshot), role: 'editor' }), listRecords: async () => ({ records: [] }) };
  const view = await mountLogic('BusinessRecords', { props: { workbookId: 'book' }, api, univerAPI: grid.api });
  t.after(() => view.close());
  assert.deepEqual(view.state.workflowStates.map((state) => state.id), ['draft', 'submitted', 'approved', 'returned']);
  assert.equal(view.state.workflowStateLabel('returned'), '已退回');
});

test('record editor reveals the grid inside the workspace scroller', async (t) => {
  installWindow(t);
  const { model, snapshot } = orderFixture();
  const grid = gridHarness();
  const api = { runtimeSchema: async () => schema(model, snapshot), listRecords: async () => ({ records: [] }) };
  const view = await mountLogic('BusinessRecords', { props: { workbookId: 'book' }, api, univerAPI: grid.api });
  t.after(() => view.close());
  const scroller = { scrollTop: 180, getBoundingClientRect: () => ({ top: 60 }) };
  view.state.gridCard = { closest: () => scroller, getBoundingClientRect: () => ({ top: 260 }) };
  await view.state.revealGrid();
  assert.equal(scroller.scrollTop, 368);
});
