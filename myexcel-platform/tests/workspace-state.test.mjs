import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, installWindow, mountLogic, settle } from './fixtures/component-logic.mjs';
import { orderFixture } from './fixtures/business-model.mjs';

const business = { id: 'business', name: 'Business', version: 1, accessLevel: 'design', templateConfig: { businessModel: {} } };
const plain = { id: 'plain', name: 'Plain', version: 1, accessLevel: 'design', templateConfig: {}, snapshot: { id: 'snap' } };

test('workspace guards creation and opens a plain workbook in its correct view with immediate tracking', async (t) => {
  installWindow(t); let creates = 0, listener;
  const api = { listWorkbooks: async () => ({ workbooks: [business, plain] }), getWorkbook: async (id) => ({ workbook: id === business.id ? business : plain }),
    createWorkbook: async () => { creates++; return { workbook: plain }; } };
  const univerAPI = { Event: { CommandExecuted: 'command' }, Enum: { SheetValueChangeType: { SET_RANGE_VALUES: 'sheet.mutation.set-range-values' } }, createWorkbook: () => ({ getId: () => 'unit', getWorkbookPermission: () => ({ setMode: async () => {} }), save: async () => plain.snapshot }),
    addEvent: (_event, callback) => { listener = callback; return { dispose() {} }; }, disposeUnit() {}, dispose() {} };
  const view = await mountLogic('WorkspaceView', { props: { user: { role: 'admin', displayName: 'A' } }, api, univerAPI });
  t.after(() => view.close());
  assert.equal(view.state.viewMode, 'records');
  view.state.recordEditor = { mayLeave: () => false, busy: false };
  await view.state.createWorkbook();
  assert.equal(creates, 0);
  view.state.recordEditor = { mayLeave: () => true, busy: false };
  await view.state.createWorkbook();
  assert.equal(creates, 1);
  assert.equal(view.state.viewMode, 'workbook');
  assert.equal(view.state.active.id, 'plain');
  assert.equal(typeof listener, 'function');
  listener({ id: 'sheet.mutation.set-range-values', params: { unitId: 'unit' }, options: { onlyLocal: true, fromFormula: true } });
  assert.equal(view.state.dirty, false);
  listener({ id: 'sheet.mutation.set-range-values', params: { unitId: 'unit' } });
  assert.equal(view.state.dirty, true);
});

test('workspace keeps edits made while a save request is in flight marked unsaved', async (t) => {
  installWindow(t); let listener; const savingSnapshot = deferred();
  const api = { listWorkbooks: async () => ({ workbooks: [plain] }), getWorkbook: async () => ({ workbook: plain }),
    saveWorkbook: async () => ({ workbook: { ...plain, version: 2 } }) };
  const facade = { getId: () => 'unit', getWorkbookPermission: () => ({ setMode: async () => {} }), save: () => savingSnapshot.promise };
  const univerAPI = { Event: { CommandExecuted: 'command' }, Enum: { SheetValueChangeType: { SET_RANGE_VALUES: 'sheet.mutation.set-range-values' } }, createWorkbook: () => facade,
    addEvent: (_event, callback) => { listener = callback; return { dispose() {} }; }, disposeUnit() {}, dispose() {} };
  const view = await mountLogic('WorkspaceView', { props: { user: { role: 'admin', displayName: 'A' } }, api, univerAPI });
  t.after(() => view.close());
  listener({ id: 'sheet.mutation.set-range-values', params: { unitId: 'unit' } });
  const request = view.state.saveWorkbook(); await settle();
  listener({ id: 'sheet.mutation.set-range-values', params: { unitId: 'unit' } });
  savingSnapshot.resolve(plain.snapshot); await request;
  assert.equal(view.state.dirty, true);
  assert.match(view.state.message, /保存期间又有修改/);
});

test('imported business template opens in design mode before it is published', async (t) => {
  installWindow(t); let lists = 0;
  const imported = { id: 'imported', name: 'Imported', version: 1, status: 'draft', templateConfig: { businessModel: { schemaVersion: 1 } }, dataSourceConfig: {}, snapshot: { id: 'imported-snapshot' } };
  const api = {
    listWorkbooks: async () => ({ workbooks: lists++ ? [business, { ...imported, accessLevel: 'design' }] : [business] }),
    getWorkbook: async () => ({ workbook: business }),
    importTemplatePackage: async () => ({ workbook: imported, report: { summary: { sheets: 1, formulas: 0 } } }),
  };
  const univerAPI = { Event: { CommandExecuted: 'command' }, Enum: { SheetValueChangeType: {} }, createWorkbook: () => { throw new Error('draft business template must not open in runtime grid'); }, disposeUnit() {}, dispose() {} };
  const view = await mountLogic('WorkspaceView', { props: { user: { role: 'admin', displayName: 'A' } }, api, univerAPI });
  t.after(() => view.close());
  await view.state.importPackage({ target: { files: [{ name: 'sample.mxapp.json', text: async () => '{}' }], value: 'selected' } });
  assert.equal(view.state.viewMode, 'designer');
  assert.equal(view.state.active.id, 'imported');
  assert.match(view.state.message, /模板包已导入为独立草稿/);
});

test('designer binds the current Univer cell selection without typing an address', async (t) => {
  installWindow(t); const fixture = orderFixture(); let savedPayload;
  const book = { id: 'bound', name: 'Bound', version: 1, accessLevel: 'design', templateConfig: { businessModel: fixture.model }, dataSourceConfig: {}, snapshot: fixture.snapshot };
  const range = { getRange: () => ({ startRow: 3, endRow: 3, startColumn: 3, endColumn: 3 }), getA1Notation: () => 'D4' };
  const facade = { getId: () => 'unit', getWorkbookPermission: () => ({ setMode: async () => {} }), getActiveSheet: () => ({ getSheetId: () => 'form', getActiveRange: () => range }) };
  const api = {
    listWorkbooks: async () => ({ workbooks: [book] }), getWorkbook: async () => ({ workbook: book }),
    saveDesign: async (_id, payload) => { savedPayload = payload; return { workbook: { ...book, version: 2, templateConfig: payload.templateConfig } }; },
  };
  const univerAPI = { Event: { CommandExecuted: 'command' }, Enum: { SheetValueChangeType: {} }, createWorkbook: () => facade, addEvent: () => ({ dispose() {} }), disposeUnit() {}, dispose() {} };
  const view = await mountLogic('WorkspaceView', { props: { user: { role: 'admin', displayName: 'A' } }, api, univerAPI });
  t.after(() => view.close());
  await view.state.switchMode('template');
  view.state.captureBindingSelection();
  assert.equal(view.state.showBinding, true);
  assert.equal(view.state.bindingSelection.address, 'D4');
  view.state.bindingKind = 'main'; view.state.bindingFieldId = 'date';
  await view.state.applySelectionBinding();
  assert.equal(savedPayload.templateConfig.businessModel.document.fields.find((item) => item.fieldId === 'date').cell, 'D4');
  assert.equal(view.state.showBinding, false);
  assert.match(view.state.message, /已将 form!D4 绑定/);
});
