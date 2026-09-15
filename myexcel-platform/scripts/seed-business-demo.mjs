import { resolve, join } from 'node:path';
import { Store } from '../server/store.mjs';
import { BusinessRecords } from '../server/business/records.mjs';
import { createBusinessPool, migrateBusinessDatabase, mysqlConfig } from '../server/business/mysql.mjs';
import { demoDefinitions } from '../server/business/demo.mjs';
import { randomUUID } from 'node:crypto';

const config = mysqlConfig();
if (config?.database !== 'sheetapp_demo' || !process.env.MYEXCEL_DATA_DIR || !resolve(process.env.MYEXCEL_DATA_DIR).endsWith('generic-demo-metadata')) throw new Error('演示种子只允许运行在专用 sheetapp_demo 库和 generic-demo-metadata 目录');
const pool = createBusinessPool(config);
const store = new Store(join(resolve(process.env.MYEXCEL_DATA_DIR), 'myexcel.db'));
try {
  await migrateBusinessDatabase(pool);
  const admin = store.listUsers().find((user) => user.username === 'admin');
  const definitions = demoDefinitions();
  const templates = {};
  for (const definition of definitions) {
    const marker = `builtin:generic-demo:${definition.key}:v1`;
    const existing = store.listWorkbooks().find((book) => book.description === marker);
    if (existing) { templates[definition.key] = store.getPublishedWorkbook(existing.id); if (!templates[definition.key]) throw new Error('已有演示模板尚未发布，保留其内容，请先确认后处理'); continue; }
    const book = store.createWorkbook({ name: definition.name, description: marker, snapshot: definition.snapshot, userId: admin.id });
    store.saveDesign({ id: book.id, templateConfig: { businessModel: definition.model }, dataSourceConfig: { type: 'static', name: '完全合成数据' }, userId: admin.id, expectedVersion: 1 });
    store.publishWorkbook({ id: book.id, userId: admin.id, expectedVersion: 2 });
    templates[definition.key] = store.getPublishedWorkbook(book.id);
  }
  const records = new BusinessRecords(pool);
  for (const actor of store.listUsers().filter((user) => ['admin', 'editor'].includes(user.role))) {
    const ensure = async (key, values, details = {}) => {
      const release = templates[key];
      const existing = await records.list({ spaceId: 'generic_relation_demo', entityId: key, templateId: release.id, templateIds: Object.values(templates).map((item) => item.id), actor: { ...actor, role: 'editor' } });
      if (existing.length) return existing[0]; // Never overwrite user-edited demo data.
      return (await records.save({ release, actor, templateAllowed: () => true, requestId: randomUUID(), input: { entityId: key, values, details } })).record;
    };
    const contact = await ensure('contact', { name: '合成联系人 A', contact: '示例联系方式' });
    const item = await ensure('catalog_item', { name: '合成目录条目 A', code: 'ITEM-01', reference_value: '12.50' });
    await ensure('request', { number: `DEMO-${actor.username}`, date: '2026-09-03', contact_id: contact.id }, { items: [{ entityId: 'request_item', values: { catalog_item_id: item.id, quantity: 2 } }] });
  }
  console.log('GENERIC_DEMO_READY: three published templates; owner-scoped synthetic records for admin/editor; existing records preserved.');
} finally { store.close(); await pool.end(); }
