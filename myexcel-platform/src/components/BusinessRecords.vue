<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/presets/preset-sheets-core';
import sheetsCoreZhCN from '@univerjs/presets/preset-sheets-core/locales/zh-CN';
import '@univerjs/presets/lib/styles/preset-sheets-core.css';
import { api } from '../api.js';
import { cellPosition, extractBusinessRecord, fieldState, prepareBusinessInputSnapshot } from '../../shared/business-model.mjs';
import { detailRowIdentities, newRecordDraft } from '../../shared/record-editor.mjs';

const props = defineProps({ workbookId: String, canDesign: Boolean });
const emit = defineEmits(['edit-template']);
const sheetContainer = ref(null);
const template = shallowRef(null), entryModel = shallowRef(null), rows = ref([]), offset = ref(0), form = shallowRef(null);
const busy = ref(false), dirty = ref(false), message = ref(''), permission = ref(false), scope = ref('own'), role = ref('viewer');
const referenceOptions = ref({}), summaries = ref([]), recordAudit = ref([]);
const gridReady = ref(false);
const gridCard = ref(null);
const filters = ref({ dateFieldId: '', dateFrom: '', dateTo: '', workflowState: '' }), lastRefreshed = ref('');
let univer, univerAPI, facadeWorkbook, beforeChangeDisposable, changeDisposable, pendingRequest, detailRowIds = {}, editRevision = 0, refreshTimer;
const model = computed(() => entryModel.value || template.value?.model);
const canSave = computed(() => permission.value && form.value && gridReady.value && !busy.value);
const workflowActions = computed(() => (model.value?.rules?.workflow?.transitions || []).filter((item) => item.from === (form.value?.workflowState || model.value?.rules?.workflow?.initialState) && item.roles.includes(role.value)));
const workflowStateLabels = { draft: '草稿', submitted: '待审批', approved: '已通过', returned: '已退回' };
const workflowStates = computed(() => (model.value?.rules?.workflow?.states || []).map((state) => (
  typeof state === 'string' ? { id: state, label: workflowStateLabels[state] || state } : state
)));
const dateFilterFields = computed(() => {
  const entity = model.value?.entities.find((item) => item.id === model.value?.document.entityId);
  return (model.value?.document.fields || []).map((binding) => ({ binding, field: entity?.fields.find((field) => field.id === binding.fieldId) }))
    .filter((item) => item.field?.type === 'date' && fieldState(model.value, model.value.document.entityId, item.field.id, role.value) !== 'hidden');
});
const scopeMessage = computed(() => permission.value
  ? (scope.value === 'all' ? '本应用记录在编辑者之间共享。' : '当前只显示本人创建的记录。')
  : (scope.value === 'all' ? '当前为只读访问，可查看此应用的共享记录。' : '当前为只读访问，且此应用按创建人隔离记录。'));
const emptyListMessage = computed(() => !permission.value && scope.value === 'own'
  ? '只读账号没有可查看的自有记录'
  : '此页暂无有权访问的记录');
const referenceInputs = computed(() => {
  if (!model.value) return [];
  const fields = new Map(model.value.entities.flatMap((entity) => entity.fields.map((field) => [`${entity.id}:${field.id}`, field])));
  const result = model.value.document.fields.map((binding) => ({ ...binding, entityId: model.value.document.entityId, field: fields.get(`${model.value.document.entityId}:${binding.fieldId}`), rowOffset: null }));
  for (const detail of model.value.document.details) for (let rowOffset = 0; rowOffset < detail.rowCount; rowOffset++) for (const binding of detail.columns) result.push({ ...binding, sheetId: detail.sheetId, cell: `${binding.column}${detail.startRow + rowOffset}`, entityId: detail.entityId, field: fields.get(`${detail.entityId}:${binding.fieldId}`), rowOffset });
  return result.filter((item) => item.field?.type === 'reference' && ['edit', 'required'].includes(fieldState(model.value, item.entityId, item.field.id, role.value)));
});
const mainReferenceInputs = computed(() => referenceInputs.value.filter((item) => item.rowOffset == null));
const detailReferenceInputs = computed(() => referenceInputs.value.filter((item) => item.rowOffset != null));

function mayLeave() {
  if (busy.value) { message.value = '正在处理，请完成后再切换。'; return false; }
  return !dirty.value || window.confirm('业务记录尚未保存，确认放弃本次修改吗？');
}
function recordTitle(row) {
  const visible = Object.values(row.values || {}).filter((value) => value !== null && value !== undefined && value !== '');
  return visible.slice(0, 2).join(' · ') || '未命名记录';
}
function summaryGroupLabel(summary, group) {
  const field = model.value?.entities.find((entity) => entity.id === summary.groupEntityId)?.fields.find((item) => item.id === summary.groupByFieldId);
  if (field?.type === 'reference') {
    const target = referenceOptions.value[field.targetEntityId]?.find((item) => item.id === group);
    if (target) return Object.values(target.values || {}).filter((value) => value).slice(0, 2).join(' · ') || '关联资料';
  }
  return group?.length > 12 ? `${group.slice(0, 8)}…` : (group || '未分组');
}
function referenceLabel(option) {
  return Object.values(option.values || {}).filter((value) => value !== null && value !== undefined && value !== '').slice(0, 2).join(' · ') || `记录 ${option.id.slice(0, 8)}`;
}
function workflowStateLabel(state) { return workflowStates.value.find((item) => item.id === state)?.label || workflowStateLabels[state] || state || '未启用'; }
async function revealGrid() {
  await nextTick();
  const card = gridCard.value;
  const scroller = card?.closest?.('.workspace-main');
  if (!card || !scroller) return;
  scroller.scrollTop += card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
}
defineExpose({ mayLeave, busy });
function beforeUnload(event) { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = ''; } }

onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload);
  await load();
  await nextTick();
  const created = createUniver({
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: mergeLocales(sheetsCoreZhCN) },
    presets: [UniverSheetsCorePreset({ container: sheetContainer.value })],
  });
  univer = created.univer;
  univerAPI = created.univerAPI;
  refreshTimer = setInterval(() => { void refreshRuntime(true); }, 30000);
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  clearInterval(refreshTimer);
  disposeGrid();
  univerAPI?.dispose?.();
  univer?.dispose?.();
});

function disposeGrid() {
  beforeChangeDisposable?.dispose?.();
  changeDisposable?.dispose?.();
  beforeChangeDisposable = changeDisposable = null;
  if (facadeWorkbook) univerAPI?.disposeUnit?.(facadeWorkbook.getId());
  facadeWorkbook = null;
  gridReady.value = false;
}

function inputCellMap(currentModel) {
  const result = new Map();
  const add = (entityId, fieldId, sheetId, address) => {
    if (!['edit', 'required'].includes(fieldState(currentModel, entityId, fieldId, role.value))) return;
    const { row, col } = cellPosition(address);
    if (!result.has(sheetId)) result.set(sheetId, new Set());
    result.get(sheetId).add(`${row}:${col}`);
  };
  for (const binding of currentModel.document.fields) add(currentModel.document.entityId, binding.fieldId, binding.sheetId, binding.cell);
  for (const detail of currentModel.document.details) for (const binding of detail.columns) {
    for (let row = detail.startRow; row < detail.startRow + detail.rowCount; row++) add(detail.entityId, binding.fieldId, detail.sheetId, `${binding.column}${row}`);
  }
  return result;
}

function isFormulaUpdate(event) { return event?.options?.onlyLocal && event?.options?.fromFormula; }
function changedCellsAreInputs(event, inputCells) {
  const allowed = inputCells.get(event?.params?.subUnitId);
  const values = event?.params?.cellValue;
  if (!allowed || !values || typeof values !== 'object') return false;
  const positions = [];
  for (const [row, columns] of Object.entries(values)) for (const col of Object.keys(columns || {})) positions.push(`${Number(row)}:${Number(col)}`);
  return positions.length > 0 && positions.every((position) => allowed.has(position));
}
async function openGrid(snapshot, { clearValues = false, rowIds = {} } = {}) {
  disposeGrid();
  const prepared = prepareBusinessInputSnapshot(model.value, snapshot, { clearValues });
  facadeWorkbook = univerAPI.createWorkbook(prepared);
  gridReady.value = true;
  detailRowIds = rowIds;
  dirty.value = false;
  editRevision = 0;
  if (!permission.value) await facadeWorkbook.getWorkbookPermission().setMode('viewer');
  const workbookId = facadeWorkbook.getId();
  const inputCells = inputCellMap(model.value);
  const setRangeValues = univerAPI.Enum?.SheetValueChangeType?.SET_RANGE_VALUES || 'sheet.mutation.set-range-values';
  const protectedChanges = new Set([
    ...Object.values(univerAPI.Enum?.SheetValueChangeType || {}),
    ...Object.values(univerAPI.Enum?.SheetSkeletonChangeType || {}),
  ]);
  const beforeEvent = univerAPI.Event?.BeforeCommandExecute;
  if (permission.value && beforeEvent) beforeChangeDisposable = univerAPI.addEvent(beforeEvent, (event) => {
    if (!protectedChanges.has(event?.id) || event?.params?.unitId !== workbookId || isFormulaUpdate(event)) return;
    if (event.id === setRangeValues && changedCellsAreInputs(event, inputCells)) return;
    event.cancel = true;
    message.value = '发布模板版式固定；只能填写当前角色可编辑的已绑定业务单元格。';
  });
  const afterEvent = univerAPI.Event?.CommandExecuted;
  if (permission.value && afterEvent) changeDisposable = univerAPI.addEvent(afterEvent, (event) => {
    if (event?.id !== setRangeValues || event?.params?.unitId !== workbookId || isFormulaUpdate(event) || !changedCellsAreInputs(event, inputCells)) return;
    editRevision++;
    dirty.value = true;
    message.value = '有未保存的业务数据修改。';
  });
}

async function load() {
  busy.value = true;
  try {
    const result = await api.runtimeSchema(props.workbookId);
    template.value = result.template;
    permission.value = result.canWrite;
    scope.value = result.recordScope;
    role.value = result.role;
    await loadRuntimeHelpers();
    await list();
  } catch (error) { message.value = error.message; }
  finally { busy.value = false; }
}
async function loadRuntimeHelpers() {
  if (!api.referenceRecords || !api.runtimeSummary) return;
  const targets = [...new Set(model.value.entities.flatMap((entity) => entity.fields.filter((field) => field.type === 'reference').map((field) => field.targetEntityId)))];
  const options = await Promise.all(targets.map(async (target) => [target, (await api.referenceRecords(props.workbookId, target)).records]));
  referenceOptions.value = Object.fromEntries(options);
  summaries.value = (await api.runtimeSummary(props.workbookId)).summaries;
}
async function list(nextOffset = offset.value) {
  const result = await api.listRecords(props.workbookId, nextOffset, filters.value);
  rows.value = result.records;
  offset.value = nextOffset;
}
async function page(delta) {
  if (busy.value) return;
  busy.value = true;
  const target = Math.max(0, offset.value + delta);
  try {
    await list(target);
    message.value = '';
  } catch (error) { message.value = `翻页失败，仍停留在当前页：${error.message}`; }
  finally { busy.value = false; }
}
async function applyFilters() {
  if (busy.value) return;
  busy.value = true;
  try { await list(0); lastRefreshed.value = new Date().toLocaleTimeString(); message.value = '已按当前条件刷新记录列表。'; }
  catch (error) { message.value = `筛选失败：${error.message}`; }
  finally { busy.value = false; }
}
async function refreshRuntime(automatic = false) {
  if (busy.value || dirty.value) {
    if (!automatic && dirty.value) message.value = '当前表格有未保存修改，已跳过刷新以保护正在编辑的内容。';
    return;
  }
  busy.value = true;
  try {
    await Promise.all([list(), loadRuntimeHelpers()]);
    lastRefreshed.value = new Date().toLocaleTimeString();
    if (!automatic) message.value = '记录列表、关联资料和汇总已刷新。';
  } catch (error) { if (!automatic) message.value = `刷新失败：${error.message}`; }
  finally { busy.value = false; }
}
function auditLabel(action) {
  if (action === 'create') return '创建记录';
  if (action === 'update') return '更新记录';
  if (action === 'workflow_writeback') return '流程受控回写';
  return action?.startsWith('workflow:') ? `流程：${action.slice('workflow:'.length)}` : action;
}
function auditTime(value) { return value ? new Date(value).toLocaleString() : '时间未知'; }
async function newRecord() {
  if (!mayLeave() || !template.value) return;
  busy.value = true;
  try {
    entryModel.value = template.value.model;
    form.value = newRecordDraft(model.value, template.value.version);
    pendingRequest = null;
    recordAudit.value = [];
    await openGrid(template.value.snapshot, { clearValues: true });
    message.value = '已按当前发布模板新建空白业务记录。';
  } catch (error) { message.value = `无法新建业务记录：${error.message}`; }
  finally { busy.value = false; if (form.value) await revealGrid(); }
}
async function open(id) {
  if (!mayLeave()) return;
  busy.value = true;
  try {
    const result = await api.getRecord(props.workbookId, id);
    form.value = result.record;
    entryModel.value = result.release.model;
    pendingRequest = null;
    recordAudit.value = api.getRecordAudit ? (await api.getRecordAudit(props.workbookId, id)).audit : [];
    await openGrid(result.snapshot, { rowIds: detailRowIdentities(model.value, result.record) });
    message.value = `已打开业务记录 v${result.record.version}，使用模板 v${result.record.templateVersion}`;
  } catch (error) { message.value = error.message; }
  finally { busy.value = false; if (form.value) await revealGrid(); }
}
async function setGridValue(sheetId, address, value) {
  await facadeWorkbook.getSheetBySheetId(sheetId).getRange(address).setValue(value ?? null);
}
async function chooseReference(input, targetId) {
  const target = referenceOptions.value[input.field.targetEntityId]?.find((item) => item.id === targetId);
  if (!target) { message.value = '关联资料不存在、已停用或无权访问。'; return; }
  await setGridValue(input.sheetId, input.cell, target.id);
  for (const rule of model.value.rules?.lookups || []) if (rule.entityId === input.entityId && rule.referenceFieldId === input.fieldId) {
    const binding = input.rowOffset == null
      ? model.value.document.fields.find((item) => item.fieldId === rule.destinationFieldId)
      : model.value.document.details.find((item) => item.entityId === input.entityId)?.columns.find((item) => item.fieldId === rule.destinationFieldId);
    if (binding) await setGridValue(binding.sheetId || input.sheetId, input.rowOffset == null ? binding.cell : `${binding.column}${model.value.document.details.find((item) => item.entityId === input.entityId).startRow + input.rowOffset}`, target.values[rule.targetFieldId]);
  }
  message.value = `已选择关联资料 ${Object.values(target.values).filter(Boolean)[0] || target.id.slice(0, 8)}，保存时服务端会再次校验并复算。`;
}
async function transition(action) {
  if (!form.value?.id || busy.value) return;
  busy.value = true;
  try {
    const result = await api.transitionRecord(props.workbookId, form.value.id, { transitionId: action.id, expectedVersion: form.value.version, requestId: crypto.randomUUID() });
    form.value = result.record; entryModel.value = result.release.model;
    await openGrid(result.snapshot, { rowIds: detailRowIdentities(model.value, result.record) });
    recordAudit.value = (await api.getRecordAudit(props.workbookId, form.value.id)).audit;
    message.value = `流程已${action.label}，当前状态：${workflowStateLabel(form.value.workflowState)}`; await list();
  } catch (error) { message.value = `流程操作失败：${error.message}`; }
  finally { busy.value = false; }
}
async function save() {
  if (!canSave.value) return;
  busy.value = true;
  message.value = '';
  try {
    const savedRevision = editRevision;
    const snapshot = await facadeWorkbook.save();
    const record = extractBusinessRecord(model.value, snapshot, { detailRowIds, coerceGridDecimals: true });
    const payload = { templateVersion: form.value.templateVersion, expectedVersion: form.value.version, record };
    const signature = JSON.stringify(payload);
    if (!pendingRequest || pendingRequest.signature !== signature) pendingRequest = { signature, id: crypto.randomUUID() };
    const saved = await api.saveRecord(props.workbookId, form.value.id, { ...payload, requestId: pendingRequest.id });
    form.value = saved.record;
    entryModel.value = saved.release.model;
    detailRowIds = detailRowIdentities(model.value, saved.record);
    pendingRequest = null;
    const savedText = `${saved.replayed ? '已确认上次保存结果' : '已保存到 MySQL'} · 业务记录 v${saved.record.version}（模板未被修改）`;
    if (editRevision === savedRevision) {
      await openGrid(saved.snapshot, { rowIds: detailRowIds });
      message.value = savedText;
    } else {
      dirty.value = true;
      message.value = `${savedText}；保存期间的新修改仍保留为未保存。`;
    }
    try { await list(); }
    catch (error) { message.value += `；记录已保存，但列表刷新失败：${error.message}`; }
  } catch (error) { message.value = `未确认保存成功：${error.message}。表格内容保留，可修改或重试。`; }
  finally { busy.value = false; }
}
function exportRecord() { if (form.value?.id && !dirty.value) window.location.href = api.recordExportUrl(props.workbookId, form.value.id); }
</script>

<template>
  <div class="record-page">
    <div class="record-heading record-page-title">
      <div><span class="section-kicker">工作人员端 / 业务记录</span><h1>{{ template?.name || '业务记录' }}</h1><p>数据保存到 MySQL，发布模板和历史版式不会随填报改变。{{ scopeMessage }}</p></div>
      <div class="record-actions"><button v-if="canDesign" class="secondary-button" :disabled="busy" @click="mayLeave() && emit('edit-template')">编辑模板版式</button><button v-if="permission" class="primary-button" :disabled="busy || !template" @click="newRecord">新建业务记录</button></div>
    </div>
    <p class="record-note">{{ permission ? '在原模板填写或批量粘贴；保存时系统会复核关联资料和关键计算。' : '只读模式仅展示有权访问的发布数据，不提供新建、修改或保存。' }}</p>
    <p v-if="message" role="status" class="record-message">{{ message }}</p>
    <div v-if="template" class="record-layout">
      <aside class="record-list"><div class="record-list-title"><h2>已保存记录</h2><span title="当前页记录数">本页 {{ rows.length }}</span></div><div class="record-filters"><label>日期字段<select v-model="filters.dateFieldId"><option value="">不按日期筛选</option><option v-for="item in dateFilterFields" :key="item.field.id" :value="item.field.id">{{ item.field.label }}</option></select></label><label>开始日期<input v-model="filters.dateFrom" :disabled="!filters.dateFieldId" type="date"></label><label>结束日期<input v-model="filters.dateTo" :disabled="!filters.dateFieldId" type="date"></label><label v-if="workflowStates.length">流程状态<select v-model="filters.workflowState"><option value="">全部状态</option><option v-for="state in workflowStates" :key="state.id" :value="state.id">{{ state.label || state.id }}</option></select></label><div class="filter-actions"><button class="secondary-button small" :disabled="busy" @click="applyFilters">应用筛选</button><button class="secondary-button small" :disabled="busy" @click="refreshRuntime(false)">刷新</button></div><small v-if="lastRefreshed">更新于 {{ lastRefreshed }}</small></div><button v-for="row in rows" :key="row.id" :class="{ active: form?.id === row.id }" :disabled="busy" @click="open(row.id)"><strong>{{ recordTitle(row) }}</strong><small>记录 {{ row.id.slice(0, 8) }} · 版本 {{ row.version }}<template v-if="row.workflowState"> · {{ workflowStateLabel(row.workflowState) }}</template></small></button><p v-if="!rows.length">{{ emptyListMessage }}</p><div class="record-paging"><button class="secondary-button small" :disabled="offset === 0 || busy" @click="page(-30)">上一页</button><button class="secondary-button small" :disabled="rows.length < 30 || busy" @click="page(30)">下一页</button></div></aside>
      <section ref="gridCard" class="record-grid-card">
        <div class="record-heading"><div><h2>{{ form ? (form.id ? '编辑已保存记录' : '新业务记录') : '业务表格' }}{{ dirty ? ' · 未保存' : '' }}</h2><small v-if="form">模板 v{{ form.templateVersion }} · {{ form.id || '保存时生成记录 ID' }}</small><small v-else>从左侧选择记录，或新建一条业务记录</small></div><div class="record-actions"><button class="secondary-button" :disabled="busy || dirty || !form?.id" @click="exportRecord">导出</button><button v-if="permission" class="primary-button" :disabled="!canSave" @click="save">{{ busy ? '处理中…' : '保存业务记录' }}</button></div></div>
        <div class="runtime-sheet-wrap"><div ref="sheetContainer" class="runtime-sheet"></div><div v-if="!form" class="grid-empty">请选择记录或新建记录</div><div v-else-if="!permission" class="grid-readonly">只读模式：可查看原表格，不能修改或保存</div></div>
        <section v-if="form && referenceInputs.length" class="runtime-tools"><h3>关联资料选择</h3><label v-for="input in mainReferenceInputs" :key="`${input.sheetId}:${input.cell}`">{{ input.field.label }} · {{ input.sheetId }}!{{ input.cell }}<select :disabled="!permission || busy" @change="chooseReference(input, $event.target.value)"><option value="">请选择有权访问的资料</option><option v-for="option in referenceOptions[input.field.targetEntityId]" :value="option.id">{{ referenceLabel(option) }}</option></select></label><details v-if="detailReferenceInputs.length" class="detail-reference-tools"><summary>明细行关联资料（{{ detailReferenceInputs.length }} 个预留单元格，按需展开）</summary><div><label v-for="input in detailReferenceInputs" :key="`${input.sheetId}:${input.cell}`">{{ input.field.label }} · {{ input.sheetId }}!{{ input.cell }}<select :disabled="!permission || busy" @change="chooseReference(input, $event.target.value)"><option value="">请选择有权访问的资料</option><option v-for="option in referenceOptions[input.field.targetEntityId]" :value="option.id">{{ referenceLabel(option) }}</option></select></label></div></details></section>
        <section v-if="summaries.length" class="runtime-tools summary-tools"><h3>跨模板查询与汇总</h3><div v-for="summary in summaries" :key="summary.id" class="summary-block"><strong>{{ summary.label }}</strong><span v-for="(value, group) in summary.groups" :key="group"><b>{{ summaryGroupLabel(summary, group) }}</b><em>{{ value }}</em></span></div></section>
        <section v-if="form?.id && model.rules?.workflow" class="runtime-tools"><h3>流程：{{ workflowStateLabel(form.workflowState || model.rules.workflow.initialState) }}</h3><button v-for="action in workflowActions" :key="action.id" class="secondary-button small" :disabled="busy || dirty" @click="transition(action)">{{ action.label }}</button></section>
        <section v-if="form?.id" class="runtime-tools history-tools"><h3>完整操作与流程历史</h3><p v-if="!recordAudit.length">暂无历史记录。</p><ol v-else><li v-for="item in recordAudit" :key="`${item.revision}:${item.action}:${item.createdAt}`"><strong>{{ auditLabel(item.action) }}</strong><span>版本 v{{ item.revision }} · {{ auditTime(item.createdAt) }}</span></li></ol></section>
        <p class="grid-hint">只保存模型中已绑定的业务字段；公式结果和临时版式调整不作为权威业务数据。</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.record-page { padding: 24px; min-height: 100%; color: #23324a; }
.record-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.record-heading h1, .record-heading h2 { margin: 8px 0; }
.record-heading p, .record-heading small { font-size: 12px; color: #68768d; }
.record-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.record-note, .record-message { margin: 0 0 16px; padding: 11px 13px; border: 1px solid #dbe8f5; border-radius: 9px; background: #edf5fd; font-size: 13px; line-height: 1.65; }
.record-message { background: #fff4dc; }
.record-layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 20px; min-height: 620px; }
.record-list, .record-grid-card { background: white; border: 1px solid #dce4ee; border-radius: 12px; padding: 18px; min-width: 0; }
.record-list-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.record-list h2 { margin: 0; font-size: 16px; }
.record-list-title span { display: grid; min-width: 24px; min-height: 24px; padding: 4px 8px; place-items: center; border-radius: 99px; color: #2a639b; background: #eaf3fc; font-size: 11px; font-weight: 800; white-space: nowrap; }
.record-list > button { width: 100%; display: grid; gap: 8px; text-align: left; padding: 12px; border: 1px solid #e0e7f1; margin-bottom: 10px; background: #f8fafe; border-radius: 8px; overflow-wrap: anywhere; }
.record-list > button:hover { border-color: #9ab9d8; background: #f1f7fd; }
.record-list > button.active { border-color: #5d9ad0; background: #eaf4fe; box-shadow: inset 3px 0 #2877c7; }
.record-list small { color: #738199; }
.record-filters { display: grid; gap: 8px; padding: 10px; margin: 0 0 12px; border: 1px solid #e0e7f1; border-radius: 8px; background: #f8fafe; }
.record-filters label { display: grid; gap: 4px; color: #53657b; font-size: 12px; }
.record-filters input, .record-filters select { width: 100%; min-width: 0; }
.filter-actions { display: flex; gap: 8px; }
.record-filters > small { color: #738199; }
.record-paging { display: flex; gap: 8px; }
.record-grid-card { display: flex; flex-direction: column; min-height: 620px; }
.runtime-sheet-wrap { position: relative; flex: 1; min-height: 520px; overflow: hidden; border: 1px solid #d8e1ed; border-radius: 8px; }
.runtime-sheet { position: absolute; inset: 0; }
.grid-empty, .grid-readonly { position: absolute; inset: 0; display: grid; place-items: center; color: #718096; background: rgba(248, 250, 254, .92); z-index: 2; }
.grid-readonly { inset: auto 12px 12px; display: block; padding: 8px 12px; border-radius: 6px; background: rgba(48, 65, 86, .88); color: white; pointer-events: none; }
.grid-hint { margin: 12px 0 0; color: #6a7890; font-size: 12px; }
.runtime-tools { margin-top: 12px; padding: 12px; border: 1px solid #dbe4ef; border-radius: 8px; display: flex; gap: 10px; flex-wrap: wrap; align-items: end; }
.runtime-tools h3 { width: 100%; margin: 0; font-size: 14px; }
.runtime-tools label { display: grid; gap: 4px; min-width: 220px; font-size: 12px; }
.detail-reference-tools { width: 100%; }
.detail-reference-tools summary { cursor: pointer; color: #2a639b; font-size: 12px; font-weight: 700; }
.detail-reference-tools > div { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
.history-tools { display: block; }
.history-tools p { margin: 8px 0 0; color: #6a7890; font-size: 12px; }
.history-tools ol { display: grid; gap: 7px; max-height: 260px; margin: 10px 0 0; padding-left: 20px; overflow: auto; }
.history-tools li { display: flex; justify-content: space-between; gap: 12px; color: #53657b; font-size: 12px; }
.history-tools li strong { color: #23324a; }
.summary-tools { align-items: stretch; }
.summary-block { display: grid; gap: 7px; min-width: min(100%, 240px); padding: 10px; border-radius: 7px; background: #f7f9fc; }
.summary-block > span { display: flex; justify-content: space-between; gap: 16px; padding-top: 7px; border-top: 1px solid #e3eaf3; font-size: 12px; }
.summary-block b { color: #53657b; font-weight: 600; }
.summary-block em { color: #246394; font-style: normal; font-weight: 800; }
@media (max-width: 1000px) { .record-layout { grid-template-columns: 1fr; } }
@media (max-width: 760px) {
  .record-page { padding: 18px 14px 28px; }
  .record-page-title { align-items: flex-start; }
  .record-heading h1 { font-size: 22px; }
  .record-layout { gap: 14px; min-height: 0; }
  .record-list, .record-grid-card { padding: 14px; border-radius: 10px; }
  .record-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .record-list-title, .record-filters, .record-list > p, .record-paging { grid-column: 1 / -1; }
  .record-list > button { margin: 0; }
  .record-grid-card, .runtime-sheet-wrap { min-height: 460px; }
  .runtime-tools label { min-width: 100%; }
  .history-tools li { display: grid; gap: 2px; }
}
@media (max-width: 460px) {
  .record-list { grid-template-columns: 1fr; }
  .record-actions { width: 100%; }
  .record-actions > button { flex: 1 1 auto; }
}
</style>
