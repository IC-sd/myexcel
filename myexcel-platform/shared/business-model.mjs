// Pure, versioned contract shared by the designer and the future data service.
// No SQL, evaluation of expressions, network access, or database writes here.
export const FIELD_TYPES = ['text', 'number', 'decimal', 'date', 'boolean', 'choice', 'reference'];
export const FIELD_STATES = ['hidden', 'read', 'edit', 'required'];
export const SUPPORTED_FORMULA_FUNCTIONS = ['AND', 'AVERAGE', 'COUNT', 'COUNTA', 'COUNTIF', 'COUNTIFS', 'DATE', 'IF', 'IFERROR', 'INDEX', 'MATCH', 'MAX', 'MIN', 'NOT', 'OR', 'ROUND', 'SUM', 'SUMIF', 'SUMIFS', 'TODAY', 'VLOOKUP', 'XLOOKUP'];
const forbidden = new Set(['constructor', 'prototype', '__proto__']);
const keyOK = (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) && !forbidden.has(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = (value) => value === null || value === undefined || value === '';

export function fieldState(model, entityId, fieldId, role) {
  if (role === 'admin') return 'edit';
  const configured = model?.fieldPolicies?.find((item) => item.entityId === entityId && item.fieldId === fieldId && item.role === role)?.state;
  if (configured) return configured;
  return role === 'viewer' ? 'read' : 'edit';
}

export function inspectWorkbookFormulas(snapshot) {
  const supported = new Set(SUPPORTED_FORMULA_FUNCTIONS);
  const formulas = [];
  for (const [sheetId, sheet] of Object.entries(snapshot?.sheets || {})) for (const [row, columns] of Object.entries(sheet.cellData || {})) for (const [col, cell] of Object.entries(columns || {})) {
    if (typeof cell?.f !== 'string' || !cell.f.trim()) continue;
    const expression = cell.f.trim();
    const reasons = [];
    if (!expression.startsWith('=')) reasons.push('公式必须以 = 开头');
    if (/\[[^\]]+\][^!]*!/.test(expression)) reasons.push('暂不支持外部工作簿引用');
    let depth = 0; let quoted = false;
    for (let i = 0; i < expression.length; i++) {
      if (expression[i] === '"' && expression[i + 1] === '"' && quoted) { i++; continue; }
      if (expression[i] === '"') quoted = !quoted;
      else if (!quoted && expression[i] === '(') depth++;
      else if (!quoted && expression[i] === ')' && --depth < 0) break;
    }
    if (quoted || depth !== 0) reasons.push('引号或括号不配对');
    const functions = [...expression.matchAll(/\b([A-Z][A-Z0-9._]*)\s*\(/gi)].map((match) => match[1].toUpperCase());
    const unknown = [...new Set(functions.filter((name) => !supported.has(name)))];
    if (unknown.length) reasons.push(`暂不支持函数：${unknown.join('、')}`);
    const address = `${columnName(Number(col))}${Number(row) + 1}`;
    formulas.push({ sheetId, address, expression, functions, supported: reasons.length === 0, reasons });
  }
  return { formulas, supported: formulas.filter((item) => item.supported).length, unsupported: formulas.filter((item) => !item.supported).length };
}

function columnName(index) {
  let value = index + 1; let result = '';
  while (value > 0) { value--; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
  return result;
}

export function cellPosition(address) {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(address || '');
  if (!match) return null;
  const col = [...match[1]].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1;
  const row = Number(match[2]) - 1;
  return col < 16384 && row < 1048576 ? { row, col } : null;
}

export function validateBusinessModel(model, snapshot) {
  const issues = [];
  const add = (path, message) => { if (issues.length < 100) issues.push({ path, message }); };
  if (!object(model) || model.schemaVersion !== 1) return { valid: false, issues: [{ path: 'schemaVersion', message: '仅支持业务模型版本 1' }] };
  if (model.dataSpaceId !== undefined && !keyOK(model.dataSpaceId)) add('dataSpaceId', '共享数据空间须为小写稳定标识；留空时仅在当前模板内使用');
  if (model.recordScope !== undefined && !['own', 'all'].includes(model.recordScope)) add('recordScope', '记录范围须为 own（仅本人）或 all（同模板协作）');
  if (!Array.isArray(model.entities) || !model.entities.length || model.entities.length > 32) {
    return { valid: false, issues: [{ path: 'entities', message: '请配置 1—32 张业务表' }] };
  }
  const entities = new Map();
  model.entities.forEach((entity, i) => {
    const path = `entities[${i}]`;
    if (!object(entity) || !keyOK(entity.id) || entities.has(entity.id)) { add(path, '业务表标识不合法或重复'); return; }
    if (typeof entity.label !== 'string' || !entity.label.trim()) add(path, '业务表名称不能为空');
    const fields = new Map();
    entities.set(entity.id, { entity, fields });
    if (!Array.isArray(entity.fields) || !entity.fields.length || entity.fields.length > 64) { add(path, '每张表须配置 1—64 个字段'); return; }
    entity.fields.forEach((field, j) => {
      const fp = `${path}.fields[${j}]`;
      if (!object(field) || !keyOK(field.id) || fields.has(field.id)) { add(fp, '字段标识不合法或重复'); return; }
      fields.set(field.id, field);
      if (typeof field.label !== 'string' || !field.label.trim()) add(fp, '字段名称不能为空');
      if (!FIELD_TYPES.includes(field.type)) add(fp, '不支持的字段类型');
      if (field.type === 'decimal' && (!Number.isInteger(field.scale) || field.scale < 0 || field.scale > 6)) add(fp, '定点小数位数须为 0—6');
      if (typeof field.required !== 'boolean') add(fp, '必填属性必须为布尔值');
      if (field.type === 'choice' && (!Array.isArray(field.options) || !field.options.length || field.options.length > 100 || field.options.some((x) => typeof x !== 'string' || !x) || new Set(field.options).size !== field.options.length)) add(fp, '选项必须是 1—100 个不重复的非空文本');
      if (field.defaultValue != null && field.defaultValue !== '') {
        if (typeof field.defaultValue !== 'string') add(`${fp}.defaultValue`, '默认值必须是文本');
        else { try { typedValue(field.defaultValue, field, fp); } catch { add(`${fp}.defaultValue`, '默认值与字段类型或选项不匹配'); } }
      }
    });
  });
  for (const { entity, fields } of entities.values()) {
    for (const field of fields.values()) if (field.type === 'reference' && !entities.has(field.targetEntityId)) add(`${entity.id}.${field.id}`, '关联目标表不存在');
  }
  if (model.fieldPolicies !== undefined && (!Array.isArray(model.fieldPolicies) || model.fieldPolicies.length > 256)) add('fieldPolicies', '字段状态须为数组，最多 256 条');
  else {
    const policyKeys = new Set();
    for (const [i, policy] of (model.fieldPolicies || []).entries()) {
      const path = `fieldPolicies[${i}]`;
      const key = `${policy?.entityId}:${policy?.fieldId}:${policy?.role}`;
      const field = entities.get(policy?.entityId)?.fields.get(policy?.fieldId);
      if (!object(policy) || !field || !['editor', 'viewer'].includes(policy.role) || !FIELD_STATES.includes(policy.state) || policyKeys.has(key)) { add(path, '字段状态目标、角色、状态不合法或重复'); continue; }
      if (policy.role === 'viewer' && !['hidden', 'read'].includes(policy.state)) add(path, '只读角色的字段只能隐藏或只读');
      policyKeys.add(key);
    }
  }
  const doc = model.document;
  if (!object(doc) || !entities.has(doc.entityId)) { add('document.entityId', '请选择有效的主表'); return { valid: false, issues }; }
  const claimed = new Set();
  const checkCell = (sheetId, address, path) => {
    const sheet = typeof sheetId === 'string' && Object.hasOwn(snapshot?.sheets || {}, sheetId) ? snapshot.sheets[sheetId] : null;
    const pos = cellPosition(address);
    if (!sheet || !pos || !Number.isInteger(sheet.rowCount) || !Number.isInteger(sheet.columnCount) || pos.row >= sheet.rowCount || pos.col >= sheet.columnCount) { add(path, '工作表或单元格不存在、越界'); return; }
    const key = `${sheetId}:${address}`;
    if (claimed.has(key)) add(path, '多个输入绑定不能占用同一单元格');
    claimed.add(key);
    const cell = sheet.cellData?.[pos.row]?.[pos.col];
    if (cell?.f) add(path, '输入绑定不能覆盖公式单元格');
    const merged = (sheet.mergeData || []).find((m) => pos.row >= m.startRow && pos.row <= m.endRow && pos.col >= m.startColumn && pos.col <= m.endColumn);
    if (merged && (pos.row !== merged.startRow || pos.col !== merged.startColumn)) add(path, '合并区域只能绑定左上角单元格');
  };
  const boundMain = new Set();
  if (!Array.isArray(doc.fields) || !doc.fields.length || doc.fields.length > 64) add('document.fields', '请配置 1—64 个主表单元格绑定');
  else doc.fields.forEach((binding, i) => {
    const path = `document.fields[${i}]`;
    if (!object(binding) || !entities.get(doc.entityId).fields.has(binding.fieldId) || boundMain.has(binding.fieldId)) { add(path, '主表字段不存在或重复绑定'); return; }
    boundMain.add(binding.fieldId);
    checkCell(binding.sheetId, binding.cell, path);
  });
  for (const field of entities.get(doc.entityId).fields.values()) if (field.required && !boundMain.has(field.id)) add(`document.${field.id}`, '必填主表字段尚未绑定');
  if (!Array.isArray(doc.details) || doc.details.length > 8) add('document.details', '明细区域须为数组，最多 8 个');
  else {
    const detailIds = new Set();
    doc.details.forEach((detail, i) => {
      const path = `document.details[${i}]`;
      if (!object(detail) || !keyOK(detail.id) || detailIds.has(detail.id)) { add(path, '明细区域标识不合法或重复'); return; }
      detailIds.add(detail.id);
      const target = entities.get(detail.entityId);
      const relation = target?.fields.get(detail.parentFieldId);
      if (!target || detail.entityId === doc.entityId || relation?.type !== 'reference' || relation.targetEntityId !== doc.entityId) { add(path, '明细必须通过关联字段指向主表'); return; }
      if (!Number.isInteger(detail.startRow) || detail.startRow < 1 || !Number.isInteger(detail.rowCount) || detail.rowCount < 1 || detail.rowCount > 1000) { add(path, '明细起始行须为正整数，行数为 1—1000'); return; }
      if (!Array.isArray(detail.columns) || !detail.columns.length || detail.columns.length > 64) { add(path, '请配置 1—64 个明细列'); return; }
      const bound = new Set();
      detail.columns.forEach((binding, j) => {
        const bp = `${path}.columns[${j}]`;
        if (!object(binding) || !target.fields.has(binding.fieldId) || binding.fieldId === detail.parentFieldId || bound.has(binding.fieldId)) { add(bp, '明细字段不存在、重复或为系统维护的主表关联字段'); return; }
        bound.add(binding.fieldId);
        if (!/^[A-Z]{1,3}$/.test(binding.column || '')) { add(bp, '列名须为 A、B 等大写列标'); return; }
        for (let row = detail.startRow; row < detail.startRow + detail.rowCount; row++) checkCell(detail.sheetId, `${binding.column}${row}`, bp);
      });
      for (const field of target.fields.values()) if (field.required && field.id !== detail.parentFieldId && !bound.has(field.id)) add(path, `必填明细字段 ${field.label} 尚未绑定`);
    });
  }
  const rules = model.rules || {};
  if (!object(rules)) add('rules', '业务规则必须为对象');
  else {
    const ruleIds = new Set();
    const unique = (rule, path) => {
      if (!object(rule) || !keyOK(rule.id) || ruleIds.has(rule.id)) { add(path, '规则标识不合法或重复'); return false; }
      ruleIds.add(rule.id); return true;
    };
    for (const [i, rule] of (rules.lookups || []).entries()) {
      const path = `rules.lookups[${i}]`; if (!unique(rule, path)) continue;
      const source = entities.get(rule.entityId), reference = source?.fields.get(rule.referenceFieldId), target = entities.get(reference?.targetEntityId);
      const destinationBound = rule.entityId === doc.entityId ? doc.fields?.some((item) => item.fieldId === rule.destinationFieldId) : doc.details?.find((item) => item.entityId === rule.entityId)?.columns?.some((item) => item.fieldId === rule.destinationFieldId);
      if (!source || reference?.type !== 'reference' || !target?.fields.has(rule.targetFieldId) || !source.fields.has(rule.destinationFieldId) || !destinationBound) add(path, '关联取数字段不存在、类型不符或目标字段未绑定');
      if (!['snapshot', 'live'].includes(rule.strategy)) add(path, '关联取数策略须为 snapshot 或 live');
      if ((rule.filterFieldId != null && rule.filterFieldId !== '') || (rule.filterValue != null && rule.filterValue !== '')) {
        if (!target?.fields.has(rule.filterFieldId) || typeof rule.filterValue !== 'string' || !rule.filterValue.trim()) add(path, '关联取数筛选须指向目标实体的字段并给出匹配值');
      }
    }
    for (const [i, rule] of (rules.calculations || []).entries()) {
      const path = `rules.calculations[${i}]`; if (!unique(rule, path)) continue;
      const detail = doc.details?.find((item) => item.id === rule.detailId);
      const target = entities.get(doc.entityId)?.fields.get(rule.destinationFieldId), source = entities.get(detail?.entityId)?.fields.get(rule.sourceFieldId);
      if (!detail || rule.operation !== 'sum' || !['number', 'decimal'].includes(target?.type) || !['number', 'decimal'].includes(source?.type)) add(path, '服务端计算仅支持数值明细字段求和到主表数值字段');
    }
    for (const [i, rule] of (rules.aggregates || []).entries()) {
      const path = `rules.aggregates[${i}]`; if (!unique(rule, path)) continue;
      const source = entities.get(rule.entityId), field = source?.fields.get(rule.fieldId);
      if (!source || !['count', 'sum'].includes(rule.operation) || (rule.operation === 'sum' && !['number', 'decimal'].includes(field?.type)) || (rule.groupByFieldId && !source.fields.has(rule.groupByFieldId))) add(path, '汇总规则字段或运算无效');
    }
    const workflow = rules.workflow;
    if (workflow != null) {
      const states = workflow?.states;
      if (!object(workflow) || !Array.isArray(states) || states.length < 2 || states.some((state) => !keyOK(state)) || !states.includes(workflow.initialState)) add('rules.workflow', '流程须配置至少两个合法状态及初始状态');
      for (const [i, transition] of (workflow?.transitions || []).entries()) {
        if (!unique(transition, `rules.workflow.transitions[${i}]`)) continue;
        if (!states?.includes(transition.from) || !states?.includes(transition.to) || !Array.isArray(transition.roles) || transition.roles.some((role) => !['admin', 'editor'].includes(role))) add(`rules.workflow.transitions[${i}]`, '流程转换状态或角色无效');
        if (transition.writeback) {
          const reference = entities.get(doc.entityId)?.fields.get(transition.writeback.referenceFieldId), target = entities.get(reference?.targetEntityId), field = target?.fields.get(transition.writeback.targetFieldId);
          if (reference?.type !== 'reference' || !field || empty(transition.writeback.value)) add(`rules.workflow.transitions[${i}].writeback`, '回写须指向主表关联目标的有效字段和值');
        }
      }
    }
  }
  for (const formula of inspectWorkbookFormulas(snapshot).formulas.filter((item) => !item.supported)) add(`formulas.${formula.sheetId}!${formula.address}`, formula.reasons.join('；'));
  return { valid: issues.length === 0, issues: issues.slice(0, 100) };
}

// Detect breaking structural changes between two business models of the same
// workbook: changes that would orphan or invalidate records already persisted
// against the previous release. Safe changes (new entities/fields, label edits,
// relaxing required, extending choice options) are intentionally ignored.
export function diffModelSchema(previous, next) {
  const breaking = [];
  const add = (path, message) => breaking.push({ path, message });
  if (!object(previous) || !object(next)) return { breaking };
  const prevSpace = previous.dataSpaceId || '';
  const nextSpace = next.dataSpaceId || '';
  if (prevSpace !== nextSpace) add('dataSpaceId', `共享数据空间由「${prevSpace || '模板隔离'}」变为「${nextSpace || '模板隔离'}」，历史记录将被隔离`);
  const previousEntities = new Map((previous.entities || []).map((entity) => [entity.id, entity]));
  const nextEntities = new Map((next.entities || []).map((entity) => [entity.id, entity]));
  for (const [id, prev] of previousEntities) {
    const curr = nextEntities.get(id);
    if (!curr) { add(`entities.${id}`, `业务表「${prev.label || id}」被删除，历史记录将失去归属`); continue; }
    const previousFields = new Map((prev.fields || []).map((field) => [field.id, field]));
    const nextFields = new Map((curr.fields || []).map((field) => [field.id, field]));
    for (const [fieldId, before] of previousFields) {
      const after = nextFields.get(fieldId);
      const label = before.label || fieldId;
      if (!after) { add(`${id}.${fieldId}`, `字段「${label}」被删除，历史数据将丢失`); continue; }
      if (before.type !== after.type) { add(`${id}.${fieldId}`, `字段「${label}」类型由 ${before.type} 变为 ${after.type}，旧数据将无法按新类型解析`); continue; }
      if (before.type === 'decimal' && before.scale !== after.scale) add(`${id}.${fieldId}`, `定点小数「${label}」位数由 ${before.scale} 变为 ${after.scale}，旧金额精度会改变`);
      if (before.type === 'reference' && before.targetEntityId !== after.targetEntityId) add(`${id}.${fieldId}`, `关联字段「${label}」目标表由 ${before.targetEntityId} 变为 ${after.targetEntityId}`);
      if (before.type === 'choice') {
        const nextOptions = new Set(after.options || []);
        const removed = (before.options || []).filter((option) => !nextOptions.has(option));
        if (removed.length) add(`${id}.${fieldId}`, `选项字段「${label}」删除了选项 ${removed.join('、')}，历史记录中对应的值将失效`);
      }
      if (before.required === false && after.required === true) add(`${id}.${fieldId}`, `字段「${label}」由选填变为必填，历史记录可能缺少该值`);
    }
  }
  return { breaking };
}

function demandValid(model, snapshot) {
  const result = validateBusinessModel(model, snapshot);
  if (!result.valid) throw Object.assign(new Error(result.issues.map((i) => `${i.path}: ${i.message}`).join('；')), { statusCode: 422, issues: result.issues });
}

export function typedValue(value, field, path) {
  const fail = (message) => { throw Object.assign(new Error(`${path}: ${message}`), { statusCode: 422 }); };
  if (empty(value)) { if (field.required) fail(`${field.label}为必填`); return null; }
  if (typeof value === 'string' && value.length > 16384) fail('单个字段最多 16384 个字符');
  if (field.type === 'decimal') {
    // Accept text only: a JS number may already have lost the user's precision.
    if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) fail('定点小数必须用文本传递，不能使用浮点数');
    const negative = value.startsWith('-');
    const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
    if (fraction.length > field.scale) fail(`最多 ${field.scale} 位小数，禁止静默舍入`);
    const integer = whole.replace(/^0+(?=\d)/, '');
    if (integer.length + field.scale > 18) fail('定点小数总精度不能超过 18 位');
    const normalized = integer + (field.scale ? `.${fraction.padEnd(field.scale, '0')}` : '');
    return negative && /[1-9]/.test(normalized) ? `-${normalized}` : normalized;
  }
  if (field.type === 'text' || field.type === 'reference' || field.type === 'choice') {
    if (typeof value !== 'string') fail('请使用文本（关联字段保存稳定记录标识）');
    if (field.required && !value.trim()) fail('必填内容不能只有空格');
    if (field.type === 'choice' && !field.options.includes(value)) fail('值不在选项内');
    return value;
  }
  if (field.type === 'boolean') { if (typeof value !== 'boolean') fail('必须为布尔值'); return value; }
  if (field.type === 'number') {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))) fail('必须为有效数字');
    const result = Number(value);
    if (!Number.isFinite(result)) fail('必须为有限数值');
    return result;
  }
  if (field.type === 'date') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('日期须为有效的 YYYY-MM-DD 文本；不接受数字、日期对象或其它格式（网格中的日期序号已在保存前换算）');
    return value;
  }
}

// The grid stores a typed or pasted date as an Excel serial number even when the
// bound cell was prepared as forced text. Excel's 1900 system carries the fictitious
// 1900-02-29, so serials at or below 60 need the one-day-earlier epoch. Serials are
// interpreted in UTC to avoid shifting a pure calendar date across time zones.
export function exactGridDate(value, field) {
  if (field.type !== 'date' || typeof value !== 'number' || !Number.isFinite(value)) return value;
  const days = Math.floor(value);
  if (days < 1 || days > 2958465 || days !== value) return value;
  const epoch = days <= 60 ? Date.UTC(1899, 11, 31) + (days - 1) * 86400000 : Date.UTC(1899, 11, 30) + days * 86400000;
  return new Date(epoch).toISOString().slice(0, 10);
}

export function normalizeGridValue(value, field) {
  return exactGridDate(exactGridDecimal(value, field), field);
}

function exactGridDecimal(value, field) {
  if (field.type !== 'decimal' || typeof value !== 'number') return value;
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[3] || '').length > field.scale) return value;
  const unscaled = BigInt(`${match[1]}${match[2]}${(match[3] || '').padEnd(field.scale, '0')}`);
  return unscaled >= -9007199254740991n && unscaled <= 9007199254740991n ? text : value;
}

export function extractBusinessRecord(model, snapshot, { detailRowIds = {}, coerceGridDecimals = false } = {}) {
  demandValid(model, snapshot);
  const doc = model.document;
  const entities = new Map(model.entities.map((e) => [e.id, new Map(e.fields.map((f) => [f.id, f]))]));
  const read = (sheetId, address) => { const { row, col } = cellPosition(address); return snapshot.sheets[sheetId].cellData?.[row]?.[col]?.v; };
  const record = { entityId: doc.entityId, values: {}, details: {} };
  for (const binding of doc.fields) {
    const field = entities.get(doc.entityId).get(binding.fieldId);
    const value = read(binding.sheetId, binding.cell);
    record.values[binding.fieldId] = typedValue(coerceGridDecimals ? normalizeGridValue(value, field) : value, field, `${binding.sheetId}!${binding.cell}`);
  }
  for (const detail of doc.details) {
    const rows = [];
    for (let row = detail.startRow; row < detail.startRow + detail.rowCount; row++) {
      const raw = detail.columns.map((b) => read(detail.sheetId, `${b.column}${row}`));
      if (raw.every(empty)) continue;
      const values = {};
      detail.columns.forEach((binding, i) => {
        const field = entities.get(detail.entityId).get(binding.fieldId);
        const value = coerceGridDecimals ? normalizeGridValue(raw[i], field) : raw[i];
        values[binding.fieldId] = typedValue(value, field, `${detail.sheetId}!${binding.column}${row}`);
      });
      const id = detailRowIds[detail.id]?.[row - detail.startRow];
      rows.push({ ...(id ? { id } : {}), entityId: detail.entityId, values });
    }
    record.details[detail.id] = rows;
  }
  return record;
}

export function prepareBusinessInputSnapshot(model, snapshot, { clearValues = false } = {}) {
  demandValid(model, snapshot);
  const result = structuredClone(snapshot);
  const entities = new Map(model.entities.map((entity) => [entity.id, new Map(entity.fields.map((field) => [field.id, field]))]));
  const prepare = (sheetId, address, field) => {
    const { row, col } = cellPosition(address);
    const line = result.sheets[sheetId].cellData ??= {};
    const cells = line[row] ??= {};
    const { p, t, ...cell } = cells[col] || {};
    cells[col] = { ...cell, v: clearValues ? null : (cell.v ?? null) };
    if (['text', 'decimal', 'date', 'choice', 'reference'].includes(field.type)) cells[col].t = 4; // Univer FORCE_STRING
  };
  for (const binding of model.document.fields) prepare(binding.sheetId, binding.cell, entities.get(model.document.entityId).get(binding.fieldId));
  for (const detail of model.document.details) for (const binding of detail.columns) {
    const field = entities.get(detail.entityId).get(binding.fieldId);
    for (let row = detail.startRow; row < detail.startRow + detail.rowCount; row++) prepare(detail.sheetId, `${binding.column}${row}`, field);
  }
  return result;
}

export function hydrateBusinessRecord(model, snapshot, record) {
  demandValid(model, snapshot);
  if (!object(record) || record.entityId !== model.document.entityId || !object(record.values) || !object(record.details)) throw Object.assign(new Error('回填记录与主表模型不一致'), { statusCode: 422 });
  const result = structuredClone(snapshot);
  const write = (sheetId, address, value) => {
    const { row, col } = cellPosition(address);
    const cells = result.sheets[sheetId].cellData ??= {};
    const line = cells[row] ??= {};
    // Remove stale rendered text, type and rich text; preserve the cell style.
    const { v, t, p, ...format } = line[col] || {};
    line[col] = { ...format, v: value ?? null };
  };
  for (const binding of model.document.fields) write(binding.sheetId, binding.cell, record.values[binding.fieldId]);
  for (const detail of model.document.details) {
    const rows = record.details[detail.id];
    if (!Array.isArray(rows) || rows.length > detail.rowCount || rows.some((r) => !object(r) || r.entityId !== detail.entityId || !object(r.values))) throw Object.assign(new Error(`明细 ${detail.id} 类型错误或超出预留行数`), { statusCode: 422 });
    for (let i = 0; i < detail.rowCount; i++) for (const binding of detail.columns) write(detail.sheetId, `${binding.column}${detail.startRow + i}`, rows[i]?.values[binding.fieldId]);
  }
  extractBusinessRecord(model, result); // Enforce identical typing/required rules on both paths.
  return result;
}
