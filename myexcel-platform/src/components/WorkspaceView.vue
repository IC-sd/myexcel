<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/presets/preset-sheets-core';
import sheetsCoreZhCN from '@univerjs/presets/preset-sheets-core/locales/zh-CN';
import '@univerjs/presets/lib/styles/preset-sheets-core.css';
import { api } from '../api.js';
import DesignerPanel from './DesignerPanel.vue';
import BusinessRecords from './BusinessRecords.vue';

const props = defineProps({ user: { type: Object, required: true } });
const emit = defineEmits(['logout']);
const sheetContainer = ref(null);
const fileInput = ref(null);
const packageInput = ref(null);
const workbooks = ref([]);
const active = ref(null);
const busy = ref(false);
const message = ref('准备就绪');
const messageType = ref('neutral');
const dirty = ref(false);
const versions = ref([]);
const showVersions = ref(false), showCompatibility = ref(false);
const showCreate = ref(false);
const showBinding = ref(false);
const bindingSelection = ref(null);
const bindingKind = ref('main');
const bindingFieldId = ref('');
const bindingDetailId = ref('');
const newName = ref('新建业务工作簿');
const viewMode = ref('workbook');
const published = ref(null);
const recordEditor = ref(null);
const designer = ref(null);
const workspaceMain = ref(null);
const isBusinessTemplate = computed(() => Boolean(active.value?.templateConfig?.businessModel));

let univer;
let univerAPI;
let facadeWorkbook;
let changeDisposable;
let editRevision = 0;

function mayLeaveCurrent() {
  if (busy.value) { notify('正在处理，请完成后再切换。', 'warning'); return false; }
  if (recordEditor.value && !recordEditor.value.mayLeave()) return false;
  if (designer.value && !designer.value.mayLeave()) return false;
  return !dirty.value || window.confirm('当前工作簿修改尚未保存，确认放弃吗？');
}

function beforeUnload(event) {
  if (busy.value || dirty.value) { event.preventDefault(); event.returnValue = ''; }
}

const currentAccess = computed(() => workbooks.value.find((book) => book.id === active.value?.id)?.accessLevel || (props.user.role === 'admin' ? 'design' : props.user.role === 'editor' ? 'edit' : 'view'));
const canEdit = computed(() => props.user.role !== 'viewer' && ['edit', 'design'].includes(currentAccess.value));
const canDesign = computed(() => currentAccess.value === 'design');
const roleName = computed(() => ({ admin: '管理员', editor: '编辑人员', viewer: '只读人员' }[props.user.role]));
const bindingModel = computed(() => active.value?.templateConfig?.businessModel);
const bindingMainFields = computed(() => bindingModel.value?.entities.find((item) => item.id === bindingModel.value.document.entityId)?.fields || []);
const bindingDetail = computed(() => bindingModel.value?.document.details.find((item) => item.id === bindingDetailId.value));
const bindingDetailFields = computed(() => {
  const detail = bindingDetail.value;
  return detail ? bindingModel.value.entities.find((item) => item.id === detail.entityId)?.fields.filter((item) => item.id !== detail.parentFieldId) || [] : [];
});

function notify(text, type = 'neutral') {
  message.value = text;
  messageType.value = type;
}

async function resetMainScroll() {
  await nextTick();
  if (workspaceMain.value) workspaceMain.value.scrollTop = 0;
}

function disposeCurrentWorkbook() {
  changeDisposable?.dispose?.();
  changeDisposable = null;
  if (facadeWorkbook) {
    univerAPI?.disposeUnit?.(facadeWorkbook.getId());
    facadeWorkbook = null;
  }
}

onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload);
  const created = createUniver({
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: mergeLocales(sheetsCoreZhCN) },
    presets: [UniverSheetsCorePreset({ container: sheetContainer.value })],
  });
  univer = created.univer;
  univerAPI = created.univerAPI;
  await refreshList(true);
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  disposeCurrentWorkbook();
  univerAPI?.dispose?.();
  univer?.dispose?.();
});

async function refreshList(selectFirst = false) {
  try {
    workbooks.value = (await api.listWorkbooks()).workbooks;
    if (selectFirst && workbooks.value.length) await selectWorkbook(workbooks.value[0]);
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function selectWorkbook(book) {
  if (!mayLeaveCurrent()) return;
  busy.value = true;
  try {
    const loaded = (await api.getWorkbook(book.id)).workbook;
    dirty.value = false;
    active.value = loaded;
    if (loaded.templateConfig?.businessModel) { disposeCurrentWorkbook(); viewMode.value = 'records'; await resetMainScroll(); return; }
    if (book.accessLevel === 'view') {
      viewMode.value = 'published';
      await resetMainScroll();
      await openPublishedWorkbook(book.id, true);
      return;
    }
    viewMode.value = 'workbook';
    await resetMainScroll();
    await openWorkbook(book.id, true, loaded);
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy.value = false;
  }
}

async function openWorkbook(id, authorized = false, supplied = null) {
  if (!authorized && !mayLeaveCurrent()) return;
  const inheritedBusy = busy.value;
  busy.value = true;
  notify('正在打开工作簿…');
  try {
    const loaded = supplied ?? (await api.getWorkbook(id)).workbook;
    disposeCurrentWorkbook();
    active.value = loaded;
    if (loaded.templateConfig?.businessModel && viewMode.value !== 'template') { viewMode.value = 'records'; dirty.value = false; return; }
    facadeWorkbook = univerAPI.createWorkbook(loaded.snapshot);
    if (!canEdit.value) {
      await facadeWorkbook.getWorkbookPermission().setMode('viewer');
    }
    active.value = loaded;
    dirty.value = false;
    const eventType = univerAPI.Event?.CommandExecuted;
    const trackedChangeTypes = new Set(Object.values(univerAPI.Enum?.SheetValueChangeType ?? {}));
    const workbookId = facadeWorkbook.getId();
    notify(`已打开 · 版本 ${loaded.version}`, 'success');
    if (canEdit.value && eventType) changeDisposable = univerAPI.addEvent(eventType, (event) => {
      if (!trackedChangeTypes.has(event?.id) || event?.params?.unitId !== workbookId) return;
      if (event?.options?.onlyLocal && event?.options?.fromFormula) return;
      editRevision++;
      dirty.value = true;
      notify('有未保存的修改', 'warning');
    });
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy.value = inheritedBusy;
  }
}

async function switchMode(mode) {
  if (mode === 'designer' && !canDesign.value) return;
  if (mode === 'template' && !canDesign.value) return;
  if (!active.value) return;
  if (mode === 'workbook' && isBusinessTemplate.value) mode = 'records';
  if (mode === viewMode.value) return;
  if (!mayLeaveCurrent()) return;
  dirty.value = false;
  viewMode.value = mode;
  await resetMainScroll();
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (mode === 'workbook') {
    if (currentAccess.value === 'view') await openPublishedWorkbook(active.value.id);
    else await openWorkbook(active.value.id, true);
  }
  if (mode === 'published') await openPublishedWorkbook(active.value.id);
  if (mode === 'template') await openWorkbook(active.value.id);
}

function logout() {
  if (!mayLeaveCurrent()) return;
  emit('logout');
}

async function openPublishedWorkbook(id, authorized = false) {
  if (!authorized && !mayLeaveCurrent()) return;
  if (!id) return;
  viewMode.value = 'published';
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 80));
  busy.value = true;
    try {
      published.value = (await api.getPublishedWorkbook(id)).workbook;
      disposeCurrentWorkbook();
      facadeWorkbook = univerAPI.createWorkbook(published.value.snapshot);
      await facadeWorkbook.getWorkbookPermission().setMode('viewer');
      dirty.value = false;
      notify(published.value.legacyInferred ? '旧版发布配置来源不完整，请设计人员核对后重新发布' : `发布视图 · 版本 ${published.value.publishedVersion}`, published.value.legacyInferred ? 'warning' : 'success');
    } catch (error) {
      viewMode.value = canDesign.value ? 'designer' : 'workbook';
      notify(error.message, 'error');
      if (!canDesign.value) await openWorkbook(id, true);
    } finally {
      busy.value = false;
  }
}

async function handleDesignUpdated(workbook) {
  active.value = workbook;
  await refreshList(false);
}

async function handleBenchmarkCreated(workbook) {
  await refreshList(false);
  viewMode.value = 'workbook';
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 80));
  await openWorkbook(workbook.id, true, workbook);
}

async function saveWorkbook() {
  if (busy.value || !canEdit.value || !active.value || !facadeWorkbook) return;
  busy.value = true;
  notify('正在保存到数据库…');
  try {
    const savedRevision = editRevision;
    const snapshot = await facadeWorkbook.save();
    const result = await api.saveWorkbook(active.value.id, {
      name: active.value.name,
      description: active.value.description,
      expectedVersion: active.value.version,
      snapshot,
    });
    active.value = result.workbook;
    dirty.value = editRevision !== savedRevision;
    notify(dirty.value ? `版本 ${active.value.version} 已保存；保存期间又有修改，仍需再次保存` : `保存成功 · 版本 ${active.value.version}`, dirty.value ? 'warning' : 'success');
    await refreshList(false);
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy.value = false;
  }
}

function columnName(index) {
  let value = index + 1; let result = '';
  while (value > 0) { value--; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
  return result;
}

function captureBindingSelection() {
  if (!bindingModel.value) { notify('请先在管理设计端启用业务数据模型。', 'warning'); return; }
  if (dirty.value) { notify('模板版式有未保存修改，请先保存工作簿再建立绑定。', 'warning'); return; }
  const sheet = facadeWorkbook?.getActiveSheet?.();
  const range = sheet?.getActiveRange?.();
  if (!sheet || !range) { notify('请先在表格中选择一个单元格或单列区域。', 'warning'); return; }
  const selected = range.getRange();
  bindingSelection.value = {
    sheetId: sheet.getSheetId(), address: range.getA1Notation(),
    startRow: selected.startRow + 1, rowCount: selected.endRow - selected.startRow + 1,
    startColumn: selected.startColumn, columnCount: selected.endColumn - selected.startColumn + 1,
  };
  bindingKind.value = selected.startRow === selected.endRow && selected.startColumn === selected.endColumn ? 'main' : 'detail';
  bindingDetailId.value = bindingModel.value.document.details[0]?.id || '';
  bindingFieldId.value = bindingKind.value === 'main' ? bindingMainFields.value[0]?.id || '' : bindingDetailFields.value[0]?.id || '';
  showBinding.value = true;
}

async function applySelectionBinding() {
  const selection = bindingSelection.value;
  if (!selection || !bindingFieldId.value || busy.value) return;
  if (bindingKind.value === 'main' && (selection.rowCount !== 1 || selection.columnCount !== 1)) { notify('主表字段只能绑定一个单元格。', 'warning'); return; }
  if (bindingKind.value === 'detail' && (!bindingDetail.value || selection.columnCount !== 1)) { notify('明细字段请选择一个单列区域。', 'warning'); return; }
  busy.value = true;
  try {
    const model = JSON.parse(JSON.stringify(bindingModel.value));
    if (bindingKind.value === 'main') {
      model.document.fields = model.document.fields.filter((item) => item.fieldId !== bindingFieldId.value);
      model.document.fields.push({ fieldId: bindingFieldId.value, sheetId: selection.sheetId, cell: selection.address });
    } else {
      const detail = model.document.details.find((item) => item.id === bindingDetailId.value);
      detail.sheetId = selection.sheetId; detail.startRow = selection.startRow; detail.rowCount = selection.rowCount;
      detail.columns = detail.columns.filter((item) => item.fieldId !== bindingFieldId.value && item.column !== columnName(selection.startColumn));
      detail.columns.push({ fieldId: bindingFieldId.value, column: columnName(selection.startColumn) });
    }
    const result = await api.saveDesign(active.value.id, {
      templateConfig: { ...active.value.templateConfig, businessModel: model },
      dataSourceConfig: active.value.dataSourceConfig || {}, expectedVersion: active.value.version,
    });
    active.value = result.workbook; showBinding.value = false;
    await refreshList(false);
    notify(`已将 ${selection.sheetId}!${selection.address} 绑定到字段 ${bindingFieldId.value}，并保存为草稿 v${result.workbook.version}`, 'success');
  } catch (error) { notify(`选区绑定失败：${error.message}`, 'error'); }
  finally { busy.value = false; }
}

async function createWorkbook() {
  if (!mayLeaveCurrent()) return;
  const name = newName.value.trim();
  if (!name) return;
  busy.value = true;
  try {
    const created = (await api.createWorkbook(name)).workbook;
    showCreate.value = false;
    await refreshList(false);
    await nextTick();
    viewMode.value = 'workbook';
    await openWorkbook(created.id, true, created);
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy.value = false;
  }
}

async function importFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!mayLeaveCurrent()) return;
  busy.value = true;
  notify(`正在导入 ${file.name}…`);
  try {
    const result = await api.importWorkbook(file);
    const imported = result.workbook;
    await refreshList(false);
    viewMode.value = 'workbook';
    await openWorkbook(imported.id, true, imported);
    notify(result.report?.warnings?.length ? `已导入 ${file.name}；有 ${result.report.warnings.length} 项兼容提示` : `已导入 ${file.name}`, result.report?.warnings?.length ? 'warning' : 'success');
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy.value = false;
  }
}

async function importPackage(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !mayLeaveCurrent()) return;
  busy.value = true;
  notify(`正在校验并导入 ${file.name}…`);
  try {
    const result = await api.importTemplatePackage(file);
    await refreshList(false);
    viewMode.value = 'workbook';
    await openWorkbook(result.workbook.id, true, result.workbook);
    const summary = result.report?.summary;
    notify(`模板包已导入为独立草稿${summary ? `：${summary.sheets} 个工作表，${summary.formulas} 个公式` : ''}`, 'success');
  } catch (error) {
    notify(error.payload?.issues?.[0]?.message || error.message, 'error');
  } finally {
    busy.value = false;
  }
}

function exportWorkbook() {
  if (!active.value) return;
    window.location.href = api.exportUrl(active.value.id, viewMode.value === 'published');
}

function exportPackage() {
  if (!active.value) return;
  window.location.href = api.templatePackageUrl(active.value.id, viewMode.value === 'published');
}

async function openVersions() {
  if (!active.value) return;
  try {
    versions.value = (await api.listVersions(active.value.id)).versions;
    showVersions.value = true;
  } catch (error) {
    notify(error.message, 'error');
  }
}
</script>

<template>
  <div class="workspace-shell">
    <header class="topbar">
      <div class="topbar-brand"><div class="brand-mark small">GS</div><div><strong>表格应用构建平台</strong><small>通用类 Excel 应用底座</small></div></div>
      <nav class="mode-nav">
        <button :disabled="busy" :class="{ active: ['workbook', 'records'].includes(viewMode) || (viewMode === 'published' && !canDesign) }" @click="switchMode('workbook')">工作人员端</button>
        <button v-if="canDesign" :disabled="busy" :class="{ active: ['designer', 'published', 'template'].includes(viewMode) }" @click="switchMode('designer')">管理设计端</button>
      </nav>
      <div class="topbar-actions">
        <span class="role-chip">{{ roleName }}</span>
        <span class="user-name">{{ user.displayName }}</span>
        <button class="text-button" :disabled="busy" @click="logout">退出</button>
      </div>
    </header>

    <aside class="sidebar">
      <div class="sidebar-heading">
        <div><span class="section-kicker">WORKBOOKS</span><h2>应用工作簿</h2></div>
        <button v-if="canEdit" class="icon-button" :disabled="busy" title="新建工作簿" @click="showCreate = true">＋</button>
      </div>
      <div class="workbook-list">
        <button v-for="book in workbooks" :key="book.id" :disabled="busy" :class="['workbook-item', { active: active?.id === book.id }]" :aria-label="`${book.name}，${book.status === 'published' ? '已发布' : '草稿'}`" :title="book.name" @click="selectWorkbook(book)">
          <span class="workbook-icon">▦</span>
          <span class="workbook-copy"><strong>{{ book.name }}</strong><small>版本 {{ book.version }} · {{ book.status === 'published' ? '已发布' : '草稿' }}</small></span>
        </button>
      </div>
      <div class="sidebar-note">
        <strong>当前版本</strong>
        <p>表格应用核心闭环已完成；内置示例均可安全重建。</p>
      </div>
    </aside>

    <main ref="workspaceMain" :class="['workspace-main', { 'designer-main': ['designer', 'records'].includes(viewMode) }]" :aria-busy="busy">
      <DesignerPanel v-if="viewMode === 'designer'" ref="designer" :workbook="active" :user="user" @updated="handleDesignUpdated" @created="handleBenchmarkCreated" @preview="switchMode('published')" />
      <BusinessRecords v-if="viewMode === 'records' && active" :key="active.id" ref="recordEditor" :workbook-id="active.id" :can-design="canDesign" @edit-template="switchMode('template')" />
      <section v-show="!['designer', 'records'].includes(viewMode)" class="workbook-toolbar">
        <div class="title-block">
          <span class="breadcrumb">{{ viewMode === 'template' ? '管理设计端 / 模板版式（不是填报数据）' : viewMode === 'published' ? (canDesign ? '管理设计端 / 发布预览' : '工作人员端 / 已发布结果') : '工作人员端 / 原型工作簿' }}</span>
          <h1>{{ active?.name || '请选择工作簿' }} <span v-if="dirty && viewMode === 'workbook'" class="dirty-dot" title="未保存"></span></h1>
        </div>
        <div class="toolbar-actions">
          <template v-if="viewMode === 'published'"><span class="published-badge">已发布固定版本 v{{ published?.publishedVersion }}</span><button v-if="canDesign" class="secondary-button" @click="switchMode('designer')">返回管理设计端</button></template>
          <template v-else><input v-if="canEdit" ref="fileInput" class="visually-hidden" type="file" accept=".xlsx" @change="importFile" />
          <input v-if="canEdit" ref="packageInput" class="visually-hidden" type="file" accept=".mxapp.json,application/json" @change="importPackage" />
          <button v-if="viewMode === 'template' && canDesign" class="secondary-button" :disabled="busy || !active" @click="captureBindingSelection">绑定当前选区</button>
          <details class="toolbar-menu"><summary class="secondary-button">导入 / 导出</summary><div><button v-if="canEdit" :disabled="busy" @click="fileInput.click()">导入 XLSX</button><button :disabled="!active" @click="exportWorkbook">导出 XLSX</button><span></span><button v-if="canEdit" :disabled="busy" @click="packageInput.click()">导入模板包</button><button :disabled="!active" @click="exportPackage">导出模板包</button><small>模板包只迁移模板、模型和规则，不包含业务记录与权限。</small></div></details>
          <button v-if="active?.templateConfig?.compatibilityReport" class="secondary-button" :disabled="!active" @click="showCompatibility = true">兼容性报告</button><button class="secondary-button" :disabled="!active" @click="openVersions">版本记录</button>
          <button v-if="canEdit" class="primary-button" :disabled="busy || !active" @click="saveWorkbook">{{ busy ? '处理中…' : '保存工作簿' }}</button></template>
        </div>
      </section>

      <section v-show="!['designer', 'records'].includes(viewMode)" class="sheet-frame">
        <div v-if="!active" class="empty-state"><div>▦</div><h3>选择一个工作簿开始</h3><p>从左侧打开示例，或创建新的业务工作簿。</p></div>
        <div ref="sheetContainer" class="sheet-container"></div>
        <div v-if="active && (!canEdit || viewMode === 'published')" class="readonly-banner">{{ viewMode === 'published' ? '发布视图：内容固定，不随草稿修改' : '只读模式：可以查看和导出，不能修改数据' }}</div>
      </section>

      <footer v-show="!['designer', 'records'].includes(viewMode)" :class="['statusbar', messageType]">
        <span class="status-indicator"></span><span>{{ message }}</span>
        <span class="status-meta" v-if="active">本地服务已连接 · {{ viewMode === 'published' ? `发布版本 ${published?.publishedVersion || '-'}` : `工作簿版本 ${active.version}` }}</span>
      </footer>
    </main>

    <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false">
      <form class="modal-card compact" @submit.prevent="createWorkbook">
        <div class="modal-title"><div><span class="section-kicker">NEW WORKBOOK</span><h2>新建工作簿</h2></div><button type="button" class="icon-button" @click="showCreate = false">×</button></div>
        <label>工作簿名称<input v-model="newName" autofocus /></label>
        <div class="modal-actions"><button type="button" class="secondary-button" :disabled="busy" @click="showCreate = false">取消</button><button class="primary-button" :disabled="busy">创建并打开</button></div>
      </form>
    </div>

    <div v-if="showVersions" class="modal-backdrop" @click.self="showVersions = false">
      <section class="modal-card">
        <div class="modal-title"><div><span class="section-kicker">VERSION HISTORY</span><h2>{{ active?.name }}</h2></div><button class="icon-button" @click="showVersions = false">×</button></div>
        <div class="version-list">
          <div v-for="version in versions" :key="version.version" class="version-item"><span class="version-number">v{{ version.version }}</span><div><strong>{{ version.savedBy }}</strong><small>{{ new Date(version.savedAt).toLocaleString('zh-CN') }}</small></div></div>
        </div>
      </section>
    </div>
    <div v-if="showCompatibility" class="modal-backdrop" @click.self="showCompatibility = false">
      <section class="modal-card compatibility-card"><div class="modal-title"><div><span class="section-kicker">XLSX COMPATIBILITY</span><h2>{{ active?.name }} · 导入报告</h2></div><button class="icon-button" @click="showCompatibility = false">×</button></div><p>此报告说明导入结果，不代表 Excel 全量兼容。原文件应保留为高级版式和计算的依据。</p><div class="compat-summary"><span>工作表 {{ active.templateConfig.compatibilityReport.summary.sheets }}</span><span>公式 {{ active.templateConfig.compatibilityReport.summary.formulas }}</span><span>可用 {{ active.templateConfig.compatibilityReport.summary.supportedFormulas }}</span><span>需处理 {{ active.templateConfig.compatibilityReport.summary.unsupportedFormulas }}</span></div><div class="compat-list"><div v-for="feature in active.templateConfig.compatibilityReport.features" :key="feature.id" :class="`compat-${feature.status}`"><strong>{{ feature.label }}</strong><span>{{ feature.status === 'retained' ? '保留' : feature.status === 'partial' ? '部分支持' : feature.status === 'absent' ? '未发现' : '不导入' }}</span><small>{{ feature.detail }}</small></div></div><details v-if="active.templateConfig.compatibilityReport.formulas.length"><summary>公式支持矩阵（{{ active.templateConfig.compatibilityReport.formulas.length }} 个）</summary><ul><li v-for="formula in active.templateConfig.compatibilityReport.formulas" :key="`${formula.sheetId}:${formula.address}`"><b>{{ formula.sheetId }}!{{ formula.address }}</b> · {{ formula.functions.join('、') || '基础引用' }} · {{ formula.supported ? '可展示计算' : formula.reasons.join('；') }}</li></ul></details><details v-if="active.templateConfig.compatibilityReport.warnings.length"><summary>降级提示（{{ active.templateConfig.compatibilityReport.warnings.length }} 项）</summary><ul><li v-for="warning in active.templateConfig.compatibilityReport.warnings" :key="warning">{{ warning }}</li></ul></details></section>
    </div>

    <div v-if="showBinding" class="modal-backdrop" @click.self="showBinding = false">
      <form class="modal-card compact" @submit.prevent="applySelectionBinding">
        <div class="modal-title"><div><span class="section-kicker">CELL BINDING</span><h2>绑定所选表格区域</h2></div><button type="button" class="icon-button" @click="showBinding = false">×</button></div>
        <p>当前选区：<strong>{{ bindingSelection?.sheetId }}!{{ bindingSelection?.address }}</strong></p>
        <label>绑定类型<select v-model="bindingKind" @change="bindingFieldId = bindingKind === 'main' ? (bindingMainFields[0]?.id || '') : (bindingDetailFields[0]?.id || '')"><option value="main">主表单元格</option><option value="detail" :disabled="!bindingModel?.document.details.length">明细单列区域</option></select></label>
        <label v-if="bindingKind === 'detail'">明细区域<select v-model="bindingDetailId" @change="bindingFieldId = bindingDetailFields[0]?.id || ''"><option v-for="detail in bindingModel.document.details" :key="detail.id" :value="detail.id">{{ detail.id }}</option></select></label>
        <label>业务字段<select v-model="bindingFieldId"><option value="">请选择字段</option><option v-for="field in (bindingKind === 'main' ? bindingMainFields : bindingDetailFields)" :key="field.id" :value="field.id">{{ field.label }} ({{ field.id }})</option></select></label>
        <p v-if="bindingKind === 'main' && (bindingSelection?.rowCount !== 1 || bindingSelection?.columnCount !== 1)" class="record-message">主表字段须选择单个单元格。</p>
        <p v-if="bindingKind === 'detail' && bindingSelection?.columnCount !== 1" class="record-message">明细字段须选择一个单列区域。</p>
        <div class="modal-actions"><button type="button" class="secondary-button" :disabled="busy" @click="showBinding = false">取消</button><button class="primary-button" :disabled="busy || !bindingFieldId">保存绑定</button></div>
      </form>
    </div>
  </div>
</template>
