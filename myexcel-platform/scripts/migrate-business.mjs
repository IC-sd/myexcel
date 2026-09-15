import { createBusinessPool, migrateBusinessDatabase, mysqlConfig } from '../server/business/mysql.mjs';

const config = mysqlConfig();
if (!config) throw new Error('未指定 MYEXCEL_MYSQL_DATABASE；不会默认连接或修改任何数据库');
const pool = createBusinessPool(config);
try { await migrateBusinessDatabase(pool); console.log(`BUSINESS_MIGRATION_OK ${config.database}`); }
finally { await pool.end(); }
