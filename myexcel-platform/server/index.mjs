import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from './app.mjs';
import { createBusinessPool, mysqlConfig } from './business/mysql.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = process.env.MYEXCEL_DATA_DIR ? resolve(process.env.MYEXCEL_DATA_DIR) : join(root, 'data');
const staticDirectory = existsSync(join(root, 'dist')) ? join(root, 'dist') : null;
const port = Number(process.env.MYEXCEL_PORT || 8091);
const host = process.env.MYEXCEL_HOST || '127.0.0.1';

const config = mysqlConfig();
const businessPool = config ? createBusinessPool(config) : null;
if (businessPool) {
  try { await businessPool.query('SELECT id FROM mx_migrations LIMIT 1'); }
  catch (error) { await businessPool.end(); throw new Error(`MySQL 业务库不可用或未迁移（${error.code || 'unknown'}）；请先检查配置并执行 migrate-business.mjs`); }
}
const app = createApplication({ databasePath: join(dataDirectory, 'myexcel.db'), staticDirectory, businessPool });
app.server.listen(port, host, () => {
  console.log(`Sheet application API running at http://${host}:${port}`);
  if (!staticDirectory) console.log('未检测到 dist；开发前端请运行 npm run dev:web');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    if (businessPool) await businessPool.end();
    process.exit(0);
  });
}
