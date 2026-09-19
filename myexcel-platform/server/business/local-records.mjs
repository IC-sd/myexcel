import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { typedValue, validateBusinessModel } from '../../shared/business-model.mjs';
import { normalizeRecord, recordAllowed, recordSupport } from './records.mjs';

const { calendarDate, demandPolicyRequired, fail, hash, protectedInput, rowsOf, spaceOf, sumFor } = recordSupport;
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const clone = (value) => structuredClone(value);

function emptyState() {
  return { version: 1, releases: {}, entitySchemas: {}, records: {}, requests: {}, audit: [], workflowEvents: {} };
}

export class LocalBusinessRecords {
  constructor(path) {
    this.path = path;
    this.storage = 'local-json';
    mkdirSync(dirname(path), { recursive: true });
    this.state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : emptyState();
    if (this.state.version !== 1) throw new Error('本地业务记录文件版本不受支持');
  }

  persist() {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(temporary, this.path);
  }

  transaction(work) {
    const before = clone(this.state);
    try {
      const result = work();
      this.persist();
      return result;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  releaseKey(templateId, version) { return `${templateId}:${version}`; }

  registerRelease(release) {
    const model = release.templateConfig?.businessModel;
    const validation = validateBusinessModel(model, release.snapshot);
    if (!validation.valid || release.legacyInferred) fail(422, '发布模板没有有效的业务模型，请设计人员保存新草稿后发布');
    const content = { id: release.id, version: release.version, name: release.name, snapshot: release.snapshot, templateConfig: { businessModel: model } };
    const key = this.releaseKey(release.id, release.version), fingerprint = hash(content);
    const stored = this.state.releases[key];
    if (stored && stored.hash !== fingerprint) fail(409, '同一发布版本内容发生变化，拒绝覆盖业务数据对应的模板');
    this.state.releases[key] ||= { hash: fingerprint, content };
    for (const entity of model.entities) {
      const fields = entity.fields.map(({ label, ...field }) => field).sort((a, b) => a.id.localeCompare(b.id));
      const schemaKey = `${spaceOf(release)}:${entity.id}`, schemaHash = hash(fields);
      if (this.state.entitySchemas[schemaKey] && this.state.entitySchemas[schemaKey] !== schemaHash) fail(409, `共享实体 ${entity.id} 的结构发生变化，必须先设计数据迁移，不能直接写入`);
      this.state.entitySchemas[schemaKey] = schemaHash;
    }
    return content;
  }

  release(templateId, version) {
    const stored = this.state.releases[this.releaseKey(templateId, version)];
    if (!stored) fail(404, '记录对应的发布版本不存在');
    return clone(stored.content);
  }

  allowed(row, actor, templateAllowed) {
    const release = this.release(row.templateId, row.templateVersion);
    const compatible = { template_id: row.templateId, owner_id: row.ownerId };
    return recordAllowed(compatible, actor, templateAllowed, release.templateConfig.businessModel.recordScope === 'all');
  }

  findRow(id) {
    const root = this.state.records[id];
    if (root) return { root, row: root };
    for (const candidate of Object.values(this.state.records)) for (const rows of Object.values(candidate.details || {})) {
      const row = rows.find((item) => item.id === id);
      if (row) return { root: candidate, row };
    }
    return null;
  }

  read(id, actor, templateAllowed) {
    const stored = this.state.records[id];
    if (!stored || !this.allowed(stored, actor, templateAllowed)) fail(404, '业务记录不存在或无权访问');
    return { record: clone(stored), release: this.release(stored.templateId, stored.templateVersion) };
  }

  applyLookups(release, record, actor, templateAllowed, strategy = null) {
    const model = release.templateConfig.businessModel;
    for (const rule of model.rules?.lookups || []) {
      if (strategy && rule.strategy !== strategy) continue;
      for (const row of rowsOf(record, model).filter((item) => item.entityId === rule.entityId)) {
        const targetId = row.values[rule.referenceFieldId];
        if (!targetId) { row.values[rule.destinationFieldId] = null; continue; }
        const found = this.findRow(targetId), reference = model.entities.find((entity) => entity.id === row.entityId).fields.find((field) => field.id === rule.referenceFieldId);
        if (!found || found.root.spaceId !== spaceOf(release) || found.row.entityId !== reference.targetEntityId || !this.allowed(found.root, actor, templateAllowed)) fail(422, `关联规则 ${rule.id} 无匹配或无权读取目标`);
        if (rule.filterFieldId && found.row.values[rule.filterFieldId] !== rule.filterValue) fail(422, `关联规则 ${rule.id} 的目标不满足筛选条件`);
        const destination = model.entities.find((entity) => entity.id === row.entityId).fields.find((field) => field.id === rule.destinationFieldId);
        row.values[rule.destinationFieldId] = typedValue(found.row.values[rule.targetFieldId], destination, `${rule.id}.${rule.destinationFieldId}`);
      }
    }
    return record;
  }

  applyCalculations(model, record) {
    for (const rule of model.rules?.calculations || []) {
      const detail = model.document.details.find((item) => item.id === rule.detailId);
      const target = model.entities.find((entity) => entity.id === record.entityId).fields.find((field) => field.id === rule.destinationFieldId);
      const values = record.details[detail.id].map((row) => row.values[rule.sourceFieldId]).filter((value) => value != null);
      record.values[rule.destinationFieldId] = typedValue(sumFor(target, values), target, `${rule.id}.${rule.destinationFieldId}`);
    }
    return record;
  }

  async get(id, actor, templateAllowed) {
    const result = this.read(id, actor, templateAllowed);
    this.applyLookups(result.release, result.record, actor, templateAllowed, 'live');
    return result;
  }

  async previewRelations({ release, record, actor, templateAllowed }) {
    const model = release.templateConfig.businessModel, checks = [];
    for (const row of rowsOf(record, model)) {
      const entity = model.entities.find((item) => item.id === row.entityId);
      for (const field of entity.fields.filter((item) => item.type === 'reference')) {
        const targetId = row.values[field.id], base = { entityId: row.entityId, fieldId: field.id, targetEntityId: field.targetEntityId, targetId: targetId || null, cardinality: 'stable-id-unique' };
        if (!targetId) { checks.push({ ...base, status: 'empty' }); continue; }
        const found = this.findRow(targetId);
        if (!found || found.root.spaceId !== spaceOf(release) || found.row.entityId !== field.targetEntityId) checks.push({ ...base, status: 'no-match' });
        else checks.push({ ...base, status: this.allowed(found.root, actor, templateAllowed) ? 'matched' : 'permission-denied' });
      }
    }
    return checks;
  }

  async save({ release, id = null, expectedVersion, requestId, input, actor, templateAllowed }) {
    if (!actor || !['admin', 'editor'].includes(actor.role)) fail(403, '只读账号不能保存业务记录');
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId || '')) fail(422, '保存须提供 8—100 位 requestId 以防重复提交');
    if (id !== null && !uuid(id)) fail(422, '记录标识无效');
    if (id !== null && !Number.isInteger(expectedVersion)) fail(428, '修改业务记录必须提供 expectedVersion');
    if (!release || !templateAllowed(release.id)) fail(403, '没有来源模板权限');
    return this.transaction(() => {
      const requestKey = `${actor.id}:${requestId}`;
      const requestHash = hash({ templateId: release.id, templateVersion: release.version, id, expectedVersion: expectedVersion ?? null, input });
      const previousRequest = this.state.requests[requestKey];
      if (previousRequest) {
        if (previousRequest.hash !== requestHash) fail(409, '同一个请求标识不能用于不同内容');
        const replay = this.read(previousRequest.recordId, actor, templateAllowed);
        return { ...replay, replayed: true };
      }
      let before = null;
      if (id) {
        const current = this.read(id, actor, templateAllowed);
        if (current.record.templateId !== release.id || current.record.templateVersion !== release.version) fail(409, '修改记录必须使用创建时固定的模板版本');
        if (current.record.version !== expectedVersion) fail(409, '业务记录已被更新，请重新打开后再保存');
        before = current.record; release = current.release;
      }
      this.registerRelease(release);
      const model = release.templateConfig.businessModel;
      let normalized = normalizeRecord(model, protectedInput(model, input, actor, before), { allowDerived: true });
      this.applyLookups(release, normalized, actor, templateAllowed, 'snapshot');
      this.applyCalculations(model, normalized);
      normalized = normalizeRecord(model, normalized);
      demandPolicyRequired(model, normalized, actor);
      const stamp = new Date().toISOString(), rootId = id || randomUUID(), revision = (before?.version || 0) + 1;
      const details = {};
      for (const detail of model.document.details) details[detail.id] = normalized.details[detail.id].map((row, ordinal) => ({ ...row, id: row.id || randomUUID(), ordinal }));
      const saved = { id: rootId, entityId: normalized.entityId, templateId: release.id, templateVersion: release.version, spaceId: spaceOf(release), version: revision,
        workflowState: before?.workflowState || model.rules?.workflow?.initialState || null, ownerId: before?.ownerId || actor.id, createdAt: before?.createdAt || stamp, updatedAt: stamp, values: normalized.values, details };
      for (const row of rowsOf(saved, model)) for (const field of model.entities.find((entity) => entity.id === row.entityId).fields.filter((item) => item.type === 'reference')) {
        const targetId = row.values[field.id]; if (targetId == null) continue;
        const found = this.findRow(targetId);
        if (!uuid(targetId) || !found || found.root.spaceId !== saved.spaceId || found.row.entityId !== field.targetEntityId || !this.allowed(found.root, actor, templateAllowed)) fail(422, `关联字段 ${field.label} 的目标不存在、类型不符或无权访问`);
      }
      this.state.records[rootId] = saved;
      this.state.requests[requestKey] = { hash: requestHash, recordId: rootId };
      this.state.audit.push({ id: randomUUID(), recordId: rootId, actorId: actor.id, action: before ? 'update' : 'create', revision, templateVersion: release.version, createdAt: stamp });
      return { record: clone(saved), release: clone(this.state.releases[this.releaseKey(release.id, release.version)].content), replayed: false };
    });
  }

  async list({ spaceId, entityId, templateIds, actor, limit = 30, offset = 0, templateId = null, scope = 'own', dateFieldId = null, dateFrom = null, dateTo = null, workflowState = null }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) fail(422, '分页参数无效');
    if (!['own', 'all', 'template'].includes(scope)) fail(422, '记录范围无效');
    if ((dateFrom || dateTo) && (!/^[a-z][a-z0-9_]{0,63}$/.test(dateFieldId || '') || [dateFrom, dateTo].filter(Boolean).some((value) => !calendarDate(value)) || dateFrom && dateTo && dateFrom > dateTo)) fail(422, '日期筛选无效');
    return Object.values(this.state.records).filter((row) => row.spaceId === spaceId && row.entityId === entityId && templateIds.includes(row.templateId) && (!templateId || row.templateId === templateId)
      && (actor.role === 'admin' || scope === 'all' || scope === 'template' && this.release(row.templateId, row.templateVersion).templateConfig.businessModel.recordScope === 'all' || row.ownerId === actor.id)
      && (!workflowState || row.workflowState === workflowState) && (!dateFrom || row.values[dateFieldId] >= dateFrom) && (!dateTo || row.values[dateFieldId] <= dateTo))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).slice(offset, offset + limit).map(clone);
  }

  async aggregate({ release, templateIds, actor, templateAllowed }) {
    const model = release.templateConfig.businessModel, results = [];
    for (const rule of model.rules?.aggregates || []) {
      const records = await this.list({ spaceId: spaceOf(release), entityId: rule.entityId, templateIds, actor, limit: 100, scope: 'template' });
      const groups = new Map();
      for (const record of records) { const key = rule.groupByFieldId ? String(record.values[rule.groupByFieldId] ?? '未分组') : '全部'; const values = groups.get(key) || []; values.push(record.values[rule.fieldId]); groups.set(key, values); }
      const field = model.entities.find((entity) => entity.id === rule.entityId).fields.find((item) => item.id === rule.fieldId);
      results.push({ id: rule.id, label: rule.label || rule.id, groupEntityId: rule.entityId, groupByFieldId: rule.groupByFieldId || null,
        groups: Object.fromEntries([...groups].map(([key, values]) => [key, rule.operation === 'count' ? values.length : sumFor(field, values.filter((value) => value != null))])) });
    }
    return results;
  }

  async transition({ id, transitionId, expectedVersion, requestId, actor, templateAllowed }) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId || '')) fail(422, '流程操作须提供有效 requestId');
    return this.transaction(() => {
      const current = this.read(id, actor, templateAllowed), model = current.release.templateConfig.businessModel;
      const workflow = model.rules?.workflow, transition = workflow?.transitions?.find((item) => item.id === transitionId), eventKey = `${id}:${requestId}`;
      if (!transition || !transition.roles.includes(actor.role)) fail(403, '没有此流程操作权限');
      if (this.state.workflowEvents[eventKey]) return { ...current, replayed: true };
      if (current.record.version !== expectedVersion) fail(409, '业务记录已更新，请重新打开');
      const state = current.record.workflowState || workflow.initialState;
      if (state !== transition.from) fail(409, `当前状态 ${state} 不能执行此操作`);
      const stamp = new Date().toISOString(), stored = this.state.records[id];
      stored.workflowState = transition.to; stored.version += 1; stored.updatedAt = stamp;
      if (transition.writeback) {
        const found = this.findRow(stored.values[transition.writeback.referenceFieldId]);
        if (!found || !this.allowed(found.root, actor, templateAllowed)) fail(422, '流程回写目标不存在或无权修改');
        const entity = model.entities.find((item) => item.id === found.row.entityId), field = entity?.fields.find((item) => item.id === transition.writeback.targetFieldId);
        found.row.values[field.id] = typedValue(transition.writeback.value, field, `${transition.id}.writeback`); found.root.version += 1; found.root.updatedAt = stamp;
      }
      this.state.workflowEvents[eventKey] = { actorId: actor.id, transitionId };
      this.state.audit.push({ id: randomUUID(), recordId: id, actorId: actor.id, action: `workflow:${transition.id}`, revision: stored.version, templateVersion: stored.templateVersion, createdAt: stamp });
      return { record: clone(stored), release: current.release, replayed: false };
    });
  }

  async audit(id) {
    return this.state.audit.filter((item) => item.recordId === id).sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt)).map(clone);
  }
}
