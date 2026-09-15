import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createSyntheticWorkbookBenchmark } from '../server/benchmark.mjs';

test('phase-one synthetic benchmark covers 100, 1,000, 10,000 rows and 200-column width', () => {
  for (const [rows, columns] of [[100, 26], [1000, 26], [10000, 26], [100, 200]]) {
    const startedAt = performance.now();
    const snapshot = createSyntheticWorkbookBenchmark(rows, columns);
    const elapsedMs = performance.now() - startedAt;
    assert.equal(Object.keys(snapshot.sheets.records.cellData).length, rows + 1);
    assert.equal(snapshot.sheets.records.columnCount, columns);
    assert.equal(snapshot.sheets.records.cellData[rows][7].f, `=C${rows + 1}*D${rows + 1}/G${rows + 1}`);
    assert.ok(elapsedMs < 3000, `${rows} rows × ${columns} columns generation took ${elapsedMs.toFixed(1)}ms`);
  }
  assert.ok(JSON.stringify(createSyntheticWorkbookBenchmark(10000)).length > 1_000_000);
});
