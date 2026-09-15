import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { databaseName, mysqlConfig } from '../server/business/mysql.mjs';

function nativeClient(executable, args, config, input) {
  return new Promise((done, reject) => {
    // Credentials are never command-line arguments or backup metadata.
    const child = spawn(executable, ['--no-defaults', `--host=${config.host}`, `--port=${config.port}`, `--user=${config.user}`, '--default-character-set=utf8mb4', ...args],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MYSQL_PWD: config.password || '' } });
    let errors = ''; child.stdout.resume(); child.stderr.on('data', (data) => { errors += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? done() : reject(new Error(`数据库工具执行失败（${code}）：${errors.slice(0, 1000)}`)));
    if (input) { const stream = createReadStream(input); stream.on('error', reject); stream.pipe(child.stdin); }
    else child.stdin.end();
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error); });
  });
}
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export async function backupBusiness({ config, mysqlBin, output }) {
  databaseName(config.database);
  output = resolve(output);
  if (existsSync(output) || existsSync(`${output}.json`)) throw new Error('备份目标已存在，拒绝覆盖');
  mkdirSync(dirname(output), { recursive: true });
  const connection = await mysql.createConnection(config);
  let migrations;
  try { [migrations] = await connection.query('SELECT id, checksum FROM mx_migrations ORDER BY id'); }
  finally { await connection.end(); }
  await nativeClient(join(mysqlBin, 'mysqldump.exe'), ['--single-transaction', '--set-gtid-purged=OFF', '--no-tablespaces', '--skip-add-drop-table', `--result-file=${output}`, config.database], config);
  const metadata = { format: 1, database: config.database, createdAt: new Date().toISOString(), sha256: digest(output), migrations };
  writeFileSync(`${output}.json`, JSON.stringify(metadata, null, 2), { flag: 'wx' });
  return metadata;
}

export async function restoreBusinessToNewDatabase({ config, mysqlBin, input, targetDatabase }) {
  databaseName(targetDatabase);
  const metadata = JSON.parse(readFileSync(`${input}.json`, 'utf8'));
  if (metadata.format !== 1 || digest(input) !== metadata.sha256) throw new Error('备份文件校验失败，未开始恢复');
  const admin = await mysql.createConnection({ ...config, database: undefined });
  try {
    const [existing] = await admin.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [targetDatabase]);
    if (existing.length) throw new Error('目标数据库已存在；恢复仅允许新库，拒绝覆盖现有数据');
    await admin.query(`CREATE DATABASE \`${targetDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    try { await nativeClient(join(mysqlBin, 'mysql.exe'), [`--database=${targetDatabase}`], config, input); }
    catch (error) { throw new Error(`恢复失败；保留新建库 ${targetDatabase} 供排查，未切换运行配置。${error.message}`); }
    return { targetDatabase, sha256: metadata.sha256 };
  } finally { await admin.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = mysqlConfig();
  if (!config) throw new Error('未配置业务数据库');
  const mysqlBin = process.env.MYEXCEL_MYSQL_BIN;
  if (!mysqlBin) throw new Error('请指定已安装的 MYEXCEL_MYSQL_BIN 目录');
  const [operation, file, targetDatabase] = process.argv.slice(2);
  if (!file || !['backup', 'restore-new'].includes(operation)) throw new Error('用法：node scripts/business-backup.mjs backup <新文件.sql> 或 restore-new <备份.sql> <新库名>');
  const result = operation === 'backup' ? await backupBusiness({ config, mysqlBin, output: file }) : await restoreBusinessToNewDatabase({ config, mysqlBin, input: file, targetDatabase });
  console.log(JSON.stringify(result));
}
