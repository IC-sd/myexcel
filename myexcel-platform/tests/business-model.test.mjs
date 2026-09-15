import assert from 'node:assert/strict';
import test from 'node:test';
import { cellPosition, diffModelSchema, exactGridDate, extractBusinessRecord, fieldState, hydrateBusinessRecord, inspectWorkbookFormulas, prepareBusinessInputSnapshot, validateBusinessModel } from '../shared/business-model.mjs';
import { expenseFixture, orderFixture } from './fixtures/business-model.mjs';

test('cell addresses have bounded, unambiguous coordinates', () => {
  assert.deepEqual(cellPosition('AA10'), { row: 9, col: 26 });
  assert.deepEqual(cellPosition('XFD1048576'), { row: 1048575, col: 16383 });
  for (const value of ['A0', 'A01', 'a1', 'A:A', 'XFE1', 'A1048577', '=A1', null]) assert.equal(cellPosition(value), null);
});

test('master-detail extraction and hydration round trip preserve layout and unrelated formulas', () => {
  const { model, snapshot } = orderFixture();
  const original = structuredClone(snapshot);
  assert.deepEqual(validateBusinessModel(model, snapshot), { valid: true, issues: [] });
  const record = extractBusinessRecord(model, snapshot);
  assert.deepEqual(record, { entityId: 'order', values: { supplier_id: 'supplier-001', date: '2026-09-03' }, details: {
    items: [{ entityId: 'item', values: { name: '测试物料', quantity: 2.5 } }],
  } });
  assert.equal('order_id' in record.details.items[0].values, false, 'parent identity belongs to persistence, not editable rows');
  record.values.supplier_id = 'supplier-002';
  record.details.items.push({ entityId: 'item', values: { name: '第二行', quantity: 0 } });
  const hydrated = hydrateBusinessRecord(model, snapshot, record);
  assert.deepEqual(extractBusinessRecord(model, hydrated), record);
  assert.equal(hydrated.sheets.form.cellData[1][1].s, 'input-style');
  assert.deepEqual(hydrated.sheets.form.cellData[5][2], original.sheets.form.cellData[5][2]);
  assert.deepEqual(snapshot, original, 'input snapshot must not be mutated');
  record.details.items = [];
  assert.deepEqual(extractBusinessRecord(model, hydrateBusinessRecord(model, hydrated, record)).details.items, []);
});

test('second business model works without procurement-specific code', () => {
  const { model, snapshot } = expenseFixture();
  const record = extractBusinessRecord(model, snapshot);
  assert.deepEqual(record.values, { category: '交通', amount: 0, receipt: false });
  assert.deepEqual(extractBusinessRecord(model, hydrateBusinessRecord(model, snapshot, record)), record);
});

test('grid preparation clears template samples, preserves layout and forces exact text types', () => {
  const { model, snapshot } = orderFixture();
  const original = structuredClone(snapshot);
  const prepared = prepareBusinessInputSnapshot(model, snapshot, { clearValues: true });
  assert.equal(prepared.sheets.form.cellData[1][1].v, null);
  assert.equal(prepared.sheets.form.cellData[1][1].t, 4);
  assert.equal(prepared.sheets.form.cellData[1][1].s, 'input-style');
  assert.equal(prepared.sheets.form.cellData[5][0].v, null);
  assert.equal(prepared.sheets.form.cellData[5][0].t, 4);
  assert.equal(prepared.sheets.form.cellData[5][1].v, null);
  assert.equal(prepared.sheets.form.cellData[5][1].t, undefined);
  assert.deepEqual(prepared.sheets.form.cellData[5][2], original.sheets.form.cellData[5][2]);
  assert.deepEqual(snapshot, original, 'published snapshot must remain immutable');
});

test('grid extraction keeps stable detail identities by reserved row position', () => {
  const { model, snapshot } = orderFixture();
  const prepared = prepareBusinessInputSnapshot(model, snapshot, { clearValues: true });
  prepared.sheets.form.cellData[1][1].v = 'supplier-id';
  prepared.sheets.form.cellData[2][1].v = '2026-09-05';
  prepared.sheets.form.cellData[6] = { 0: { v: '保留第二行' }, 1: { v: 3 } };
  const record = extractBusinessRecord(model, prepared, { detailRowIds: { items: ['removed-id', 'stable-id'] } });
  assert.equal(record.details.items.length, 1);
  assert.equal(record.details.items[0].id, 'stable-id');
});

test('grid extraction recovers only safe pasted decimals as exact text', () => {
  const { model, snapshot } = expenseFixture();
  const amount = model.entities[0].fields.find((field) => field.id === 'amount');
  amount.type = 'decimal';
  amount.scale = 2;
  snapshot.sheets.sheet.cellData[2][2].v = 11.25;
  assert.equal(extractBusinessRecord(model, snapshot, { coerceGridDecimals: true }).values.amount, '11.25');
  snapshot.sheets.sheet.cellData[2][2].v = 12.5;
  assert.equal(extractBusinessRecord(model, snapshot, { coerceGridDecimals: true }).values.amount, '12.50');
  snapshot.sheets.sheet.cellData[2][2].v = 9007199254740991;
  assert.throws(() => extractBusinessRecord(model, snapshot, { coerceGridDecimals: true }), /文本传递/);
});

test('invalid structure and unsafe bindings are rejected', () => {
  const cases = [
    (m) => { m.schemaVersion = 2; },
    (m) => { m.entities[0].id = '__proto__'; },
    (m) => { m.entities[1].fields[0].targetEntityId = 'missing'; },
    (m) => { m.entities[1].fields.push(m.entities[1].fields[0]); },
    (m) => { m.document.fields[0].sheetId = 'missing'; },
    (m) => { m.document.fields[0].sheetId = 'constructor'; },
    (m) => { m.document.fields[0].cell = 'I2'; },
    (m) => { m.document.fields[0].cell = 'B1'; },
    (m) => { m.document.fields[0].cell = 'C6'; },
    (m) => { m.document.fields[0].cell = 'B3'; },
    (m) => { m.document.fields.pop(); },
    (m) => { m.document.details[0].parentFieldId = 'name'; },
    (m) => { m.document.details[0].columns[0].fieldId = 'order_id'; },
    (m) => { m.document.details[0].rowCount = 1001; },
    (m) => { m.document.details[0].columns[0].column = 'B'; },
    (m, s) => { delete s.sheets.form.rowCount; },
  ];
  for (const change of cases) {
    const { model, snapshot } = orderFixture();
    change(model, snapshot);
    assert.equal(validateBusinessModel(model, snapshot).valid, false, change.toString());
    assert.throws(() => extractBusinessRecord(model, snapshot), { statusCode: 422 });
  }
});

test('typed values reject invalid dates, missing required values and partial detail rows', () => {
  for (const value of ['2026-02-30', 46268, '2026/09/03']) {
    const { model, snapshot } = orderFixture();
    snapshot.sheets.form.cellData[2][1].v = value;
    assert.throws(() => extractBusinessRecord(model, snapshot), { statusCode: 422 });
  }
  for (const value of ['', ' ', false, '1e3', 'NaN', Number.POSITIVE_INFINITY]) {
    const { model, snapshot } = orderFixture();
    snapshot.sheets.form.cellData[5][1].v = value;
    assert.throws(() => extractBusinessRecord(model, snapshot), { statusCode: 422 });
  }
  const { model, snapshot } = expenseFixture();
  snapshot.sheets.sheet.cellData[1][2].v = '未知';
  assert.throws(() => extractBusinessRecord(model, snapshot), { statusCode: 422 });
  snapshot.sheets.sheet.cellData[1][2].v = '材料';
  snapshot.sheets.sheet.cellData[3][2].v = 'false';
  assert.throws(() => extractBusinessRecord(model, snapshot), { statusCode: 422 });
});

test('hydration rejects wrong entities and detail overflow', () => {
  const { model, snapshot } = orderFixture();
  const record = extractBusinessRecord(model, snapshot);
  assert.throws(() => hydrateBusinessRecord(model, snapshot, { ...record, entityId: 'other' }), { statusCode: 422 });
  record.details.items = Array(4).fill(record.details.items[0]);
  assert.throws(() => hydrateBusinessRecord(model, snapshot, record), { statusCode: 422 });
});

test('diffModelSchema ignores safe changes and reports breaking ones', () => {
  const { model } = orderFixture();
  assert.deepEqual(diffModelSchema(null, model), { breaking: [] });
  const clone = (m) => structuredClone(m);
  // Safe: new entity, new field, label edit, relaxing required, extending options.
  const safe = clone(model);
  safe.entities.push({ id: 'warehouse', label: '仓库', fields: [{ id: 'name', label: '名称', type: 'text', required: true }] });
  safe.entities[0].fields.push({ id: 'contact', label: '联系人', type: 'text', required: false });
  safe.entities[0].fields[0].label = '供应商名称';
  safe.entities[1].fields[1].required = false;
  assert.deepEqual(diffModelSchema(model, safe), { breaking: [] });

  // Breaking: entity removal, field removal, type change, scale change, target change.
  const removedEntity = clone(model); removedEntity.entities.splice(2, 1);
  assert.deepEqual(diffModelSchema(model, removedEntity).breaking.map((i) => i.path), ['entities.item']);
  const removedField = clone(model); removedField.entities[1].fields.splice(1, 1);
  assert.deepEqual(diffModelSchema(model, removedField).breaking.map((i) => i.path), ['order.date']);
  const typeChanged = clone(model); typeChanged.entities[1].fields[1].type = 'text';
  assert.deepEqual(diffModelSchema(model, typeChanged).breaking.map((i) => i.path), ['order.date']);

  const decimalModel = { schemaVersion: 1, entities: [{ id: 'money', label: '金额表', fields: [{ id: 'amount', label: '金额', type: 'decimal', scale: 2, required: false }] }], document: { entityId: 'money', fields: [{ fieldId: 'amount', sheetId: 's', cell: 'A1' }], details: [] } };
  const scaleChanged = structuredClone(decimalModel); scaleChanged.entities[0].fields[0].scale = 4;
  assert.deepEqual(diffModelSchema(decimalModel, scaleChanged).breaking.map((i) => i.path), ['money.amount']);

  const refModel = { schemaVersion: 1, entities: [{ id: 'a', label: 'A', fields: [{ id: 'n', label: 'N', type: 'text', required: false }] }, { id: 'b', label: 'B', fields: [{ id: 'r', label: 'R', type: 'reference', targetEntityId: 'a', required: false }] }], document: { entityId: 'b', fields: [{ fieldId: 'r', sheetId: 's', cell: 'A1' }], details: [] } };
  const targetChanged = structuredClone(refModel); targetChanged.entities[1].fields[0].targetEntityId = 'b';
  assert.deepEqual(diffModelSchema(refModel, targetChanged).breaking.map((i) => i.path), ['b.r']);

  // choice shrink and required tighten.
  const choiceModel = { schemaVersion: 1, entities: [{ id: 'e', label: 'E', fields: [{ id: 'c', label: 'C', type: 'choice', options: ['甲', '乙'], required: false }] }], document: { entityId: 'e', fields: [{ fieldId: 'c', sheetId: 's', cell: 'A1' }], details: [] } };
  const shrunk = structuredClone(choiceModel); shrunk.entities[0].fields[0].options = ['甲'];
  assert.deepEqual(diffModelSchema(choiceModel, shrunk).breaking.map((i) => i.path), ['e.c']);
  const extended = structuredClone(choiceModel); extended.entities[0].fields[0].options = ['甲', '乙', '丙'];
  assert.deepEqual(diffModelSchema(choiceModel, extended), { breaking: [] });
  const tightened = structuredClone(choiceModel); tightened.entities[0].fields[0].required = true;
  assert.deepEqual(diffModelSchema(choiceModel, tightened).breaking.map((i) => i.path), ['e.c']);

  // data space change isolates history.
  const spaceChanged = clone(model); spaceChanged.dataSpaceId = 'other_space';
  assert.deepEqual(diffModelSchema(model, spaceChanged).breaking.map((i) => i.path), ['dataSpaceId']);
});

test('grid date serials normalize to calendar text without timezone drift', () => {
  const { model, snapshot } = orderFixture();
  const serial = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
  const typed = structuredClone(snapshot);
  typed.sheets.form.cellData[2][1].v = serial('2026-09-03');
  assert.equal(extractBusinessRecord(model, typed, { coerceGridDecimals: true }).values.date, '2026-09-03');
  // Plain text keeps working, the Excel 1900 leap-year bug is handled, non-dates are untouched.
  assert.equal(extractBusinessRecord(model, snapshot, { coerceGridDecimals: true }).values.date, '2026-09-03');
  assert.equal(exactGridDate(60, { type: 'date' }), '1900-02-28');
  assert.equal(exactGridDate(61, { type: 'date' }), '1900-03-01');
  assert.equal(exactGridDate('2026-09-03', { type: 'date' }), '2026-09-03');
  assert.equal(exactGridDate(46274, { type: 'text' }), 46274);
  // Out-of-range and fractional serials are left to the strict validator instead of being guessed.
  assert.equal(exactGridDate(0, { type: 'date' }), 0);
  assert.equal(exactGridDate(46274.5, { type: 'date' }), 46274.5);
});

test('recordScope, field defaults and lookup filters are validated against the contract', () => {
  const { model, snapshot } = orderFixture();
  const check = (change) => { const m = structuredClone(model); change(m); return validateBusinessModel(m, snapshot); };

  // recordScope accepts the two documented values only.
  assert.deepEqual(check((m) => { m.recordScope = 'all'; }), { valid: true, issues: [] });
  assert.deepEqual(check((m) => { delete m.recordScope; }), { valid: true, issues: [] });
  assert.ok(check((m) => { m.recordScope = 'department'; }).issues.some((i) => i.path === 'recordScope'));

  // Defaults must type-check against the field; a valid default passes.
  const withDefaults = check((m) => {
    m.entities[0].fields[0].defaultValue = '供应商甲';
    m.entities[1].fields[1].defaultValue = '2026-09-09';
  });
  assert.deepEqual(withDefaults, { valid: true, issues: [] });
  assert.ok(check((m) => { m.entities[0].fields[0].defaultValue = 123; }).issues.some((i) => i.path.endsWith('.defaultValue')));
  assert.ok(check((m) => { m.entities[1].fields[1].defaultValue = '2026-13-99'; }).issues.some((i) => i.path.endsWith('.defaultValue')));

  // Lookup filters must point at a real target field with a value.
  const base = structuredClone(model);
  base.rules = { lookups: [{ id: 'lk', entityId: 'order', referenceFieldId: 'supplier_id', targetFieldId: 'name', destinationFieldId: 'date', strategy: 'snapshot' }], calculations: [], aggregates: [] };
  const rules = (change) => { const m = structuredClone(base); change(m); return validateBusinessModel(m, snapshot); };
  assert.deepEqual(rules(() => {}), { valid: true, issues: [] });
  assert.ok(rules((m) => { m.rules.lookups[0].filterFieldId = 'name'; }).issues.some((i) => i.path === 'rules.lookups[0]'));
  assert.deepEqual(rules((m) => { m.rules.lookups[0].filterFieldId = 'name'; m.rules.lookups[0].filterValue = '供应商甲'; }), { valid: true, issues: [] });
});

test('field states and workbook formulas have an explicit publish-time contract', () => {
  const { model, snapshot } = orderFixture();
  model.fieldPolicies = [
    { entityId: 'order', fieldId: 'date', role: 'editor', state: 'required' },
    { entityId: 'order', fieldId: 'supplier_id', role: 'viewer', state: 'hidden' },
  ];
  assert.deepEqual(validateBusinessModel(model, snapshot), { valid: true, issues: [] });
  assert.equal(fieldState(model, 'order', 'date', 'editor'), 'required');
  assert.equal(fieldState(model, 'order', 'supplier_id', 'viewer'), 'hidden');
  assert.equal(fieldState(model, 'order', 'date', 'viewer'), 'read');
  assert.equal(fieldState(model, 'order', 'date', 'admin'), 'edit');

  for (const invalid of [
    { entityId: 'missing', fieldId: 'date', role: 'editor', state: 'read' },
    { entityId: 'order', fieldId: 'date', role: 'viewer', state: 'edit' },
    { entityId: 'order', fieldId: 'date', role: 'editor', state: 'unknown' },
  ]) {
    const changed = structuredClone(model); changed.fieldPolicies = [invalid];
    assert.ok(validateBusinessModel(changed, snapshot).issues.some((item) => item.path === 'fieldPolicies[0]'));
  }
  const duplicate = structuredClone(model); duplicate.fieldPolicies.push(structuredClone(duplicate.fieldPolicies[0]));
  assert.ok(validateBusinessModel(duplicate, snapshot).issues.some((item) => item.path === 'fieldPolicies[2]'));

  snapshot.sheets.form.cellData[0][3] = { f: '=SUM(B2:B4)' };
  let compatibility = inspectWorkbookFormulas(snapshot);
  assert.equal(compatibility.unsupported, 0);
  snapshot.sheets.form.cellData[0][4] = { f: '=UNSUPPORTED(B2)' };
  compatibility = inspectWorkbookFormulas(snapshot);
  assert.equal(compatibility.unsupported, 1);
  assert.match(compatibility.formulas.find((item) => !item.supported).reasons[0], /UNSUPPORTED/);
  assert.ok(validateBusinessModel(model, snapshot).issues.some((item) => item.path === 'formulas.form!E1'));
  snapshot.sheets.form.cellData[0][4] = { f: "='[external.xlsx]Sheet1'!A1" };
  assert.ok(validateBusinessModel(model, snapshot).issues.some((item) => item.message.includes('外部工作簿')));
});
