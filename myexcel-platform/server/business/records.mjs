import { createHash, randomUUID } from 'node:crypto';
import { cellPosition, fieldState, typedValue, validateBusinessModel, hydrateBusinessRecord } from '../../shared/business-model.mjs';

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const decode = (value) => typeof value === 'string' ? JSON.parse(value) : value;
const canonical = (value) => JSON.stringify(value, function (key, item) { return object(item) ? Object.fromEntries(Object.keys(item).sort().map((k) => [k, item[k]])) : item; });
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const spaceOf = (release) => release.templateConfig.businessModel.dataSpaceId || release.id;

function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function rowsOf(record, model) {
  const rows = [{ entityId: record.entityId, values: record.values }];
  for (const detail of model.document.details) for (const row of record.details[detail.id]) rows.push(row);
  return rows;
}

function protectedInput(model, input, actor, before = null) {
  if (actor.role === 'admin') return structuredClone(input);
  const result = structuredClone(input);
  const derived = new Set([
    ...(model.rules?.lookups || []).map((rule) => `${rule.entityId}:${rule.destinationFieldId}`),
    ...(model.rules?.calculations || []).map((rule) => `${model.document.entityId}:${rule.destinationFieldId}`),
  ]);
  const protect = (entityId, values, previousValues = {}) => {
    const entity = model.entities.find((item) => item.id === entityId);
    for (const field of entity.fields) {
      const state = fieldState(model, entityId, field.id, actor.role);
      if (!['hidden', 'read'].includes(state) && !derived.has(`${entityId}:${field.id}`)) continue;
      const incoming = values[field.id];
      const previous = previousValues?.[field.id] ?? field.defaultValue ?? null;
      if (incoming != null && incoming !== '' && canonical(incoming) !== canonical(previous)) fail(403, `字段「${field.label}」为${state === 'hidden' ? '隐藏' : '只读'}状态，不能修改`);
      values[field.id] = previous;
    }
  };
  protect(model.document.entityId, result.values, before?.values);
  for (const detail of model.document.details) {
    const previousRows = new Map((before?.details?.[detail.id] || []).map((row) => [row.id, row]));
    for (const row of result.details?.[detail.id] || []) protect(detail.entityId, row.values, previousRows.get(row.id)?.values);
  }
  return result;
}

function demandPolicyRequired(model, record, actor) {
  if (actor.role === 'admin') return;
  for (const row of rowsOf(record, model)) {
    const entity = model.entities.find((item) => item.id === row.entityId);
    for (const field of entity.fields) if (fieldState(model, entity.id, field.id, actor.role) === 'required' && (row.values[field.id] == null || String(row.values[field.id]).trim() === '')) fail(422, `字段「${field.label}」在当前角色下必填`);
  }
}

function sumFor(field, values) {
  if (field.type === 'number') return values.reduce((sum, value) => sum + Number(value || 0), 0);
  const scale = field.scale;
  const total = values.reduce((sum, value) => {
    const [whole, fraction = ''] = String(value || 0).split('.');
    return sum + BigInt(whole) * (10n ** BigInt(scale)) + BigInt((whole.startsWith('-') ? '-' : '') + fraction.padEnd(scale, '0'));
  }, 0n);
  const negative = total < 0n, absolute = negative ? -total : total, text = absolute.toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${scale ? `${text.slice(0, -scale)}.${text.slice(-scale)}` : text}`;
}

export function normalizeRecord(model, record, { allowDerived = false } = {}) {
  if (!object(record) || record.entityId !== model.document.entityId || !object(record.values) || !object(record.details)) fail(422, '业务记录与主表模型不一致');
  const entity = (id) => model.entities.find((item) => item.id === id);
  const derived = new Set([
    ...(model.rules?.lookups || []).filter((rule) => rule.strategy === 'snapshot').map((rule) => `${rule.entityId}:${rule.destinationFieldId}`),
    ...(model.rules?.calculations || []).map((rule) => `${model.document.entityId}:${rule.destinationFieldId}`),
  ]);
  const fields = (entityId, bindings, values) => {
    if (!object(values)) fail(422, '字段内容必须为对象');
    const allowed = new Set(bindings.map((b) => b.fieldId));
    if (Object.keys(values).some((key) => !allowed.has(key))) fail(422, '不能写入未绑定字段或系统维护字段');
    return Object.fromEntries(bindings.map((binding) => {
      const field = entity(entityId).fields.find((item) => item.id === binding.fieldId);
      if (allowDerived && derived.has(`${entityId}:${binding.fieldId}`) && (values[binding.fieldId] == null || values[binding.fieldId] === '')) return [binding.fieldId, null];
      return [binding.fieldId, typedValue(values[binding.fieldId], field, `${entityId}.${binding.fieldId}`)];
    }));
  };
  const result = { entityId: record.entityId, values: fields(record.entityId, model.document.fields, record.values), details: {} };
  const ids = new Set();
  if (Object.keys(record.details).some((key) => !model.document.details.some((detail) => detail.id === key))) fail(422, '未知明细区域');
  for (const detail of model.document.details) {
    const rows = record.details[detail.id];
    if (!Array.isArray(rows) || rows.length > detail.rowCount) fail(422, `明细 ${detail.id} 缺失或超出预留行数`);
    result.details[detail.id] = rows.map((row) => {
      if (!object(row) || row.entityId !== detail.entityId || (row.id != null && (!uuid(row.id) || ids.has(row.id)))) fail(422, '明细实体或记录标识不合法、重复');
      if (row.id) ids.add(row.id);
      return { ...(row.id ? { id: row.id } : {}), entityId: detail.entityId, values: fields(detail.entityId, detail.columns, row.values) };
    });
  }
  return result;
}

// Conservative initial record ACL: template access plus ownership; admin can
// read/write all. A model may opt into same-template collaboration with
// recordScope 'all'; shared/public/department policies must be added explicitly.
export function recordAllowed(row, actor, templateAllowed, allowAll = false) {
  return templateAllowed(row.template_id) && (actor.role === 'admin' || allowAll || row.owner_id === actor.id);
}

export class BusinessRecords {
  constructor(pool) { this.pool = pool; this.storage = 'mysql'; }

  async audit(id) {
    const [rows] = await this.pool.execute('SELECT actor_id AS actorId, action, revision, template_version AS templateVersion, created_at AS createdAt FROM mx_audit WHERE record_id = ? ORDER BY revision DESC, created_at DESC', [id]);
    return rows;
  }

  async registerRelease(conn, release) {
    const model = release.templateConfig?.businessModel;
    const validation = validateBusinessModel(model, release.snapshot);
    if (!validation.valid || release.legacyInferred) fail(422, '发布模板没有有效的业务模型，请设计人员保存新草稿后发布');
    const content = { id: release.id, version: release.version, name: release.name, snapshot: release.snapshot, templateConfig: { businessModel: model } };
    const fingerprint = hash(content);
    await conn.execute('INSERT IGNORE INTO mx_releases (template_id, version, content_hash, content) VALUES (?, ?, ?, ?)', [release.id, release.version, fingerprint, JSON.stringify(content)]);
    const [[stored]] = await conn.execute('SELECT content_hash FROM mx_releases WHERE template_id = ? AND version = ? FOR UPDATE', [release.id, release.version]);
    if (stored.content_hash !== fingerprint) fail(409, '同一发布版本内容发生变化，拒绝覆盖业务数据对应的模板');
    for (const entity of [...model.entities].sort((a, b) => a.id.localeCompare(b.id))) {
      const fields = entity.fields.map(({ label, ...field }) => field).sort((a, b) => a.id.localeCompare(b.id));
      const schemaHash = hash(fields);
      await conn.execute('INSERT IGNORE INTO mx_entities (space_id, entity_id, schema_hash) VALUES (?, ?, ?)', [spaceOf(release), entity.id, schemaHash]);
      const [[previous]] = await conn.execute('SELECT schema_hash FROM mx_entities WHERE space_id = ? AND entity_id = ? FOR UPDATE', [spaceOf(release), entity.id]);
      if (previous.schema_hash !== schemaHash) fail(409, `共享实体 ${entity.id} 的结构发生变化，必须先设计数据迁移，不能直接写入`);
    }
  }

  async release(conn, templateId, version) {
    const [[row]] = await conn.execute('SELECT content FROM mx_releases WHERE template_id = ? AND version = ?', [templateId, version]);
    if (!row) fail(404, '记录对应的发布版本不存在');
    return decode(row.content);
  }

  async read(conn, id, actor, templateAllowed, lock = false) {
    const [[row]] = await conn.execute(`SELECT * FROM mx_records WHERE id = ? AND parent_id IS NULL${lock ? ' FOR UPDATE' : ''}`, [id]);
    const release = row ? await this.release(conn, row.template_id, row.template_version) : null;
    const collaborative = release?.templateConfig?.businessModel?.recordScope === 'all';
    if (!row || !recordAllowed(row, actor, templateAllowed, collaborative)) fail(404, '业务记录不存在或无权访问');
    const [children] = await conn.execute('SELECT * FROM mx_records WHERE parent_id = ? ORDER BY detail_key, ordinal, id', [id]);
    const model = release.templateConfig.businessModel;
    const record = { id: row.id, entityId: row.entity_id, templateId: row.template_id, templateVersion: row.template_version,
      version: row.revision, workflowState: row.workflow_state, ownerId: row.owner_id, createdAt: row.created_at, updatedAt: row.updated_at, values: decode(row.values_json), details: {} };
    for (const detail of model.document.details) record.details[detail.id] = children.filter((child) => child.detail_key === detail.id).map((child) => {
      const values = decode(child.values_json); delete values[detail.parentFieldId];
      return { id: child.id, entityId: child.entity_id, values };
    });
    return { record, release };
  }

  async get(id, actor, templateAllowed) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await this.read(conn, id, actor, templateAllowed);
      await this.applyLookups(conn, result.release, result.record, actor, templateAllowed, 'live');
      await conn.commit();
      return result;
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
  }

  // A record's own template decides whether editors share visibility; targets
  // referenced from other templates use the target record's template scope.
  async scopeAllows(conn, row, actor, templateAllowed) {
    const release = await this.release(conn, row.template_id, row.template_version);
    return recordAllowed(row, actor, templateAllowed, release?.templateConfig?.businessModel?.recordScope === 'all');
  }

  async previewRelations({ release, record, actor, templateAllowed }) {
    const conn = await this.pool.getConnection();
    try {
      const model = release.templateConfig.businessModel;
      const checks = [];
      for (const row of rowsOf(record, model)) {
        const entity = model.entities.find((item) => item.id === row.entityId);
        for (const field of entity.fields.filter((item) => item.type === 'reference')) {
          const targetId = row.values[field.id];
          const base = { entityId: row.entityId, fieldId: field.id, targetEntityId: field.targetEntityId, targetId: targetId || null, cardinality: 'stable-id-unique' };
          if (!targetId) { checks.push({ ...base, status: 'empty' }); continue; }
          const [[target]] = await conn.execute('SELECT * FROM mx_records WHERE id = ?', [targetId]);
          if (!target || target.space_id !== spaceOf(release) || target.entity_id !== field.targetEntityId) { checks.push({ ...base, status: 'no-match' }); continue; }
          checks.push({ ...base, status: await this.scopeAllows(conn, target, actor, templateAllowed) ? 'matched' : 'permission-denied' });
        }
      }
      return checks;
    } finally { conn.release(); }
  }

  async applyLookups(conn, release, record, actor, templateAllowed, strategy = null) {
    const model = release.templateConfig.businessModel;
    for (const rule of model.rules?.lookups || []) {
      if (strategy && rule.strategy !== strategy) continue;
      for (const row of rowsOf(record, model).filter((item) => item.entityId === rule.entityId)) {
        const targetId = row.values[rule.referenceFieldId];
        if (!targetId) { row.values[rule.destinationFieldId] = null; continue; }
        const [[target]] = await conn.execute('SELECT * FROM mx_records WHERE id = ? FOR SHARE', [targetId]);
        const reference = model.entities.find((entity) => entity.id === row.entityId).fields.find((field) => field.id === rule.referenceFieldId);
        if (!target || target.space_id !== spaceOf(release) || target.entity_id !== reference.targetEntityId || !(await this.scopeAllows(conn, target, actor, templateAllowed))) fail(422, `关联规则 ${rule.id} 无匹配或无权读取目标`);
        if (rule.filterFieldId) {
          const filtered = decode(target.values_json)[rule.filterFieldId];
          if (filtered !== rule.filterValue) fail(422, `关联规则 ${rule.id} 的目标不满足筛选条件`);
        }
        const targetEntity = model.entities.find((entity) => entity.id === target.entity_id);
        const destination = model.entities.find((entity) => entity.id === row.entityId).fields.find((field) => field.id === rule.destinationFieldId);
        row.values[rule.destinationFieldId] = typedValue(decode(target.values_json)[rule.targetFieldId], destination, `${rule.id}.${rule.destinationFieldId}`);
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

  async save({ release, id = null, expectedVersion, requestId, input, actor, templateAllowed }) {
    if (!actor || !['admin', 'editor'].includes(actor.role)) fail(403, '只读账号不能保存业务记录');
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId || '')) fail(422, '保存须提供 8—100 位 requestId 以防重复提交');
    if (id !== null && !uuid(id)) fail(422, '记录标识无效');
    if (id !== null && !Number.isInteger(expectedVersion)) fail(428, '修改业务记录必须提供 expectedVersion');
    if (!release || !templateAllowed(release.id)) fail(403, '没有来源模板权限');
    const requestHash = hash({ templateId: release.id, templateVersion: release.version, id, expectedVersion: expectedVersion ?? null, input });
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const stamp = new Date().toISOString();
      await conn.execute('INSERT IGNORE INTO mx_requests (actor_id, request_key, request_hash, created_at) VALUES (?, ?, ?, ?)', [actor.id, requestId, requestHash, stamp]);
      const [[request]] = await conn.execute('SELECT * FROM mx_requests WHERE actor_id = ? AND request_key = ? FOR UPDATE', [actor.id, requestId]);
      if (request.request_hash !== requestHash) fail(409, '同一个请求标识不能用于不同内容');
      if (request.response_json) {
        const previous = decode(request.response_json);
        await this.read(conn, previous.record.id, actor, templateAllowed); // Re-check current ACL before replay.
        await conn.commit(); return { ...previous, replayed: true };
      }
      let before = null;
      if (id) {
        const current = await this.read(conn, id, actor, templateAllowed, true);
        if (current.record.templateId !== release.id || current.record.templateVersion !== release.version) fail(409, '修改记录必须使用创建时固定的模板版本');
        if (current.record.version !== expectedVersion) fail(409, '业务记录已被更新，请重新打开后再保存');
        before = current.record;
        release = current.release;
      }
      await this.registerRelease(conn, release);
      const model = release.templateConfig.businessModel;
      let normalized = normalizeRecord(model, protectedInput(model, input, actor, before), { allowDerived: true });
      await this.applyLookups(conn, release, normalized, actor, templateAllowed, 'snapshot');
      this.applyCalculations(model, normalized);
      normalized = normalizeRecord(model, normalized);
      demandPolicyRequired(model, normalized, actor);
      const rootId = id || randomUUID();
      const ownerId = before?.ownerId || actor.id;
      const revision = (before?.version || 0) + 1;
      const [existingChildren] = await conn.execute('SELECT id, detail_key FROM mx_records WHERE parent_id = ? FOR UPDATE', [rootId]);
      const previousIds = new Map(existingChildren.map((row) => [row.id, row.detail_key]));
      const allRows = [{ id: rootId, entityId: normalized.entityId, values: normalized.values, parentId: null, detailKey: null, ordinal: 0 }];
      for (const detail of model.document.details) for (const [ordinal, child] of normalized.details[detail.id].entries()) {
        if (child.id && previousIds.get(child.id) !== detail.id) fail(422, '明细标识不属于当前记录或区域，不能通过行号/外来标识覆盖其他记录');
        allRows.push({ id: child.id || randomUUID(), entityId: child.entityId, values: { ...child.values, [detail.parentFieldId]: rootId }, parentId: rootId, detailKey: detail.id, ordinal });
      }
      const keep = new Set(allRows.map((row) => row.id));
      const oldIds = [rootId, ...previousIds.keys()];
      for (const oldId of oldIds) await conn.execute('DELETE FROM mx_references WHERE source_id = ?', [oldId]);
      for (const [oldId] of previousIds) if (!keep.has(oldId)) {
        const [[used]] = await conn.execute('SELECT source_id FROM mx_references WHERE target_id = ? LIMIT 1', [oldId]);
        if (used) fail(409, '该明细已被其他记录引用，不能删除');
        await conn.execute('DELETE FROM mx_records WHERE id = ?', [oldId]);
      }
      for (const row of allRows) {
        if (row.id === id || previousIds.has(row.id)) {
          await conn.execute('UPDATE mx_records SET values_json = ?, ordinal = ?, revision = ?, updated_at = ? WHERE id = ?', [JSON.stringify(row.values), row.ordinal, revision, stamp, row.id]);
        } else {
          await conn.execute('INSERT INTO mx_records (id, space_id, entity_id, template_id, template_version, parent_id, detail_key, ordinal, revision, workflow_state, owner_id, values_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [row.id, spaceOf(release), row.entityId, release.id, release.version, row.parentId, row.detailKey, row.ordinal, revision, row.parentId ? null : (model.rules?.workflow?.initialState || null), ownerId, JSON.stringify(row.values), stamp, stamp]);
        }
      }
      for (const row of allRows) for (const field of model.entities.find((entity) => entity.id === row.entityId).fields) {
        if (field.type !== 'reference' || row.values[field.id] == null) continue;
        const targetId = row.values[field.id];
        if (!uuid(targetId)) fail(422, `关联字段 ${field.label} 需要有效的记录 ID`);
        const [[target]] = await conn.execute('SELECT * FROM mx_records WHERE id = ? FOR SHARE', [targetId]);
        if (!target || target.space_id !== spaceOf(release) || target.entity_id !== field.targetEntityId || !(await this.scopeAllows(conn, target, actor, templateAllowed))) fail(422, `关联字段 ${field.label} 的目标不存在、类型不符或无权访问`);
        await conn.execute('INSERT INTO mx_references (source_id, field_id, target_id) VALUES (?, ?, ?)', [row.id, field.id, targetId]);
      }
      const after = await this.read(conn, rootId, actor, templateAllowed);
      await conn.execute('INSERT INTO mx_audit (id, record_id, actor_id, action, revision, template_version, created_at, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [randomUUID(), rootId, actor.id, before ? 'update' : 'create', revision, release.version, stamp, before ? JSON.stringify(before) : null, JSON.stringify(after.record)]);
      await conn.execute('UPDATE mx_requests SET response_json = ? WHERE actor_id = ? AND request_key = ?', [JSON.stringify(after), actor.id, requestId]);
      await conn.commit();
      return { ...after, replayed: false };
    } catch (error) {
      await conn.rollback();
      if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) fail(409, '并发保存冲突；请保持同一请求标识重试');
      throw error;
    } finally { conn.release(); }
  }

  async list({ spaceId, entityId, templateIds, actor, limit = 30, offset = 0, templateId = null, scope = 'own', dateFieldId = null, dateFrom = null, dateTo = null, workflowState = null }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) fail(422, '分页参数无效');
    if (!['own', 'all', 'template'].includes(scope)) fail(422, '记录范围无效');
    if (!templateIds.length) return [];
    if (templateIds.length > 500) fail(422, '模板数量超过当前查询上限');
    const clauses = ['r.space_id = ?', 'r.entity_id = ?', 'r.parent_id IS NULL', `r.template_id IN (${templateIds.map(() => '?').join(',')})`];
    const args = [spaceId, entityId, ...templateIds];
    if (templateId) { clauses.push('r.template_id = ?'); args.push(templateId); }
    if (actor.role !== 'admin' && scope === 'own') { clauses.push('r.owner_id = ?'); args.push(actor.id); }
    if (actor.role !== 'admin' && scope === 'template') {
      clauses.push("(r.owner_id = ? OR JSON_UNQUOTE(JSON_EXTRACT(rel.content, '$.templateConfig.businessModel.recordScope')) = 'all')");
      args.push(actor.id);
    }
    if (workflowState) { if (!/^[a-z][a-z0-9_]{0,63}$/.test(workflowState)) fail(422, '流程状态筛选无效'); clauses.push('r.workflow_state = ?'); args.push(workflowState); }
    if (dateFrom || dateTo) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(dateFieldId || '') || [dateFrom, dateTo].filter(Boolean).some((value) => !calendarDate(value))) fail(422, '日期筛选无效');
      if (dateFrom && dateTo && dateFrom > dateTo) fail(422, '开始日期不能晚于结束日期');
      const expression = `JSON_UNQUOTE(JSON_EXTRACT(r.values_json, '$.${dateFieldId}'))`;
      if (dateFrom) { clauses.push(`${expression} >= ?`); args.push(dateFrom); }
      if (dateTo) { clauses.push(`${expression} <= ?`); args.push(dateTo); }
    }
    // LIMIT/OFFSET are bounded integers; all business identifiers are parameters.
    const [rows] = await this.pool.execute(`SELECT r.id, r.entity_id, r.template_id, r.template_version, r.revision, r.workflow_state, r.values_json, r.updated_at FROM mx_records r JOIN mx_releases rel ON rel.template_id = r.template_id AND rel.version = r.template_version WHERE ${clauses.join(' AND ')} ORDER BY r.updated_at DESC, r.id LIMIT ${limit} OFFSET ${offset}`, args);
    return rows.map((row) => ({ id: row.id, entityId: row.entity_id, templateId: row.template_id, templateVersion: row.template_version, version: row.revision, workflowState: row.workflow_state, values: decode(row.values_json), updatedAt: row.updated_at }));
  }

  async aggregate({ release, templateIds, actor, templateAllowed }) {
    const model = release.templateConfig.businessModel, results = [];
    const scope = 'template';
    for (const rule of model.rules?.aggregates || []) {
      const records = [];
      for (let offset = 0; ; offset += 100) {
        const page = await this.list({ spaceId: spaceOf(release), entityId: rule.entityId, templateIds, actor, limit: 100, offset, scope });
        records.push(...page);
        if (page.length < 100) break;
      }
      const groups = new Map();
      for (const record of records) {
        const key = rule.groupByFieldId ? String(record.values[rule.groupByFieldId] ?? '未分组') : '全部';
        const values = groups.get(key) || []; values.push(record.values[rule.fieldId]); groups.set(key, values);
      }
      const field = model.entities.find((entity) => entity.id === rule.entityId).fields.find((item) => item.id === rule.fieldId);
      results.push({
        id: rule.id,
        label: rule.label || rule.id,
        groupEntityId: rule.entityId,
        groupByFieldId: rule.groupByFieldId || null,
        groups: Object.fromEntries([...groups].map(([key, values]) => [key, rule.operation === 'count' ? values.length : sumFor(field, values.filter((value) => value != null))])),
      });
    }
    return results;
  }

  async transition({ id, transitionId, expectedVersion, requestId, actor, templateAllowed }) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId || '')) fail(422, '流程操作须提供有效 requestId');
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const current = await this.read(conn, id, actor, templateAllowed, true), model = current.release.templateConfig.businessModel;
      const workflow = model.rules?.workflow, transition = workflow?.transitions?.find((item) => item.id === transitionId);
      if (!transition || !transition.roles.includes(actor.role)) fail(403, '没有此流程操作权限');
      const [[existing]] = await conn.execute('SELECT actor_id, transition_id FROM mx_workflow_events WHERE record_id = ? AND request_key = ? FOR UPDATE', [id, requestId]);
      if (existing) {
        if (existing.actor_id !== actor.id || existing.transition_id !== transition.id) fail(409, '同一流程请求标识不能用于不同操作');
        await conn.commit(); return { ...current, replayed: true };
      }
      if (current.record.version !== expectedVersion) fail(409, '业务记录已更新，请重新打开');
      const state = current.record.workflowState || workflow.initialState;
      if (state !== transition.from) fail(409, `当前状态 ${state} 不能执行此操作`);
      const stamp = new Date().toISOString();
      const [inserted] = await conn.execute('INSERT IGNORE INTO mx_workflow_events (record_id, request_key, actor_id, transition_id, from_state, to_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, requestId, actor.id, transition.id, state, transition.to, stamp]);
      if (!inserted.affectedRows) { const replay = await this.read(conn, id, actor, templateAllowed); await conn.commit(); return { ...replay, replayed: true }; }
      await conn.execute('UPDATE mx_records SET workflow_state = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [transition.to, stamp, id]);
      if (transition.writeback) {
        const targetId = current.record.values[transition.writeback.referenceFieldId];
        const [[target]] = await conn.execute('SELECT * FROM mx_records WHERE id = ? FOR UPDATE', [targetId]);
        if (!target || target.space_id !== spaceOf(current.release) || !(await this.scopeAllows(conn, target, actor, templateAllowed))) fail(422, '流程回写目标不存在或无权修改');
        const entity = model.entities.find((item) => item.id === target.entity_id), field = entity?.fields.find((item) => item.id === transition.writeback.targetFieldId);
        const values = decode(target.values_json); values[field.id] = typedValue(transition.writeback.value, field, `${transition.id}.writeback`);
        await conn.execute('UPDATE mx_records SET values_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [JSON.stringify(values), stamp, targetId]);
        await conn.execute('INSERT INTO mx_audit (id, record_id, actor_id, action, revision, template_version, created_at, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [randomUUID(), targetId, actor.id, 'workflow_writeback', target.revision + 1, target.template_version, stamp, target.values_json, JSON.stringify(values)]);
      }
      const after = await this.read(conn, id, actor, templateAllowed);
      await conn.execute('INSERT INTO mx_audit (id, record_id, actor_id, action, revision, template_version, created_at, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [randomUUID(), id, actor.id, `workflow:${transition.id}`, after.record.version, after.record.templateVersion, stamp, JSON.stringify(current.record), JSON.stringify(after.record)]);
      await conn.commit(); return { ...after, replayed: false };
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
  }
}

// Shared, storage-neutral rules used by the default local adapter. Keeping
// these in one place prevents local and MySQL modes from accepting different
// records even though their persistence mechanisms differ.
export const recordSupport = {
  calendarDate,
  canonical,
  demandPolicyRequired,
  fail,
  hash,
  protectedInput,
  rowsOf,
  spaceOf,
  sumFor,
};

function clearHidden(model, snapshot, role) {
  const output = structuredClone(snapshot);
  const clear = (sheetId, address) => { const pos = cellPosition(address); const cell = pos && output.sheets?.[sheetId]?.cellData?.[pos.row]?.[pos.col]; if (cell) { delete cell.v; delete cell.p; delete cell.f; } };
  for (const binding of model.document.fields) if (fieldState(model, model.document.entityId, binding.fieldId, role) === 'hidden') clear(binding.sheetId, binding.cell);
  for (const detail of model.document.details) for (const binding of detail.columns) if (fieldState(model, detail.entityId, binding.fieldId, role) === 'hidden') {
    for (let row = detail.startRow; row < detail.startRow + detail.rowCount; row++) clear(detail.sheetId, `${binding.column}${row}`);
  }
  return output;
}

export function visibleRecord(model, record, role) {
  const output = structuredClone(record);
  output.values ||= {};
  output.details ||= {};
  output.values = visibleEntityValues(model, model.document.entityId, output.values, role);
  for (const detail of model.document.details) for (const row of output.details[detail.id] || []) for (const field of model.entities.find((item) => item.id === detail.entityId).fields) if (fieldState(model, detail.entityId, field.id, role) === 'hidden') delete row.values[field.id];
  return output;
}

export function visibleEntityValues(model, entityId, values, role) {
  const output = structuredClone(values || {});
  for (const field of model.entities.find((item) => item.id === entityId)?.fields || []) if (fieldState(model, entityId, field.id, role) === 'hidden') delete output[field.id];
  return output;
}

export function runtimeTemplateProjection(release, actor) {
  const model = release.templateConfig.businessModel;
  return { id: release.id, name: release.name, version: release.version, model, snapshot: clearHidden(model, release.snapshot, actor.role) };
}

export function recordProjection(result, actor = { role: 'admin' }) {
  const model = result.release.templateConfig.businessModel;
  const record = visibleRecord(model, result.record, actor.role);
  const snapshot = clearHidden(model, hydrateBusinessRecord(model, result.release.snapshot, result.record), actor.role);
  // Formula cache from a design template is not a business result. The client
  // may display recalculation; no formula output is accepted as persisted data.
  for (const sheet of Object.values(snapshot.sheets)) for (const row of Object.values(sheet.cellData || {})) for (const cell of Object.values(row)) if (cell?.f) delete cell.v;
  return { ...result, release: runtimeTemplateProjection(result.release, actor), record, snapshot };
}
