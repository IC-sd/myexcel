const GROUPS = ['小组 A', '小组 B', '小组 C', '小组 D', '小组 E', '小组 F'];

function dateAfter(day) {
  const date = new Date('2026-09-01T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + day);
  return date.toISOString().slice(0, 10);
}

export function createSyntheticWorkbookBenchmark(rowCount = 3000, columnCount = 26) {
  const count = Math.max(100, Math.min(Number(rowCount) || 3000, 10000));
  const columns = Math.max(26, Math.min(Number(columnCount) || 26, 200));
  const records = {
    0: {
      0: { v: '记录编号' }, 1: { v: '分组' }, 2: { v: '基础值' }, 3: { v: '权重' },
      4: { v: '开始日期' }, 5: { v: '结束日期' }, 6: { v: '系数' }, 7: { v: '加权结果' },
    },
  };
  for (let index = 0; index < count; index += 1) {
    const row = index + 1;
    const baseValue = 4 + ((index * 7) % 37);
    const weight = 1 + (index % 5);
    records[row] = {
      0: { v: `ROW-${String(index + 1).padStart(5, '0')}` },
      1: { v: GROUPS[index % GROUPS.length] },
      2: { v: baseValue },
      3: { v: weight },
      4: { v: dateAfter(index % 90) },
      5: { v: dateAfter((index % 90) + 7 + (index % 15)) },
      6: { v: index % 7 === 5 ? 0.8 : index % 7 === 6 ? 0.6 : 1 },
      7: { f: `=C${row + 1}*D${row + 1}/G${row + 1}` },
    };
  }

  const groups = {
    0: { 0: { v: '分组' }, 1: { v: '成员数' }, 2: { v: '单位值' }, 3: { v: '90天基准值' } },
  };
  GROUPS.forEach((group, index) => {
    const row = index + 2;
    groups[index + 1] = {
      0: { v: group }, 1: { v: 5 + index }, 2: { v: 8 }, 3: { f: `=B${row}*C${row}*90` },
    };
  });

  const lastRow = count + 1;
  const summary = {
    0: { 0: { v: '合成工作簿基准' }, 1: { v: '计算结果' } },
    1: { 0: { v: '记录总数' }, 1: { f: `=COUNTA('记录数据'!A2:A${lastRow})` } },
    2: { 0: { v: '基础值合计' }, 1: { f: `=SUM('记录数据'!C2:C${lastRow})` } },
    3: { 0: { v: '加权结果合计' }, 1: { f: `=SUM('记录数据'!H2:H${lastRow})` } },
    4: { 0: { v: '基础值平均数' }, 1: { f: `=AVERAGE('记录数据'!C2:C${lastRow})` } },
    5: { 0: { v: '最高权重值合计' }, 1: { f: `=SUMIF('记录数据'!D2:D${lastRow},5,'记录数据'!C2:C${lastRow})` } },
    7: { 0: { v: '说明' }, 1: { v: `${count} 条可重复生成的合成记录，不包含任何真实业务数据` } },
  };

  return {
    id: `wb-${crypto.randomUUID()}`,
    name: `合成工作簿基准-${count}条-${columns}列`, appVersion: '0.2.0', locale: 'zhCN',
    sheetOrder: ['records', 'groups', 'summary'],
    sheets: {
      records: { id: 'records', name: '记录数据', rowCount: count + 100, columnCount: columns, cellData: records },
      groups: { id: 'groups', name: '分组参数', rowCount: 100, columnCount: 20, cellData: groups },
      summary: { id: 'summary', name: '汇总看板', rowCount: 100, columnCount: 20, cellData: summary },
    },
  };
}
