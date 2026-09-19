import { resolve, join } from 'node:path';
import { Store } from '../server/store.mjs';
import { BusinessRecords } from '../server/business/records.mjs';
import { createBusinessPool, migrateBusinessDatabase, mysqlConfig } from '../server/business/mysql.mjs';
import { seedDemo } from '../server/business/demo.mjs';

const config = mysqlConfig();
if (config?.database !== 'sheetapp_demo' || !process.env.MYEXCEL_DATA_DIR || !resolve(process.env.MYEXCEL_DATA_DIR).endsWith('generic-demo-metadata')) throw new Error('演示种子只允许运行在专用 sheetapp_demo 库和 generic-demo-metadata 目录');
const pool = createBusinessPool(config);
const store = new Store(join(resolve(process.env.MYEXCEL_DATA_DIR), 'myexcel.db'));
try {
  await migrateBusinessDatabase(pool);
  const records = new BusinessRecords(pool);
  await seedDemo({ store, records });
  console.log('GENERIC_DEMO_READY: three published templates; owner-scoped synthetic records for admin/editor; existing records preserved.');
} finally { store.close(); await pool.end(); }
