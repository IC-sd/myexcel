import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

export function databaseName(value) {
  if (!/^sheetapp_[a-z0-9_]{1,48}$/.test(value || '')) throw new Error('业务库名称必须使用 sheetapp_ 前缀和小写字母/数字/下划线，禁止连接系统库或既有业务库');
  return value;
}

export function mysqlConfig(env = process.env) {
  if (!env.MYEXCEL_MYSQL_DATABASE) return null;
  const config = { host: env.MYEXCEL_MYSQL_HOST || '127.0.0.1', port: Number(env.MYEXCEL_MYSQL_PORT || 3306),
    user: env.MYEXCEL_MYSQL_USER, password: env.MYEXCEL_MYSQL_PASSWORD || '', database: databaseName(env.MYEXCEL_MYSQL_DATABASE) };
  if (!config.user || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('请配置 MySQL 用户和有效端口');
  if (!config.password && !(config.host === '127.0.0.1' && env.MYEXCEL_MYSQL_ALLOW_EMPTY_PASSWORD === '1')) throw new Error('MySQL 密码未配置；只有显式允许的本机隔离测试可使用空密码');
  return config;
}

export function createBusinessPool(config) {
  databaseName(config.database);
  return mysql.createPool({ ...config, connectionLimit: 5, waitForConnections: true, queueLimit: 20,
    multipleStatements: false, charset: 'utf8mb4_bin', connectTimeout: 5000, supportBigNumbers: true, bigNumberStrings: false });
}

export async function migrateBusinessDatabase(pool) {
  const conn = await pool.getConnection();
  let lock;
  try {
    const [[row]] = await conn.query('SELECT DATABASE() AS name');
    lock = `mx:migrate:${databaseName(row.name)}`;
    const [[acquired]] = await conn.execute('SELECT GET_LOCK(?, 10) AS acquired', [lock]);
    if (Number(acquired.acquired) !== 1) throw new Error('业务库迁移锁繁忙，请稍后重试');
    await conn.query('CREATE TABLE IF NOT EXISTS mx_migrations (id VARCHAR(100) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at VARCHAR(30) NOT NULL) ENGINE=InnoDB');
    const directory = new URL('./migrations/', import.meta.url);
    const files = readdirSync(directory).filter((file) => /^\d{3}-[a-z-]+\.sql$/.test(file)).sort();
    const [applied] = await conn.query('SELECT id, checksum FROM mx_migrations');
    if (applied.some((item) => !files.includes(item.id))) throw new Error('数据库包含当前代码不认识的迁移；不能自动降级');
    for (const file of files) {
      const sql = readFileSync(new URL(file, directory), 'utf8').replace(/\r\n/g, '\n');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.find((item) => item.id === file);
      if (previous) { if (previous.checksum !== checksum) throw new Error(`迁移校验和不一致：${file}`); continue; }
      // MySQL DDL commits implicitly. Every statement is additive/idempotent so a
      // failed initial migration can be retried; never claim DDL rollback here.
      for (const statement of sql.split('-- statement-break').map((s) => s.trim()).filter(Boolean)) {
        try { await conn.query(statement); }
        catch (error) {
          // MySQL DDL commits before the migration ledger write. A retry may
          // therefore see the one additive column from this migration again.
          if (!(error.code === 'ER_DUP_FIELDNAME' && /^ALTER TABLE mx_records ADD COLUMN workflow_state\b/i.test(statement))) throw error;
        }
      }
      await conn.execute('INSERT INTO mx_migrations (id, checksum, applied_at) VALUES (?, ?, ?)', [file, checksum, new Date().toISOString()]);
    }
  } finally {
    if (lock) await conn.execute('SELECT RELEASE_LOCK(?)', [lock]).catch(() => {});
    conn.release();
  }
}
