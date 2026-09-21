import { randomUUID } from 'node:crypto';
import { inspectWorkbookFormulas, validateBusinessModel } from '../shared/business-model.mjs';

export const TEMPLATE_PACKAGE_FORMAT = 'myexcel-template-package';
export const TEMPLATE_PACKAGE_VERSION = 1;

const clone = (value) => structuredClone(value);
const issue = (path, message) => ({ path, message });

function validateSnapshot(snapshot) {
  const issues = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [issue('template.snapshot', '工作簿快照必须是对象')];
  if (!snapshot.sheets || typeof snapshot.sheets !== 'object' || Array.isArray(snapshot.sheets)) issues.push(issue('template.snapshot.sheets', '工作簿至少需要一个工作表'));
  const sheetIds = Object.keys(snapshot.sheets || {});
  if (!sheetIds.length) issues.push(issue('template.snapshot.sheets', '工作簿至少需要一个工作表'));
  if (!Array.isArray(snapshot.sheetOrder) || snapshot.sheetOrder.some((id) => !sheetIds.includes(id))) issues.push(issue('template.snapshot.sheetOrder', '工作表顺序包含不存在的工作表'));
  for (const id of sheetIds) {
    const sheet = snapshot.sheets[id];
    if (!sheet || sheet.id !== id || typeof sheet.name !== 'string' || !sheet.name.trim()) issues.push(issue(`template.snapshot.sheets.${id}`, '工作表标识或名称无效'));
    if (!Number.isInteger(sheet?.rowCount) || sheet.rowCount < 1 || !Number.isInteger(sheet?.columnCount) || sheet.columnCount < 1) issues.push(issue(`template.snapshot.sheets.${id}`, '工作表行列数无效'));
  }
  return issues;
}

export function validateTemplatePackage(input) {
  const value = input?.package && typeof input.package === 'object' ? input.package : input;
  const issues = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, issues: [issue('', '模板包必须是 JSON 对象')] };
  if (value.format !== TEMPLATE_PACKAGE_FORMAT) issues.push(issue('format', `模板包格式必须是 ${TEMPLATE_PACKAGE_FORMAT}`));
  if (value.version !== TEMPLATE_PACKAGE_VERSION) issues.push(issue('version', `当前仅支持模板包版本 ${TEMPLATE_PACKAGE_VERSION}`));
  if (!value.application || typeof value.application !== 'object') issues.push(issue('application', '缺少应用基本信息'));
  if (typeof value.application?.name !== 'string' || !value.application.name.trim() || value.application.name.length > 100) issues.push(issue('application.name', '应用名称须为 1—100 个字符'));
  if (typeof value.application?.description !== 'string' || value.application.description.length > 500) issues.push(issue('application.description', '应用说明须为不超过 500 个字符的文本'));
  if (!value.template || typeof value.template !== 'object') issues.push(issue('template', '缺少模板定义'));
  issues.push(...validateSnapshot(value.template?.snapshot));
  if (value.template?.templateConfig !== undefined && (!value.template.templateConfig || typeof value.template.templateConfig !== 'object' || Array.isArray(value.template.templateConfig))) issues.push(issue('template.templateConfig', '模板配置必须是对象'));
  if (value.template?.dataSourceConfig !== undefined && (!value.template.dataSourceConfig || typeof value.template.dataSourceConfig !== 'object' || Array.isArray(value.template.dataSourceConfig))) issues.push(issue('template.dataSourceConfig', '数据源配置必须是对象'));
  const model = value.template?.templateConfig?.businessModel;
  if (model && value.template?.snapshot) {
    const report = validateBusinessModel(model, value.template.snapshot);
    issues.push(...report.issues.map((item) => issue(`template.templateConfig.businessModel.${item.path}`, item.message)));
  }
  const formulas = value.template?.snapshot ? inspectWorkbookFormulas(value.template.snapshot) : { formulas: [], supported: 0, unsupported: 0 };
  return {
    valid: issues.length === 0,
    issues,
    summary: {
      sheets: Object.keys(value.template?.snapshot?.sheets || {}).length,
      formulas: formulas.formulas.length,
      unsupportedFormulas: formulas.unsupported,
      hasBusinessModel: Boolean(model),
    },
  };
}

export function createTemplatePackage(workbook) {
  const payload = {
    format: TEMPLATE_PACKAGE_FORMAT,
    version: TEMPLATE_PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    application: { name: workbook.name, description: workbook.description || '' },
    template: {
      snapshot: clone(workbook.snapshot),
      templateConfig: clone(workbook.templateConfig || {}),
      dataSourceConfig: clone(workbook.dataSourceConfig || {}),
    },
  };
  const validation = validateTemplatePackage(payload);
  if (!validation.valid) throw Object.assign(new Error('当前模板不能导出为模板包'), { statusCode: 422, issues: validation.issues });
  return payload;
}

export function importTemplatePackage(input) {
  const value = input?.package && typeof input.package === 'object' ? input.package : input;
  const validation = validateTemplatePackage(value);
  if (!validation.valid) throw Object.assign(new Error('模板包兼容性校验未通过'), { statusCode: 422, issues: validation.issues });
  const snapshot = clone(value.template.snapshot);
  snapshot.id = `wb-${randomUUID()}`;
  snapshot.name = value.application.name.trim();
  return {
    name: value.application.name.trim(),
    description: value.application.description || '',
    snapshot,
    templateConfig: clone(value.template.templateConfig || {}),
    dataSourceConfig: clone(value.template.dataSourceConfig || {}),
    report: validation,
  };
}
