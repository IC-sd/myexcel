import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { createBusinessPool, migrateBusinessDatabase } from '../../server/business/mysql.mjs';

export const mysqlEnabled = process.env.MYEXCEL_MYSQL_TEST === '1';
export async function mysqlContext() {
  if (!mysqlEnabled) throw new Error('MySQL 集成测试必须显式启用');
  const config = { host: '127.0.0.1', port: Number(process.env.MYEXCEL_MYSQL_TEST_PORT || 13307), user: 'root', password: process.env.MYEXCEL_MYSQL_TEST_PASSWORD || '' };
  const admin = await mysql.createConnection(config);
  const [[server]] = await admin.query('SELECT @@datadir AS directory, @@port AS port');
  if (!/[\\/]mysql-demo-data[\\/]?$/.test(server.directory) || server.port === 3306) { await admin.end(); throw new Error('拒绝在非隔离测试实例中创建/删除测试库'); }
  const name = `sheetapp_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  const pool = createBusinessPool({ ...config, database: name });
  try { await migrateBusinessDatabase(pool); }
  catch (error) { await pool.end(); await admin.query(`DROP DATABASE \`${name}\``); await admin.end(); throw error; }
  return { pool, name, config, admin, async close() {
    await pool.end();
    // name was generated here, never taken from an environment variable.
    if (!/^sheetapp_test_[0-9a-f]{32}$/.test(name)) throw new Error('拒绝删除非本次生成的测试库');
    await admin.query(`DROP DATABASE \`${name}\``); await admin.end();
  } };
}
