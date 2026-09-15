import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBusinessPool } from '../server/business/mysql.mjs';
import { BusinessRecords } from '../server/business/records.mjs';
import { backupBusiness, restoreBusinessToNewDatabase } from '../scripts/business-backup.mjs';
import { expenseFixture } from './fixtures/business-model.mjs';
import { mysqlEnabled, mysqlContext } from './fixtures/mysql-context.mjs';

test('mysql logical backup restores records, releases, relations schema and audit into a new database only', { skip: !mysqlEnabled }, async () => {
  const c = await mysqlContext();
  const directory = mkdtempSync(join(tmpdir(), 'sheetapp-backup-test-'));
  const output = join(directory, 'records.sql');
  const targetDatabase = `sheetapp_test_${randomUUID().replaceAll('-', '')}`;
  const mysqlBin = process.env.MYEXCEL_MYSQL_TEST_BIN || 'D:/myexcel-runtime/mysql/mysql-8.4.11-winx64/bin';
  let restoredPool; let targetCreated = false;
  try {
    const { model, snapshot } = expenseFixture();
    const records = new BusinessRecords(c.pool);
    const actor = { id: 'backup-owner', role: 'editor' };
    const saved = await records.save({ release: { id: randomUUID(), version: 1, name: '恢复合成样本', snapshot, templateConfig: { businessModel: model } }, actor, templateAllowed: () => true,
      requestId: randomUUID(), input: { entityId: 'expense', values: { category: '交通', amount: 25, receipt: false }, details: {} } });
    const config = { ...c.config, database: c.name };
    const metadata = await backupBusiness({ config, mysqlBin, output });
    assert.equal(metadata.migrations.length, 2);
    assert.equal(metadata.sha256.length, 64);
    await assert.rejects(backupBusiness({ config, mysqlBin, output }), /拒绝覆盖/);
    await assert.rejects(restoreBusinessToNewDatabase({ config, mysqlBin, input: output, targetDatabase: c.name }), /拒绝覆盖/);
    await restoreBusinessToNewDatabase({ config, mysqlBin, input: output, targetDatabase }); targetCreated = true;
    restoredPool = createBusinessPool({ ...config, database: targetDatabase });
    const loaded = await new BusinessRecords(restoredPool).get(saved.record.id, actor, () => true);
    assert.deepEqual(loaded.record, saved.record);
    assert.deepEqual(loaded.release, saved.release);
    const [[audit]] = await restoredPool.query('SELECT COUNT(*) AS n FROM mx_audit'); assert.equal(audit.n, 1);
    writeFileSync(output, readFileSync(output, 'utf8') + '\n-- changed');
    await assert.rejects(restoreBusinessToNewDatabase({ config, mysqlBin, input: output, targetDatabase: 'sheetapp_test_should_not_create' }), /校验失败/);
  } finally {
    if (restoredPool) await restoredPool.end();
    if (targetCreated && /^sheetapp_test_[0-9a-f]{32}$/.test(targetDatabase)) await c.admin.query(`DROP DATABASE \`${targetDatabase}\``);
    await c.close();
    rmSync(directory, { recursive: true, force: true }); // Unique directory created by this test only.
  }
});
