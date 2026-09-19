import { randomUUID } from 'node:crypto';

export function demoDefinitions() {
  const entities = [
    { id: 'contact', label: '联系人目录', fields: [{ id: 'name', label: '名称', type: 'text', required: true }, { id: 'contact', label: '联系方式', type: 'text', required: false }, { id: 'status_note', label: '状态回写说明', type: 'text', required: false }] },
    { id: 'catalog_item', label: '目录条目', fields: [{ id: 'name', label: '条目名称', type: 'text', required: true }, { id: 'code', label: '条目编码', type: 'text', required: false }, { id: 'reference_value', label: '参考值', type: 'decimal', scale: 2, required: true }] },
    { id: 'request', label: '通用申请单', fields: [{ id: 'number', label: '申请编号', type: 'text', required: true }, { id: 'date', label: '申请日期', type: 'date', required: true }, { id: 'contact_id', label: '关联联系人', type: 'reference', required: true, targetEntityId: 'contact' }, { id: 'contact_snapshot', label: '联系方式快照', type: 'text', required: false }, { id: 'total_quantity', label: '合计数量', type: 'number', required: false }] },
    { id: 'request_item', label: '申请明细', fields: [{ id: 'request_id', label: '所属申请', type: 'reference', required: true, targetEntityId: 'request' }, { id: 'catalog_item_id', label: '目录条目', type: 'reference', required: true, targetEntityId: 'catalog_item' }, { id: 'quantity', label: '数量', type: 'number', required: true }, { id: 'confirmed_value', label: '本次确认值', type: 'decimal', scale: 2, required: true }] },
  ];
  return entities.slice(0, 3).map((entity) => {
    const details = entity.id === 'request' ? [{ id: 'items', entityId: 'request_item', parentFieldId: 'request_id', sheetId: 'form', startRow: 12, rowCount: 20,
      columns: [{ fieldId: 'catalog_item_id', column: 'A' }, { fieldId: 'quantity', column: 'B' }, { fieldId: 'confirmed_value', column: 'C' }] }] : [];
    const rules = entity.id === 'request' ? {
      lookups: [
        { id: 'contact_details', entityId: 'request', referenceFieldId: 'contact_id', targetFieldId: 'contact', destinationFieldId: 'contact_snapshot', strategy: 'snapshot' },
        { id: 'catalog_value', entityId: 'request_item', referenceFieldId: 'catalog_item_id', targetFieldId: 'reference_value', destinationFieldId: 'confirmed_value', strategy: 'snapshot' },
      ],
      calculations: [{ id: 'total_quantity', operation: 'sum', detailId: 'items', sourceFieldId: 'quantity', destinationFieldId: 'total_quantity' }],
      aggregates: [{ id: 'quantity_by_contact', label: '按联系人汇总申请数量', entityId: 'request', operation: 'sum', fieldId: 'total_quantity', groupByFieldId: 'contact_id' }],
      workflow: { initialState: 'draft', states: ['draft', 'submitted', 'approved', 'returned'], transitions: [
        { id: 'submit', label: '提交', from: 'draft', to: 'submitted', roles: ['admin', 'editor'] },
        { id: 'approve', label: '通过', from: 'submitted', to: 'approved', roles: ['admin'], writeback: { referenceFieldId: 'contact_id', targetFieldId: 'status_note', value: '最近申请已确认' } },
        { id: 'return', label: '退回', from: 'submitted', to: 'returned', roles: ['admin'] },
      ] },
    } : { lookups: [], calculations: [], aggregates: [] };
    const model = { schemaVersion: 1, dataSpaceId: 'generic_relation_demo', entities: structuredClone(entities), document: { entityId: entity.id,
      fields: entity.fields.map((field, index) => ({ fieldId: field.id, sheetId: 'form', cell: `B${index + 3}` })), details }, rules };
    const cells = { 0: { 0: { v: `${entity.label}（完全合成）` } }, 1: { 0: { v: '模板仅负责版式，填写内容独立保存在记录存储中' } } };
    entity.fields.forEach((field, index) => { cells[index + 2] = { 0: { v: field.label } }; });
    if (details.length) cells[10] = { 0: { v: '目录条目记录 ID' }, 1: { v: '数量' }, 2: { v: '本次确认值' } };
    const snapshot = { id: `wb-${randomUUID()}`, name: entity.label, appVersion: '0.1.0', locale: 'zhCN', sheetOrder: ['form'], sheets: { form: { id: 'form', name: entity.label, rowCount: 60, columnCount: 12, cellData: cells } } };
    return { key: entity.id, name: `${entity.label} · 通用示例`, model, snapshot };
  });
}

export async function seedDemo({ store, records }) {
  const admin = store.listUsers().find((user) => user.username === 'admin');
  const definitions = demoDefinitions(), templates = {};
  for (const definition of definitions) {
    const marker = `builtin:generic-demo:${definition.key}:v1`;
    const existing = store.listWorkbooks().find((book) => book.description === marker);
    if (existing) {
      templates[definition.key] = store.getPublishedWorkbook(existing.id);
      if (!templates[definition.key]) throw new Error('已有内置示例尚未发布；为保护修改内容，启动过程不会自动覆盖');
      continue;
    }
    const book = store.createWorkbook({ name: definition.name, description: marker, snapshot: definition.snapshot, userId: admin.id });
    store.saveDesign({ id: book.id, templateConfig: { businessModel: definition.model }, dataSourceConfig: { type: 'static', name: '完全合成数据' }, userId: admin.id, expectedVersion: 1 });
    store.publishWorkbook({ id: book.id, userId: admin.id, expectedVersion: 2 });
    templates[definition.key] = store.getPublishedWorkbook(book.id);
  }
  const templateIds = Object.values(templates).map((item) => item.id);
  for (const actor of store.listUsers().filter((user) => ['admin', 'editor'].includes(user.role))) {
    const ensure = async (key, values, details = {}) => {
      const release = templates[key];
      const existing = await records.list({ spaceId: 'generic_relation_demo', entityId: key, templateId: release.id, templateIds, actor: { ...actor, role: 'editor' } });
      if (existing.length) return existing[0];
      return (await records.save({ release, actor, templateAllowed: () => true, requestId: randomUUID(), input: { entityId: key, values, details } })).record;
    };
    const contact = await ensure('contact', { name: '合成联系人 A', contact: '示例联系方式', status_note: null });
    const item = await ensure('catalog_item', { name: '合成目录条目 A', code: 'ITEM-01', reference_value: '12.50' });
    await ensure('request', { number: `DEMO-${actor.username}`, date: '2026-09-16', contact_id: contact.id, contact_snapshot: null, total_quantity: null }, { items: [{ entityId: 'request_item', values: { catalog_item_id: item.id, quantity: 2, confirmed_value: null } }] });
  }
  return templates;
}
