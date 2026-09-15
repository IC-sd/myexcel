import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import * as XLSX from 'xlsx';
import { createDefaultSnapshot, importXlsxWorkbook, snapshotToXlsx, xlsxToSnapshot } from '../server/workbook-codec.mjs';

test('default snapshot contains multi-sheet formulas', () => {
  const snapshot = createDefaultSnapshot();
  assert.deepEqual(snapshot.sheetOrder, ['orders', 'summary']);
  assert.equal(snapshot.sheets.orders.cellData[1][4].f, '=C2*D2');
  assert.match(snapshot.sheets.summary.cellData[2][1].f, /SUM/);
});

test('xlsx round trip preserves sheets, values and formulas', () => {
  const source = createDefaultSnapshot('往返测试');
  const buffer = snapshotToXlsx(source);
  assert.ok(buffer.length > 1000);

  const imported = xlsxToSnapshot(buffer, '重新导入');
  assert.deepEqual(imported.sheetOrder, ['sheet-1', 'sheet-2']);
  assert.equal(imported.sheets['sheet-1'].name, '记录数据');
  assert.equal(imported.sheets['sheet-1'].cellData[1][0].v, 'R001');
  assert.equal(imported.sheets['sheet-1'].cellData[1][4].f, '=C2*D2');
  assert.equal(imported.sheets['sheet-2'].cellData[2][1].f, "=SUM('记录数据'!C2:C100)");
});

test('export tolerates cleared cells and rows while preserving remaining values', () => {
  const source = createDefaultSnapshot();
  source.sheets.orders.cellData[1][0] = null;
  source.sheets.orders.cellData[2] = null;
  source.sheets.orders.cellData[3][0] = { v: null };
  const result = xlsxToSnapshot(snapshotToXlsx(source)).sheets['sheet-1'];
  assert.equal(result.cellData[1][0], undefined);
  assert.equal(result.cellData[2], undefined);
  assert.equal(result.cellData[3][0], undefined);
  assert.equal(result.cellData[1][4].f, '=C2*D2');
  assert.equal(result.cellData[3][2].v, 28);
});

test('sparse full-range XLSX import completes within a bounded worker', async () => {
  // Write a small file first; expanding its XML avoids the XLSX writer itself
  // traversing the full declared grid. No files or existing business data used.
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['start']]), 'Sparse');
  const zip = XLSX.CFB.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const entry = XLSX.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  const xml = Buffer.from(entry.content).toString('utf8')
    .replace(/<dimension[^>]*\/>/, '<dimension ref="A1:XFD1048576"/>')
    .replace('</sheetData>', '<row r="1048576"><c r="XFD1048576" t="n"><v>42</v></c></row></sheetData>');
  XLSX.CFB.utils.cfb_add(zip, '/xl/worksheets/sheet1.xml', Buffer.from(xml));
  const buffer = XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' });
  const source = `import { parentPort, workerData } from 'node:worker_threads';
    import { xlsxToSnapshot } from ${JSON.stringify(new URL('../server/workbook-codec.mjs', import.meta.url).href)};
    parentPort.postMessage(xlsxToSnapshot(Buffer.from(workerData)));`;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { workerData: buffer });
  let timer;
  try {
    const imported = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('sparse import exceeded 3 seconds')), 3000);
      worker.once('message', resolve); worker.once('error', reject);
    });
    const sheet = imported.sheets['sheet-1'];
    assert.equal(sheet.rowCount, 1048576);
    assert.equal(sheet.columnCount, 16384);
    assert.equal(Object.keys(sheet.cellData).length, 2);
    assert.equal(sheet.cellData[1048575][16383].v, 42);
  } finally { clearTimeout(timer); await worker.terminate(); }
});

test('import retains parsed date and boolean values', () => {
  const date = new Date('2026-09-03T00:00:00Z');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[date, true]], { cellDates: true }), 'Types');
  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const parsed = XLSX.read(buffer, { type: 'buffer', cellDates: true }).Sheets.Types.A1.v;
  const imported = xlsxToSnapshot(buffer);
  // Characterize existing parser semantics, not Excel/time-zone fidelity.
  assert.equal(imported.sheets['sheet-1'].cellData[0][0].v, parsed.toISOString());
  assert.equal(imported.sheets['sheet-1'].cellData[0][1].v, true);
});

test('XLSX import report declares preserved formulas and explicit downgrade warnings', () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([[1, 2, null], [3, 4, null]]);
  sheet.C1 = { f: 'SUM(A1:B2)' };
  sheet.C2 = { f: 'UNSUPPORTED(A1)' };
  sheet['!ref'] = 'A1:C2';
  sheet['!merges'] = [XLSX.utils.decode_range('A1:A2')];
  sheet['!autofilter'] = { ref: 'A1:C2' };
  XLSX.utils.book_append_sheet(book, sheet, '兼容性');
  const result = importXlsxWorkbook(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(result.report.summary.formulas, 2);
  assert.equal(result.report.summary.supportedFormulas, 1);
  assert.equal(result.report.summary.unsupportedFormulas, 1);
  assert.equal(result.report.features.find((item) => item.id === 'merges').status, 'dropped');
  assert.equal(result.report.features.find((item) => item.id === 'filters').status, 'dropped');
  assert.ok(result.report.warnings.some((item) => item.includes('UNSUPPORTED')));
  assert.equal(result.snapshot.sheets['sheet-1'].cellData[0][2].f, '=SUM(A1:B2)');
});
