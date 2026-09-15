export function orderFixture() {
  const model = {
    schemaVersion: 1,
    entities: [
      { id: 'supplier', label: '供应商', fields: [{ id: 'name', label: '名称', type: 'text', required: true }] },
      { id: 'order', label: '采购单', fields: [
        { id: 'supplier_id', label: '供应商标识', type: 'reference', required: true, targetEntityId: 'supplier' },
        { id: 'date', label: '日期', type: 'date', required: true },
      ] },
      { id: 'item', label: '采购明细', fields: [
        { id: 'order_id', label: '所属订单', type: 'reference', required: true, targetEntityId: 'order' },
        { id: 'name', label: '物料', type: 'text', required: true },
        { id: 'quantity', label: '数量', type: 'number', required: true },
      ] },
    ],
    document: {
      entityId: 'order',
      fields: [{ fieldId: 'supplier_id', sheetId: 'form', cell: 'B2' }, { fieldId: 'date', sheetId: 'form', cell: 'B3' }],
      details: [{ id: 'items', entityId: 'item', parentFieldId: 'order_id', sheetId: 'form', startRow: 6, rowCount: 3,
        columns: [{ fieldId: 'name', column: 'A' }, { fieldId: 'quantity', column: 'B' }] }],
    },
  };
  const snapshot = { id: 'test', sheetOrder: ['form'], sheets: { form: { id: 'form', name: '采购单', rowCount: 30, columnCount: 8,
    mergeData: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 3 }],
    cellData: {
      0: { 0: { v: '采购单' } },
      1: { 1: { v: 'supplier-001', s: 'input-style' } },
      2: { 1: { v: '2026-09-03' } },
      5: { 0: { v: '测试物料' }, 1: { v: '2.5' }, 2: { f: '=B6*10', v: 25 } },
    },
  } } };
  return { model, snapshot };
}

export function expenseFixture() {
  return {
    model: { schemaVersion: 1, entities: [{ id: 'expense', label: '费用登记', fields: [
      { id: 'category', label: '类别', type: 'choice', required: true, options: ['交通', '材料'] },
      { id: 'amount', label: '金额', type: 'number', required: true },
      { id: 'receipt', label: '已收票', type: 'boolean', required: false },
    ] }], document: { entityId: 'expense', fields: [
      { fieldId: 'category', sheetId: 'sheet', cell: 'C2' },
      { fieldId: 'amount', sheetId: 'sheet', cell: 'C3' },
      { fieldId: 'receipt', sheetId: 'sheet', cell: 'C4' },
    ], details: [] } },
    snapshot: { sheets: { sheet: { name: '费用登记', rowCount: 20, columnCount: 5, cellData: {
      1: { 2: { v: '交通' } }, 2: { 2: { v: 0 } }, 3: { 2: { v: false } },
    } } } },
  };
}
