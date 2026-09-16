<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import DataModelDesigner from './DataModelDesigner.vue';

const props = defineProps({ workbook: Object, user: Object });
const emit = defineEmits(['updated', 'created', 'preview']);
const fields = ref([]);
const formulas = ref([]);
const businessModel = ref(null);
const dataSource = ref({ type: 'synthetic', name: '合成基准数据', connection: '内置生成器' });
const permissions = ref([]);
const audit = ref([]);
const releases = ref([]);
const busy = ref(false);
const loading = ref(false);
const ready = ref(false);
const baseline = ref('');
let loadGeneration = 0;
const message = ref('');
const rowCount = ref(3000), columnCount = ref(26);
const isAdmin = computed(() => props.user?.role === 'admin');
const clone = (value) => JSON.parse(JSON.stringify(value));
const signature = () => JSON.stringify([fields.value, formulas.value, businessModel.value, dataSource.value, permissions.value]);
const dirty = computed(() => ready.value && signature() !== baseline.value);
const locked = computed(() => busy.value || loading.value || !ready.value);

function mayLeave() {
  if (busy.value || loading.value) { message.value = '正在处理，请完成后再切换。'; return false; }
  return !dirty.value || window.confirm('设计配置尚未保存，确认放弃本次修改吗？');
}
defineExpose({ mayLeave, busy });
function beforeUnload(event) { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = ''; } }
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => { loadGeneration++; window.removeEventListener('beforeunload', beforeUnload); });

function defaults() {
  return {
    fields: [
      { key: 'recordNo', label: '记录编号', sheet: '记录数据', cell: 'A:A', type: '文本', required: true },
      { key: 'group', label: '分组', sheet: '记录数据', cell: 'B:B', type: '选项', required: true },
      { key: 'baseValue', label: '基础值', sheet: '记录数据', cell: 'C:C', type: '数值', required: true },
    ],
    formulas: [
      { name: '加权结果', sheet: '记录数据', target: 'H:H', expression: '=基础值*权重/系数' },
      { name: '基础值合计', sheet: '汇总', target: 'B3', expression: "=SUM('记录数据'!C:C)" },
    ],
  };
}

async function load() {
  if (!props.workbook) return;
  const generation = ++loadGeneration;
  loading.value = true; ready.value = false; message.value = '';
  permissions.value = []; audit.value = [];
  const config = props.workbook.templateConfig || defaults();
  businessModel.value = config.businessModel ? clone(config.businessModel) : null;
  fields.value = clone(config.fields ?? defaults().fields);
  formulas.value = clone(config.formulas ?? defaults().formulas);
  dataSource.value = clone(Object.keys(props.workbook.dataSourceConfig || {}).length ? props.workbook.dataSourceConfig : { type: 'static', name: '', connection: '' });
  try {
    const results = await Promise.all([api.getPermissions(props.workbook.id), api.getAudit(props.workbook.id), api.listReleases ? api.listReleases(props.workbook.id) : Promise.resolve({ releases: [] })]);
    if (generation !== loadGeneration) return;
    permissions.value = results[0].permissions;
    audit.value = results[1].audit;
    releases.value = results[2].releases;
    baseline.value = signature(); ready.value = true;
  } catch (error) {
    if (generation === loadGeneration) message.value = `设计配置加载未完成：${error.message}。请重试后再修改。`;
  } finally { if (generation === loadGeneration) loading.value = false; }
}

watch(() => props.workbook?.id, load, { immediate: true });

function addField() {
  fields.value.push({ key: `field${fields.value.length + 1}`, label: '新字段', sheet: '记录数据', cell: '', type: '文本', required: false });
}

function addFormula() {
  formulas.value.push({ name: '新公式', sheet: '汇总', target: '', expression: '=' });
}

async function refreshAudit() {
  try { audit.value = (await api.getAudit(props.workbook.id)).audit; }
  catch (error) { message.value += `；审计列表刷新失败：${error.message}`; }
}

async function persistDesign() {
  try {
    const result = await api.saveDesign(props.workbook.id, {
      templateConfig: clone({ ...props.workbook.templateConfig, fields: fields.value, formulas: formulas.value, businessModel: businessModel.value }),
      dataSourceConfig: clone(dataSource.value),
      expectedVersion: props.workbook.version,
    });
    // Advance local version immediately, even if the separate permission request fails.
    emit('updated', result.workbook);
    await nextTick();
    if (isAdmin.value) {
      try { await api.savePermissions(result.workbook.id, clone(permissions.value)); }
      catch (error) {
        message.value = `设计草稿 v${result.workbook.version} 已保存，但权限保存失败：${error.message}。本次未继续发布。`;
        return null;
      }
    }
    message.value = '设计配置与权限已保存为草稿';
    baseline.value = signature();
    return result.workbook;
  } catch (error) {
    message.value = error.message;
  }
}

async function saveDesign() {
  if (locked.value) return null;
  busy.value = true;
  try { const saved = await persistDesign(); if (saved) await refreshAudit(); return saved; }
  finally { busy.value = false; }
}

async function publish() {
  if (locked.value) return;
  busy.value = true;
  try {
    // Hold one lock across saving configuration, permissions and publication.
    const saved = await persistDesign();
    if (!saved) return;
    const result = await api.publishWorkbook(saved.id, saved.version);
    message.value = `发布成功：版本 ${result.workbook.publishedVersion}`;
    emit('updated', result.workbook);
    await nextTick();
    await refreshAudit();
  } catch (error) {
    message.value = error.message;
  } finally {
    busy.value = false;
  }
}

async function rollbackRelease() {
  const target = releases.value.find((item) => item.version !== props.workbook.publishedVersion);
  if (!target || locked.value || !window.confirm(`确认把工作人员使用版本回滚到 v${target.version}？当前草稿不会丢失。`)) return;
  busy.value = true;
  try {
    const result = await api.rollbackWorkbook(props.workbook.id, target.version, props.workbook.version);
    message.value = `发布版本已回滚到 v${target.version}，当前草稿仍为 v${result.workbook.version}`;
    emit('updated', result.workbook); await nextTick();
  } catch (error) { message.value = error.message; }
  finally { busy.value = false; }
}

async function createBenchmark() {
  if (locked.value || !mayLeave()) return;
  busy.value = true;
  try {
    const result = await api.createWorkbookBenchmark(rowCount.value, columnCount.value);
    message.value = `已生成 ${rowCount.value} 条合成记录基准`;
    emit('created', result.workbook);
  } catch (error) {
    message.value = error.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="workbook" class="designer-page">
    <section class="designer-hero">
      <div><span class="section-kicker">TEMPLATE DESIGNER</span><h1>{{ workbook.name }}</h1><p>配置字段、公式、表间关系和发布版本；扩展工具按需展开。</p></div>
      <div class="designer-actions"><span :class="['status-pill', workbook.status]">草稿 v{{ workbook.version }} · {{ workbook.publishedVersion ? `已发布 v${workbook.publishedVersion}` : '未发布' }}{{ dirty ? ' · 未保存修改' : '' }}</span><button v-if="workbook.publishedVersion" class="secondary-button" :disabled="locked" @click="emit('preview')">预览发布效果</button><button v-if="releases.some((item) => item.version !== workbook.publishedVersion)" class="secondary-button" :disabled="locked" @click="rollbackRelease">回滚上一发布版</button><button class="secondary-button" :disabled="locked" @click="saveDesign">保存草稿</button><button class="primary-button" :disabled="locked" @click="publish">保存并发布</button></div>
    </section>

    <fieldset class="designer-grid" :disabled="locked" style="border: 0; margin: 0; padding: 0; min-width: 0">
      <DataModelDesigner v-model="businessModel" :snapshot="workbook.snapshot" :workbook-id="workbook.id" :version="workbook.version" :disabled="locked" />
      <details class="design-card wide legacy-card">
        <summary><div><h2>旧版字段说明</h2><p>仅用于兼容旧配置，日常设计请使用上方业务数据模型。</p></div></summary>
        <div class="legacy-content"><button class="secondary-button small" @click="addField">＋ 添加字段</button><div class="config-table field-table"><span>显示名称</span><span>字段键</span><span>工作表</span><span>区域</span><span>类型</span><span>必填</span>
          <template v-for="(field, index) in fields" :key="index"><input v-model="field.label"><input v-model="field.key"><input v-model="field.sheet"><input v-model="field.cell"><select v-model="field.type"><option>文本</option><option>数值</option><option>日期</option><option>选项</option></select><input v-model="field.required" type="checkbox"></template>
        </div></div>
      </details>

      <details class="design-card wide legacy-card">
        <summary><div><h2>旧版公式说明</h2><p>仅用于兼容说明，实际公式请直接在模板版式中配置。</p></div></summary>
        <div class="legacy-content"><button class="secondary-button small" @click="addFormula">＋ 添加公式</button><div class="config-table formula-table"><span>名称</span><span>工作表</span><span>目标区域</span><span>表达式</span>
          <template v-for="(formula, index) in formulas" :key="index"><input v-model="formula.name"><input v-model="formula.sheet"><input v-model="formula.target"><input v-model="formula.expression"></template>
        </div></div>
      </details>

      <details class="design-card legacy-card">
        <summary><div><h2>可选：数据来源与性能工具</h2><p>合成数据说明、外部数据源预留和本地性能基准。</p></div></summary>
        <div class="legacy-content"><label>来源类型<select v-model="dataSource.type"><option value="synthetic">合成数据</option><option value="static">静态录入</option><option value="database">外部数据库（预留）</option></select></label>
        <label>来源名称<input v-model="dataSource.name"></label>
        <label>连接说明<input v-model="dataSource.connection"></label>
        <div v-if="isAdmin" class="benchmark-box"><strong>合成性能基准</strong><p>生成多工作表、跨表公式和可调宽表，用于验证行数与渲染边界。</p><div><label>行数<input v-model.number="rowCount" type="number" min="100" max="10000"></label><label>列数<input v-model.number="columnCount" type="number" min="26" max="200"></label><button class="secondary-button" :disabled="busy" @click="createBenchmark">生成基准</button></div></div>
        </div>
      </details>

      <details class="design-card legacy-card">
        <summary><div><h2>可选：模板权限</h2><p>为演示角色设置查看、编辑或设计权限。</p></div></summary>
        <div class="legacy-content permission-list"><div v-for="permission in permissions" :key="permission.userId"><span><strong>{{ permission.displayName }}</strong><small>{{ permission.username }} · {{ permission.role }}</small></span><select v-model="permission.accessLevel" :disabled="busy || !isAdmin || permission.role !== 'editor'"><option value="view">查看</option><option value="edit">编辑</option><option value="design">设计/发布</option></select></div></div>
      </details>

      <details class="design-card wide legacy-card">
        <summary><div><h2>可选：操作记录</h2><p>查看创建、保存、配置、权限和发布动作。</p></div></summary>
        <div class="legacy-content audit-list"><div v-for="item in audit" :key="item.id"><span class="audit-action">{{ item.action }}</span><strong>{{ item.detail }}</strong><span>{{ item.userName }}</span><time>{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</time></div></div>
      </details>
    </fieldset>
    <div v-if="message" class="designer-message" role="status">{{ message }} <button v-if="!ready && !loading" class="secondary-button" @click="load">重新加载</button></div>
  </div>
</template>
