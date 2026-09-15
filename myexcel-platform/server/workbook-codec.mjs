import * as XLSX from 'xlsx';
import { inspectWorkbookFormulas, SUPPORTED_FORMULA_FUNCTIONS } from '../shared/business-model.mjs';

function safeSheetId(index) {
  return `sheet-${index + 1}`;
}

function inferCellType(value) {
  if (typeof value === 'number') return 'n';
  if (typeof value === 'boolean') return 'b';
  if (value instanceof Date) return 'd';
  return 's';
}

function importReport(book, snapshot) {
  const formulas = inspectWorkbookFormulas(snapshot);
  const sheets = book.SheetNames.map((sheetName) => book.Sheets[sheetName]);
  const count = (property) => sheets.reduce((total, sheet) => total + (sheet[property]?.length || 0), 0);
  const has = (property) => sheets.some((sheet) => sheet[property]);
  const features = [
    { id: 'cells', label: '工作表、单元格值与基础类型', status: 'retained', detail: `已导入 ${sheets.length} 个工作表` },
    { id: 'formulas', label: '单元格公式', status: formulas.unsupported ? 'partial' : 'retained', detail: formulas.formulas.length ? `${formulas.supported} 个可用，${formulas.unsupported} 个需处理` : '未发现公式' },
    { id: 'merges', label: '合并单元格', status: count('!merges') ? 'dropped' : 'absent', detail: count('!merges') ? `发现 ${count('!merges')} 处；当前导入不保留合并版式` : '未发现' },
    { id: 'filters', label: '自动筛选、冻结与隐藏行列', status: has('!autofilter') || has('!freeze') || has('!rows') || has('!cols') ? 'dropped' : 'absent', detail: has('!autofilter') || has('!freeze') || has('!rows') || has('!cols') ? '当前导入不保留这些显示设置' : '未发现' },
    { id: 'styles', label: '单元格样式、条件格式与数据验证', status: 'dropped', detail: '当前仅保留值和公式，不承诺样式、条件格式或验证规则' },
    { id: 'advanced', label: '图表、透视表、命名区域、宏与打印设置', status: 'dropped', detail: '当前不导入；请保留原文件作为版式和高级功能来源' },
  ];
  const warnings = [
    ...formulas.formulas.filter((formula) => !formula.supported).map((formula) => `${formula.sheetId}!${formula.address}：${formula.reasons.join('；')}`),
    ...features.filter((feature) => feature.status === 'dropped').map((feature) => `${feature.label}：${feature.detail}`),
  ];
  return {
    format: 'xlsx',
    summary: { sheets: sheets.length, formulas: formulas.formulas.length, supportedFormulas: formulas.supported, unsupportedFormulas: formulas.unsupported },
    supportedFunctions: SUPPORTED_FORMULA_FUNCTIONS,
    formulas: formulas.formulas,
    features,
    warnings,
  };
}

export function importXlsxWorkbook(buffer, workbookName = '导入的工作簿') {
  const book = XLSX.read(buffer, {
    type: 'buffer',
    cellFormula: true,
    cellStyles: true,
    cellDates: true,
  });

  const sheets = {};
  const sheetOrder = [];

  book.SheetNames.forEach((sheetName, sheetIndex) => {
    const source = book.Sheets[sheetName];
    const id = safeSheetId(sheetIndex);
    const range = source['!ref'] ? XLSX.utils.decode_range(source['!ref']) : { s: { r: 0, c: 0 }, e: { r: 99, c: 25 } };
    const cellData = {};

    // A sparse worksheet can declare the full Excel grid in !ref.
    // Visit stored cells only, while retaining the declared dimensions.
    for (const [address, cell] of Object.entries(source)) {
      if (!cell || !/^[A-Z]+[1-9]\d*$/.test(address)) continue;
      const { r: row, c: column } = XLSX.utils.decode_cell(address);
      if (row < range.s.r || row > range.e.r || column < range.s.c || column > range.e.c) continue;
      cellData[row] ??= {};
      const target = {};
      if (cell.v !== undefined) target.v = cell.v instanceof Date ? cell.v.toISOString() : cell.v;
      if (cell.f) target.f = `=${cell.f}`;
      cellData[row][column] = target;
    }

    sheets[id] = {
      id,
      name: sheetName,
      rowCount: Math.max(range.e.r + 1, 100),
      columnCount: Math.max(range.e.c + 1, 26),
      cellData,
    };
    sheetOrder.push(id);
  });

  const snapshot = {
    id: `wb-${crypto.randomUUID()}`,
    name: workbookName,
    appVersion: '0.1.0',
    locale: 'zhCN',
    sheetOrder,
    sheets,
  };
  return { snapshot, report: importReport(book, snapshot) };
}

export function xlsxToSnapshot(buffer, workbookName = '导入的工作簿') {
  return importXlsxWorkbook(buffer, workbookName).snapshot;
}

export function snapshotToXlsx(snapshot) {
  const book = XLSX.utils.book_new();
  const order = snapshot.sheetOrder?.length ? snapshot.sheetOrder : Object.keys(snapshot.sheets ?? {});

  for (const sheetId of order) {
    const source = snapshot.sheets?.[sheetId];
    if (!source) continue;
    const sheet = {};
    let maxRow = 0;
    let maxColumn = 0;

    for (const [rowKey, columns] of Object.entries(source.cellData ?? {})) {
      const row = Number(rowKey);
      for (const [columnKey, cell] of Object.entries(columns ?? {})) {
        if (!cell) continue;
        const column = Number(columnKey);
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const output = {};
        if (cell.f) output.f = String(cell.f).replace(/^=/, '');
        if (cell.v !== undefined && cell.v !== null) {
          output.v = cell.v;
          output.t = inferCellType(cell.v);
        } else if (cell.f) {
          output.v = 0;
          output.t = 'n';
        } else {
          continue;
        }
        sheet[address] = output;
        maxRow = Math.max(maxRow, row);
        maxColumn = Math.max(maxColumn, column);
      }
    }

    sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxColumn } });
    XLSX.utils.book_append_sheet(book, sheet, String(source.name || 'Sheet').slice(0, 31));
  }

  if (book.SheetNames.length === 0) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[]]), 'Sheet1');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}

export function createDefaultSnapshot(name = '通用工作簿示例') {
  return {
    id: `wb-${crypto.randomUUID()}`,
    name,
    appVersion: '0.1.0',
    locale: 'zhCN',
    sheetOrder: ['orders', 'summary'],
    sheets: {
      orders: {
        id: 'orders',
        name: '记录数据',
        rowCount: 120,
        columnCount: 26,
        cellData: {
          0: { 0: { v: '记录编号' }, 1: { v: '分组' }, 2: { v: '基础值' }, 3: { v: '权重' }, 4: { v: '加权结果' } },
          1: { 0: { v: 'R001' }, 1: { v: '小组 A' }, 2: { v: 18 }, 3: { v: 3 }, 4: { f: '=C2*D2' } },
          2: { 0: { v: 'R002' }, 1: { v: '小组 A' }, 2: { v: 12 }, 3: { v: 2 }, 4: { f: '=C3*D3' } },
          3: { 0: { v: 'R003' }, 1: { v: '小组 B' }, 2: { v: 28 }, 3: { v: 4 }, 4: { f: '=C4*D4' } },
        },
      },
      summary: {
        id: 'summary',
        name: '汇总',
        rowCount: 100,
        columnCount: 20,
        cellData: {
          0: { 0: { v: '指标' }, 1: { v: '结果' } },
          1: { 0: { v: '记录数' }, 1: { f: "=COUNTA('记录数据'!A2:A100)" } },
          2: { 0: { v: '基础值合计' }, 1: { f: "=SUM('记录数据'!C2:C100)" } },
          3: { 0: { v: '基础值平均数' }, 1: { f: "=AVERAGE('记录数据'!C2:C100)" } },
          4: { 0: { v: '加权结果合计' }, 1: { f: "=SUM('记录数据'!E2:E100)" } },
        },
      },
    },
  };
}
