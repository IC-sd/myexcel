<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../api.js';
import { FIELD_TYPES, inspectWorkbookFormulas, validateBusinessModel } from '../../shared/business-model.mjs';

const props = defineProps({ modelValue: Object, snapshot: Object, workbookId: String, version: Number, disabled: Boolean });
const emit = defineEmits(['update:modelValue']);
const labels = { text: '文本', number: '数值', decimal: '定点小数/金额', date: '日期', boolean: '是/否', choice: '选项', reference: '关联记录' };
const sheets = computed(() => Object.entries(props.snapshot?.sheets || {}).map(([id, sheet]) => ({ id, name: sheet.name || id })));
const report = computed(() => props.modelValue ? validateBusinessModel(props.modelValue, props.snapshot) : null);
const formulaReport = computed(() => inspectWorkbookFormulas(props.snapshot));
const main = computed(() => props.modelValue?.entities.find((e) => e.id === props.modelValue.document.entityId));
const pending = ref(false);
const preview = ref(null);
const feedback = ref('');
const previewRole = ref('editor');
const previewRecords = ref([]);
const previewRecordId = ref('');
watch(() => [props.modelValue, props.snapshot, props.version], () => { preview.value = null; feedback.value = ''; });
watch(() => props.workbookId, async () => {
  previewRecords.value = []; previewRecordId.value = '';
  try { previewRecords.value = (await api.listRecords(props.workbookId, 0)).records || []; previewRecordId.value = previewRecords.value[0]?.id || ''; }
  catch { /* Unpublished templates can still preview values stored in their draft grid. */ }
}, { immediate: true });
const copy = (value) => JSON.parse(JSON.stringify(value));
function edit(change) { const model = copy(props.modelValue); change(model); emit('update:modelValue', model); }
function nextId(items, prefix) { let n = 1; while (items.some((item) => item.id === `${prefix}_${n}`)) n++; return `${prefix}_${n}`; }
function entity(id) { return props.modelValue.entities.find((e) => e.id === id); }
function enable() {
  emit('update:modelValue', { schemaVersion: 1, entities: [{ id: 'document', label: '业务单据', fields: [{ id: 'title', label: '标题', type: 'text', required: false }] }],
    document: { entityId: 'document', fields: [{ fieldId: 'title', sheetId: sheets.value[0]?.id || '', cell: 'A1' }], details: [] }, rules: { lookups: [], calculations: [], aggregates: [] } });
}
function addEntity() { edit((m) => m.entities.push({ id: nextId(m.entities, 'entity'), label: '新业务表', fields: [{ id: 'name', label: '名称', type: 'text', required: false }] })); }
function addField(index) { edit((m) => m.entities[index].fields.push({ id: nextId(m.entities[index].fields, 'field'), label: '新字段', type: 'text', required: false })); }
function fieldChange(e, f, key, value) { edit((m) => {
  const field = m.entities[e].fields[f]; field[key] = value;
  if (key === 'type') { delete field.targetEntityId; delete field.options; delete field.scale; delete field.defaultValue; if (value === 'reference') field.targetEntityId = ''; if (value === 'choice') field.options = ['选项一', '选项二']; if (value === 'decimal') field.scale = 2; }
}); }
function policyState(tableId, fieldId, role) {
  return props.modelValue.fieldPolicies?.find((item) => item.entityId === tableId && item.fieldId === fieldId && item.role === role)?.state || (role === 'viewer' ? 'read' : 'edit');
}
function setPolicyState(tableId, fieldId, role, state) { edit((m) => {
  m.fieldPolicies ||= [];
  const index = m.fieldPolicies.findIndex((item) => item.entityId === tableId && item.fieldId === fieldId && item.role === role);
  const defaultState = role === 'viewer' ? 'read' : 'edit';
  if (state === defaultState) { if (index >= 0) m.fieldPolicies.splice(index, 1); }
  else if (index >= 0) m.fieldPolicies[index].state = state;
  else m.fieldPolicies.push({ entityId: tableId, fieldId, role, state });
}); }
function mainChange(id) { edit((m) => { m.document = { entityId: id, fields: [], details: [] }; }); }
function lookupTargetFields(model, rule) {
  const source = model.entities.find((item) => item.id === rule.entityId);
  const reference = source?.fields.find((field) => field.id === rule.referenceFieldId);
  return model.entities.find((item) => item.id === reference?.targetEntityId)?.fields || [];
}
function mainReferenceFields(model) {
  return model.entities.find((item) => item.id === model.document.entityId)?.fields.filter((field) => field.type === 'reference') || [];
}
function addBinding() { edit((m) => m.document.fields.push({ fieldId: '', sheetId: sheets.value[0]?.id || '', cell: '' })); }
function bindingChange(index, key, value) { edit((m) => { m.document.fields[index][key] = value; }); }
function addDetail() {
  edit((m) => {
    const id = nextId(m.entities, 'detail');
    m.entities.push({ id, label: '单据明细', fields: [
      { id: 'parent_id', label: '所属主单据', type: 'reference', targetEntityId: m.document.entityId, required: true },
      { id: 'name', label: '名称', type: 'text', required: false },
    ] });
    m.document.details.push({ id: nextId(m.document.details, 'rows'), entityId: id, parentFieldId: 'parent_id', sheetId: sheets.value[0]?.id || '', startRow: 3, rowCount: 3, columns: [{ fieldId: 'name', column: 'A' }] });
  });
}
function detailChange(index, key, value) { edit((m) => { m.document.details[index][key] = value; }); }
function rules(m) { return m.rules ||= { lookups: [], calculations: [], aggregates: [] }; }
function renameField(model, entity, fromId, toId) {
  const field = entity.fields.find((item) => item.id === fromId);
  if (!field) return;
  field.id = toId;
  for (const policy of model.fieldPolicies || []) if (policy.entityId === entity.id && policy.fieldId === fromId) policy.fieldId = toId;
  for (const binding of model.document.fields) if (model.document.entityId === entity.id && binding.fieldId === fromId) binding.fieldId = toId;
  for (const detail of model.document.details) {
    if (detail.entityId === entity.id) for (const column of detail.columns) if (column.fieldId === fromId) column.fieldId = toId;
    if (detail.parentFieldId === fromId && detail.entityId === entity.id) detail.parentFieldId = toId;
  }
  for (const rule of model.rules?.lookups || []) {
    if (rule.entityId === entity.id && rule.referenceFieldId === fromId) rule.referenceFieldId = toId;
    if (rule.entityId === entity.id && rule.destinationFieldId === fromId) rule.destinationFieldId = toId;
    if (rule.filterFieldId === fromId && model.entities.find((item) => item.id === rule.entityId)?.fields.find((f) => f.type === 'reference')?.targetEntityId === entity.id) rule.filterFieldId = toId;
    const reference = model.entities.find((item) => item.id === rule.entityId)?.fields.find((f) => f.id === rule.referenceFieldId);
    if (reference?.targetEntityId === entity.id && rule.targetFieldId === fromId) rule.targetFieldId = toId;
  }
  for (const rule of model.rules?.calculations || []) {
    const detail = model.document.details.find((item) => item.id === rule.detailId);
    if (detail?.entityId === entity.id && rule.sourceFieldId === fromId) rule.sourceFieldId = toId;
    if (model.document.entityId === entity.id && rule.destinationFieldId === fromId) rule.destinationFieldId = toId;
  }
  for (const rule of model.rules?.aggregates || []) {
    if (rule.entityId === entity.id && rule.fieldId === fromId) rule.fieldId = toId;
    if (rule.entityId === entity.id && rule.groupByFieldId === fromId) rule.groupByFieldId = toId;
  }
  for (const transition of model.rules?.workflow?.transitions || []) {
    const reference = model.entities.find((item) => item.id === model.document.entityId)?.fields.find((f) => f.id === transition.writeback?.referenceFieldId);
    if (reference?.targetEntityId === entity.id && transition.writeback.targetFieldId === fromId) transition.writeback.targetFieldId = toId;
  }
}
function renameEntity(model, fromId, toId) {
  const entity = model.entities.find((item) => item.id === fromId);
  if (!entity) return;
  entity.id = toId;
  for (const policy of model.fieldPolicies || []) if (policy.entityId === fromId) policy.entityId = toId;
  if (model.document.entityId === fromId) model.document.entityId = toId;
  for (const detail of model.document.details) if (detail.entityId === fromId) detail.entityId = toId;
  for (const table of model.entities) for (const field of table.fields) if (field.type === 'reference' && field.targetEntityId === fromId) field.targetEntityId = toId;
  for (const rule of model.rules?.lookups || []) if (rule.entityId === fromId) rule.entityId = toId;
  for (const rule of model.rules?.aggregates || []) if (rule.entityId === fromId) rule.entityId = toId;
}
function addLookup() { edit((m) => rules(m).lookups.push({ id: nextId(rules(m).lookups, 'lookup'), entityId: m.document.entityId, referenceFieldId: '', targetFieldId: '', destinationFieldId: '', strategy: 'snapshot' })); }
function addCalculation() { edit((m) => rules(m).calculations.push({ id: nextId(rules(m).calculations, 'calculation'), operation: 'sum', detailId: m.document.details[0]?.id || '', sourceFieldId: '', destinationFieldId: '' })); }
function addAggregate() { edit((m) => rules(m).aggregates.push({ id: nextId(rules(m).aggregates, 'aggregate'), label: '业务汇总', entityId: m.document.entityId, operation: 'count', fieldId: '', groupByFieldId: '' })); }
function enableWorkflow() { edit((m) => { rules(m).workflow = { initialState: 'draft', states: ['draft', 'submitted', 'approved', 'returned'], transitions: [
  { id: 'submit', label: '提交', from: 'draft', to: 'submitted', roles: ['admin', 'editor'] },
  { id: 'approve', label: '通过', from: 'submitted', to: 'approved', roles: ['admin'] },
  { id: 'return', label: '退回', from: 'submitted', to: 'returned', roles: ['admin'] },
] }; }); }
async function runPreview() {
  pending.value = true; preview.value = null; feedback.value = '';
  try {
    const result = await api.previewDesign(props.workbookId, props.modelValue, props.version, previewRole.value, previewRecordId.value || null);
    preview.value = result;
    feedback.value = `已从服务器保存的工作簿 v${result.sourceVersion} 提取测试数据；未写入业务库。`;
  } catch (error) { feedback.value = error.payload?.issues?.map((i) => `${i.path}：${i.message}`).join('\n') || error.message; }
  finally { pending.value = false; }
}
</script>

<template>
  <section class="design-card wide model-designer">
    <div class="card-title"><div><h2>业务数据模型与单元格绑定</h2><p>业务表用稳定字段标识建立关系；工作表和行号只负责版式。当前提供配置校验与数据提取预览。</p></div></div>
    <p v-if="!modelValue">此模板尚未启用结构化业务模型。旧版字段说明不等于数据库字段绑定。</p>
    <button v-if="!modelValue" class="primary-button" :disabled="disabled" @click="enable">启用业务数据模型</button>
    <fieldset v-else :disabled="disabled || pending" class="model-fieldset">
      <div class="model-toolbar"><strong>1. 业务表与字段</strong><button class="secondary-button small" :disabled="modelValue.entities.length >= 32" @click="addEntity">添加业务表</button></div>
      <label>共享数据空间（相同稳定标识表示复用业务实体；空白则隔离到当前模板）<input aria-label="共享数据空间" :value="modelValue.dataSpaceId || ''" placeholder="例如 shared_catalog" @change="edit((m) => { if ($event.target.value.trim()) m.dataSpaceId = $event.target.value.trim(); else delete m.dataSpaceId; })"></label>
      <p class="model-hint">字段标识自动生成，改显示名称不会改变关联。业务记录入口可选择有权访问的关联记录；自动带出、汇总和回写规则在下方统一配置。定点小数默认保留 2 位，按文本精确存储。</p>
      <details v-for="(table, e) in modelValue.entities" :key="table.id" class="entity-card" :open="table.id === modelValue.document.entityId">
        <summary>{{ table.label }} <small>{{ table.id }}</small></summary>
        <label>业务表名称<input :aria-label="`业务表名称 ${table.id}`" :value="table.label" @input="edit((m) => { m.entities[e].label = $event.target.value; })"></label>
        <label>稳定标识（跨模板共享记录时必须与基础资料模板一致，发布前可改）<input :aria-label="`业务表标识 ${table.id}`" :value="table.id" @change="edit((m) => { const next = $event.target.value.trim(); if (next && next !== table.id && !m.entities.some((item) => item.id === next)) renameEntity(m, table.id, next); })"></label>
        <div class="model-scroll"><table class="model-table"><thead><tr><th>显示名称 / 稳定标识</th><th>类型</th><th>必填</th><th>工作人员字段状态</th><th>只读人员字段状态</th><th>关联目标 / 选项</th><th>默认值</th><th>操作</th></tr></thead><tbody>
          <tr v-for="(field, f) in table.fields" :key="field.id">
            <td data-label="显示名称"><input :aria-label="`${table.id}.${field.id} 名称`" :value="field.label" @input="fieldChange(e, f, 'label', $event.target.value)"><div class="stable-id-row"><span>稳定标识</span><input class="field-id-input" :aria-label="`${table.id}.${field.id} 标识`" :value="field.id" @change="edit((m) => { const next = $event.target.value.trim(); if (next && next !== field.id && !m.entities[e].fields.some((item) => item.id === next)) renameField(m, m.entities[e], field.id, next); })"></div></td>
            <td data-label="字段类型"><select :aria-label="`${table.id}.${field.id} 类型`" :value="field.type" @change="fieldChange(e, f, 'type', $event.target.value)"><option v-for="type in FIELD_TYPES" :key="type" :value="type">{{ labels[type] }}</option></select></td>
            <td data-label="基础必填"><label class="required-toggle"><input :aria-label="`${table.id}.${field.id} 必填`" type="checkbox" :checked="field.required" @change="fieldChange(e, f, 'required', $event.target.checked)"><span>{{ field.required ? '必填' : '选填' }}</span></label></td>
            <td data-label="工作人员状态"><select :aria-label="`${table.id}.${field.id} 工作人员字段状态`" :value="policyState(table.id, field.id, 'editor')" @change="setPolicyState(table.id, field.id, 'editor', $event.target.value)"><option value="hidden">隐藏</option><option value="read">只读</option><option value="edit">可编辑</option><option value="required">必填</option></select></td>
            <td data-label="只读人员状态"><select :aria-label="`${table.id}.${field.id} 只读人员字段状态`" :value="policyState(table.id, field.id, 'viewer')" @change="setPolicyState(table.id, field.id, 'viewer', $event.target.value)"><option value="hidden">隐藏</option><option value="read">只读</option></select></td>
            <td data-label="关联目标 / 选项"><select v-if="field.type === 'reference'" :aria-label="`${table.id}.${field.id} 关联表`" :value="field.targetEntityId" @change="fieldChange(e, f, 'targetEntityId', $event.target.value)"><option value="">选择业务表</option><option v-for="target in modelValue.entities" :key="target.id" :value="target.id">{{ target.label }} ({{ target.id }})</option></select><input v-else-if="field.type === 'choice'" :aria-label="`${table.id}.${field.id} 选项`" :value="field.options?.join('，')" placeholder="用逗号分隔" @change="fieldChange(e, f, 'options', $event.target.value.split(/[,，]/).map((s) => s.trim()))"><span v-else class="empty-value">无需配置</span></td>
            <td data-label="默认值"><input v-if="field.type !== 'reference' && field.type !== 'boolean'" :aria-label="`${table.id}.${field.id} 默认值`" :value="field.defaultValue ?? ''" placeholder="可选" @change="fieldChange(e, f, 'defaultValue', $event.target.value.trim() === '' ? undefined : $event.target.value)"><span v-else class="empty-value">无需配置</span></td>
            <td class="field-actions"><button class="text-danger-button" @click="edit((m) => m.entities[e].fields.splice(f, 1))">删除</button></td>
          </tr>
        </tbody></table></div>
        <div class="model-toolbar"><button class="secondary-button small" :disabled="table.fields.length >= 64" @click="addField(e)">添加字段</button><button v-if="table.id !== modelValue.document.entityId" class="secondary-button small" @click="edit((m) => m.entities.splice(e, 1))">移除此业务表</button></div>
      </details>

      <div class="model-toolbar"><strong>2. 主表单元格</strong><button class="secondary-button small" @click="addBinding">添加主表绑定</button></div>
      <label>主表（切换会清空当前绑定，不删除业务表定义）<select aria-label="单据主表" :value="modelValue.document.entityId" @change="mainChange($event.target.value)"><option v-for="table in modelValue.entities" :key="table.id" :value="table.id">{{ table.label }} ({{ table.id }})</option></select></label>
      <label>记录可见范围<select aria-label="记录可见范围" :value="modelValue.recordScope || 'own'" @change="edit((m) => { if ($event.target.value === 'all') m.recordScope = 'all'; else delete m.recordScope; })"><option value="own">仅本人（每人只看自己创建的记录）</option><option value="all">同模板协作（编辑者可查看和编辑全部记录）</option></select></label>
      <div v-for="(binding, b) in modelValue.document.fields" :key="b" class="binding-row">
        <label>主表字段<select :aria-label="`主表字段 ${b + 1}`" :value="binding.fieldId" @change="bindingChange(b, 'fieldId', $event.target.value)"><option value="">选择字段</option><option v-for="field in main?.fields" :key="field.id" :value="field.id">{{ field.label }} ({{ field.id }})</option></select></label>
        <label>工作表<select :aria-label="`主表工作表 ${b + 1}`" :value="binding.sheetId" @change="bindingChange(b, 'sheetId', $event.target.value)"><option v-for="sheet in sheets" :key="sheet.id" :value="sheet.id">{{ sheet.name }}</option></select></label>
        <label>单元格<input :aria-label="`主表单元格 ${b + 1}`" :value="binding.cell" placeholder="例如 B3" @input="bindingChange(b, 'cell', $event.target.value.toUpperCase())"></label>
        <button class="secondary-button small" @click="edit((m) => m.document.fields.splice(b, 1))">移除绑定</button>
      </div>

      <div class="model-toolbar"><strong>3. 主从明细区域</strong><button class="secondary-button small" :disabled="modelValue.document.details.length >= 8 || modelValue.entities.length >= 32" @click="addDetail">添加明细区域及业务表</button></div>
      <p class="model-hint">自动创建指向主表的关联字段。空明细行跳过；所属主单据由后续保存服务维护，不能手工绑定。暂不支持无限扩行。</p>
      <div v-for="(detail, d) in modelValue.document.details" :key="detail.id" class="entity-card">
        <div class="model-toolbar"><strong>{{ entity(detail.entityId)?.label || '目标表已删除' }} · {{ detail.id }}</strong><button class="secondary-button small" @click="edit((m) => m.document.details.splice(d, 1))">移除区域（保留表定义）</button></div>
        <p class="model-hint">关系：{{ detail.entityId }}.{{ detail.parentFieldId }} → {{ modelValue.document.entityId }}</p>
        <div class="binding-row">
          <label>工作表<select :aria-label="`明细工作表 ${d + 1}`" :value="detail.sheetId" @change="detailChange(d, 'sheetId', $event.target.value)"><option v-for="sheet in sheets" :key="sheet.id" :value="sheet.id">{{ sheet.name }}</option></select></label>
          <label>起始行<input :aria-label="`明细起始行 ${d + 1}`" type="number" min="1" :value="detail.startRow" @input="detailChange(d, 'startRow', Number($event.target.value))"></label>
          <label>预留行数<input :aria-label="`明细预留行数 ${d + 1}`" type="number" min="1" max="1000" :value="detail.rowCount" @input="detailChange(d, 'rowCount', Number($event.target.value))"></label>
        </div>
        <div v-for="(binding, b) in detail.columns" :key="b" class="binding-row">
          <label>明细字段<select :aria-label="`明细字段 ${d + 1}-${b + 1}`" :value="binding.fieldId" @change="edit((m) => { m.document.details[d].columns[b].fieldId = $event.target.value; })"><option value="">选择字段</option><option v-for="field in entity(detail.entityId)?.fields.filter((f) => f.id !== detail.parentFieldId)" :key="field.id" :value="field.id">{{ field.label }}</option></select></label>
          <label>绑定列<input :aria-label="`明细列 ${d + 1}-${b + 1}`" :value="binding.column" placeholder="例如 A" @input="edit((m) => { m.document.details[d].columns[b].column = $event.target.value.toUpperCase(); })"></label>
          <button class="secondary-button small" @click="edit((m) => m.document.details[d].columns.splice(b, 1))">移除列</button>
        </div>
        <button class="secondary-button small" @click="edit((m) => m.document.details[d].columns.push({ fieldId: '', column: '' }))">添加明细列</button>
      </div>

      <div class="model-toolbar"><strong>4. 关联、计算与汇总规则</strong><div><button class="secondary-button small" @click="addLookup">添加关联取数</button> <button class="secondary-button small" @click="addCalculation">添加服务端求和</button> <button class="secondary-button small" @click="addAggregate">添加汇总</button></div></div>
      <p class="model-hint">关联选择保存稳定记录 ID；快照取数在保存时固定，实时取数在每次打开时刷新显示。服务端求和会覆盖浏览器提交的目标值。</p>
      <div v-for="(rule, i) in (modelValue.rules?.lookups || [])" :key="rule.id" class="binding-row">
        <label>来源表<select :value="rule.entityId" @change="edit((m) => m.rules.lookups[i].entityId = $event.target.value)"><option v-for="table in modelValue.entities" :value="table.id">{{ table.label }}</option></select></label>
        <label>关联字段<select :value="rule.referenceFieldId" @change="edit((m) => m.rules.lookups[i].referenceFieldId = $event.target.value)"><option value="">请选择</option><option v-for="field in entity(rule.entityId)?.fields.filter((f) => f.type === 'reference')" :value="field.id">{{ field.label }}</option></select></label>
        <label>目标字段<input :value="rule.targetFieldId" placeholder="目标稳定字段标识" @input="edit((m) => m.rules.lookups[i].targetFieldId = $event.target.value)"></label>
        <label>写入字段<select :value="rule.destinationFieldId" @change="edit((m) => m.rules.lookups[i].destinationFieldId = $event.target.value)"><option value="">请选择</option><option v-for="field in entity(rule.entityId)?.fields" :value="field.id">{{ field.label }}</option></select></label>
        <label>策略<select :value="rule.strategy" @change="edit((m) => m.rules.lookups[i].strategy = $event.target.value)"><option value="snapshot">保存快照</option><option value="live">实时刷新</option></select></label>
        <label>筛选字段<select :aria-label="`关联取数筛选字段 ${i + 1}`" :value="rule.filterFieldId || ''" @change="edit((m) => { if ($event.target.value) m.rules.lookups[i].filterFieldId = $event.target.value; else { delete m.rules.lookups[i].filterFieldId; delete m.rules.lookups[i].filterValue; } })"><option value="">不限</option><option v-for="field in lookupTargetFields(modelValue, rule)" :key="field.id" :value="field.id">{{ field.label }}</option></select></label>
        <label v-if="rule.filterFieldId">筛选值<input :aria-label="`关联取数筛选值 ${i + 1}`" :value="rule.filterValue ?? ''" placeholder="目标字段须等于此值" @input="edit((m) => m.rules.lookups[i].filterValue = $event.target.value)"></label>
        <button class="secondary-button small" @click="edit((m) => m.rules.lookups.splice(i, 1))">移除</button>
      </div>
      <div v-for="(rule, i) in (modelValue.rules?.calculations || [])" :key="rule.id" class="binding-row">
        <label>明细区域<select :value="rule.detailId" @change="edit((m) => m.rules.calculations[i].detailId = $event.target.value)"><option v-for="detail in modelValue.document.details" :value="detail.id">{{ detail.id }}</option></select></label>
        <label>求和字段<input :value="rule.sourceFieldId" placeholder="明细稳定字段标识" @input="edit((m) => m.rules.calculations[i].sourceFieldId = $event.target.value)"></label>
        <label>结果字段<select :value="rule.destinationFieldId" @change="edit((m) => m.rules.calculations[i].destinationFieldId = $event.target.value)"><option value="">请选择</option><option v-for="field in main?.fields.filter((f) => ['number','decimal'].includes(f.type))" :value="field.id">{{ field.label }}</option></select></label>
        <button class="secondary-button small" @click="edit((m) => m.rules.calculations.splice(i, 1))">移除</button>
      </div>
      <div v-for="(rule, i) in (modelValue.rules?.aggregates || [])" :key="rule.id" class="binding-row">
        <label>汇总名称<input :value="rule.label" @input="edit((m) => m.rules.aggregates[i].label = $event.target.value)"></label>
        <label>业务表<select :value="rule.entityId" @change="edit((m) => m.rules.aggregates[i].entityId = $event.target.value)"><option v-for="table in modelValue.entities" :value="table.id">{{ table.label }}</option></select></label>
        <label>运算<select :value="rule.operation" @change="edit((m) => m.rules.aggregates[i].operation = $event.target.value)"><option value="count">计数</option><option value="sum">求和</option></select></label>
        <label>数值字段<input :value="rule.fieldId" placeholder="求和时填写" @input="edit((m) => m.rules.aggregates[i].fieldId = $event.target.value)"></label>
        <label>分组字段<input :value="rule.groupByFieldId" placeholder="可选" @input="edit((m) => m.rules.aggregates[i].groupByFieldId = $event.target.value)"></label>
        <button class="secondary-button small" @click="edit((m) => m.rules.aggregates.splice(i, 1))">移除</button>
      </div>

      <div class="model-toolbar"><strong>5. 简单审批流程</strong><button v-if="!modelValue.rules?.workflow" class="secondary-button small" @click="enableWorkflow">启用提交/通过/退回</button><button v-else class="secondary-button small" @click="edit((m) => delete m.rules.workflow)">停用流程</button></div>
      <p v-if="modelValue.rules?.workflow" class="model-hint">已配置状态：{{ modelValue.rules.workflow.states.join(' → ') }}。提交允许管理员和工作人员，通过/退回仅允许管理员；可为转换配置一条受控回写。</p>
      <div v-if="modelValue.rules?.workflow" v-for="(transition, t) in modelValue.rules.workflow.transitions" :key="transition.id" class="binding-row">
        <label>转换 {{ transition.label }}（{{ transition.from }} → {{ transition.to }}）<select :aria-label="`回写关联字段 ${t + 1}`" :value="transition.writeback?.referenceFieldId || ''" @change="edit((m) => { const rule = m.rules.workflow.transitions[t]; if ($event.target.value) rule.writeback = { referenceFieldId: $event.target.value, targetFieldId: '', value: rule.writeback?.value ?? '' }; else delete rule.writeback; })"><option value="">不回写</option><option v-for="field in mainReferenceFields(modelValue)" :key="field.id" :value="field.id">{{ field.label }}</option></select></label>
        <template v-if="transition.writeback?.referenceFieldId">
          <label>回写目标字段<select :aria-label="`回写目标字段 ${t + 1}`" :value="transition.writeback.targetFieldId" @change="edit((m) => m.rules.workflow.transitions[t].writeback.targetFieldId = $event.target.value)"><option value="">选择字段</option><option v-for="field in lookupTargetFields(modelValue, { entityId: modelValue.document.entityId, referenceFieldId: transition.writeback.referenceFieldId })" :key="field.id" :value="field.id">{{ field.label }}</option></select></label>
          <label>回写值<input :aria-label="`回写值 ${t + 1}`" :value="transition.writeback.value ?? ''" placeholder="写入目标记录的固定值" @input="edit((m) => m.rules.workflow.transitions[t].writeback.value = $event.target.value)"></label>
        </template>
      </div>

      <div class="model-check" role="status"><strong>{{ report.valid ? '模型和绑定校验通过' : '请先修正模型和绑定' }}</strong><ul v-if="!report.valid"><li v-for="(issue, index) in report.issues" :key="index">{{ issue.path }}：{{ issue.message }}</li></ul></div>
      <div class="model-check formula-compatibility" role="status"><strong>公式兼容检查：{{ formulaReport.supported }} 个支持，{{ formulaReport.unsupported }} 个阻断发布</strong><ul v-if="formulaReport.unsupported"><li v-for="formula in formulaReport.formulas.filter((item) => !item.supported)" :key="`${formula.sheetId}:${formula.address}`">{{ formula.sheetId }}!{{ formula.address }}：{{ formula.reasons.join('；') }}</li></ul></div>
      <p class="model-hint">提取预览读取服务器已保存的表格，不包含工作区尚未保存的编辑。日期输入 YYYY-MM-DD；公式格不可作输入绑定。关联使用稳定记录 ID，因此数据库主键保证不会出现多匹配；预览会区分无匹配和权限不足。</p>
      <label>模拟关联权限角色<select aria-label="模拟关联权限角色" v-model="previewRole"><option value="admin">管理员</option><option value="editor">工作人员</option><option value="viewer">只读人员</option></select></label>
      <label v-if="previewRecords.length">测试数据<select aria-label="关系预览测试记录" v-model="previewRecordId"><option value="">使用模板中保存的测试值</option><option v-for="record in previewRecords" :key="record.id" :value="record.id">{{ Object.values(record.values).filter((value) => value != null).slice(0, 2).join(' · ') }} · {{ record.id.slice(0, 8) }}</option></select></label>
      <button class="primary-button" :disabled="!report.valid || pending" @click="runPreview">{{ pending ? '校验中…' : '校验并提取测试数据' }}</button>
      <p class="model-feedback" role="status">{{ feedback }}</p>
      <div v-if="preview?.relationPreview?.length" class="model-check"><strong>关联异常预览（{{ preview.previewRole }}）</strong><ul><li v-for="item in preview.relationPreview" :key="`${item.entityId}:${item.fieldId}:${item.targetId}`">{{ item.entityId }}.{{ item.fieldId }} → {{ item.targetId || '空值' }}：{{ ({ matched: '匹配且有权', 'no-match': '无匹配', 'permission-denied': '权限不足', empty: '未填写' })[item.status] }}；稳定 ID 唯一，不会多匹配</li></ul></div>
      <pre v-if="preview" class="model-preview">{{ JSON.stringify(preview.record, null, 2) }}</pre>
    </fieldset>
  </section>
</template>

<style scoped>
.model-fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.model-toolbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin: 18px 0 12px; }
.model-hint, .model-designer small { color: #607089; font-size: 12px; line-height: 1.7; }
.entity-card { border: 1px solid #dbe3ed; border-radius: 12px; padding: 16px; margin: 12px 0; background: #fbfcfe; }
.entity-card summary { cursor: pointer; font-weight: 750; margin: -4px 0; padding: 4px 0; color: #263b54; }
.entity-card[open] summary { margin-bottom: 14px; }
.entity-card summary small { margin-left: 6px; padding: 3px 7px; border-radius: 5px; background: #edf2f7; font-weight: 600; }
.model-scroll { overflow: visible; }
.model-table, .model-table tbody, .model-table tr, .model-table td { display: block; width: 100%; }
.model-table { border-collapse: collapse; text-align: left; }
.model-table thead { display: none; }
.model-table tbody { display: grid; gap: 10px; }
.model-table tr { display: grid; grid-template-columns: minmax(230px, 1.45fr) repeat(3, minmax(140px, 1fr)) 70px; gap: 12px; padding: 14px; border: 1px solid #dfe7f0; border-radius: 10px; background: white; }
.model-table td { min-width: 0; padding: 0; vertical-align: top; }
.model-table td::before { content: attr(data-label); display: block; margin-bottom: 6px; color: #6c7c91; font-size: 11px; font-weight: 750; }
.model-table td:nth-child(1) { grid-column: 1; grid-row: 1 / span 2; }
.model-table td:nth-child(2) { grid-column: 2; grid-row: 1; }
.model-table td:nth-child(3) { grid-column: 3; grid-row: 1; }
.model-table td:nth-child(4) { grid-column: 4; grid-row: 1; }
.model-table td:nth-child(5) { grid-column: 2; grid-row: 2; }
.model-table td:nth-child(6) { grid-column: 3; grid-row: 2; }
.model-table td:nth-child(7) { grid-column: 4; grid-row: 2; }
.model-table td.field-actions { grid-column: 5; grid-row: 1; display: flex; justify-content: flex-end; align-items: flex-start; }
.model-table td.field-actions::before { display: none; }
.model-table input:not([type=checkbox]), .model-table select { width: 100%; min-width: 0; }
.stable-id-row { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 8px; margin-top: 8px; }
.stable-id-row span { color: #718096; font-size: 11px; white-space: nowrap; }
.field-id-input { height: 34px; font-size: 11px; color: #4a5a72; background: #f7f9fc; }
.required-toggle { display: flex; align-items: center; gap: 8px; min-height: 42px; color: #40546c; font-weight: 650; }
.required-toggle input { width: 18px; height: 18px; accent-color: #2877c7; }
.empty-value { display: flex; align-items: center; height: 42px; color: #98a4b4; font-size: 12px; }
.text-danger-button { padding: 7px 9px; border: 0; border-radius: 7px; color: #a73d49; background: #fff0f1; font-size: 12px; font-weight: 700; }
.text-danger-button:hover { color: white; background: #c54a56; }
.binding-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)) auto; gap: 12px; align-items: end; margin-bottom: 10px; padding: 12px; border: 1px solid #e1e8f0; border-radius: 10px; background: #fafbfd; }
.binding-row label { min-width: 0; margin: 0; }
.binding-row > button { min-height: 38px; margin-bottom: 1px; }
.model-check { margin-top: 20px; padding: 12px; background: #f1f5fa; border-radius: 8px; }
.model-check ul { max-height: 200px; overflow: auto; padding-left: 20px; font-size: 12px; }
.model-feedback { white-space: pre-wrap; font-size: 13px; }
.model-preview { max-height: 360px; overflow: auto; padding: 16px; background: #142033; color: #e8f2ff; border-radius: 8px; font-size: 12px; }
@media (max-width: 1180px) {
  .model-table tr { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .model-table td:nth-child(n) { grid-column: auto; grid-row: auto; }
  .model-table td:nth-child(1) { grid-column: 1 / -1; }
  .model-table td.field-actions { grid-column: 2; grid-row: 4; }
}
@media (max-width: 620px) {
  .model-table tr { grid-template-columns: 1fr; }
  .model-table td:nth-child(n), .model-table td.field-actions { grid-column: auto; grid-row: auto; }
  .model-table td.field-actions { justify-content: flex-start; }
  .binding-row { grid-template-columns: 1fr; }
}
</style>
