import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDefaultSnapshot } from './workbook-codec.mjs';
import { validateBusinessModel, diffModelSchema } from '../shared/business-model.mjs';

const ROLE_LEVEL = { viewer: 1, editor: 2, admin: 3 };

function now() {
  return new Date().toISOString();
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const digest = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class Store {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.migrate();
    this.seed();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'editor', 'viewer')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workbooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        snapshot TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL REFERENCES users(id),
        updated_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workbook_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        saved_by TEXT NOT NULL REFERENCES users(id),
        saved_at TEXT NOT NULL,
        UNIQUE(workbook_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_workbook_versions_workbook ON workbook_versions(workbook_id, version DESC);
      CREATE TABLE IF NOT EXISTS workbook_permissions (
        workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        access_level TEXT NOT NULL CHECK(access_level IN ('view', 'edit', 'design')),
        PRIMARY KEY(workbook_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workbook_id TEXT REFERENCES workbooks(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id),
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_workbook ON audit_logs(workbook_id, created_at DESC);
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(workbooks)').all().map((column) => column.name));
    const additions = [
      ['status', "TEXT NOT NULL DEFAULT 'draft'"],
      ['published_version', 'INTEGER'],
      ['published_snapshot', 'TEXT'],
      ['published_at', 'TEXT'],
      ['template_config', "TEXT NOT NULL DEFAULT '{}'"],
      ['data_source_config', "TEXT NOT NULL DEFAULT '{}'"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE workbooks ADD COLUMN ${name} ${definition}`);
    }
    // Additive migration; preserve legacy snapshots and flag inferred configuration.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workbook_releases (
        workbook_id TEXT NOT NULL REFERENCES workbooks(id), version INTEGER NOT NULL,
        name TEXT NOT NULL, description TEXT NOT NULL, snapshot TEXT NOT NULL,
        template_config TEXT NOT NULL, data_source_config TEXT NOT NULL,
        published_at TEXT NOT NULL, legacy_inferred INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workbook_id, version)
      );
      INSERT OR IGNORE INTO workbook_releases
        (workbook_id, version, name, description, snapshot, template_config, data_source_config, published_at, legacy_inferred)
      SELECT id, published_version, name, description, published_snapshot,
        template_config, data_source_config, published_at, 1
      FROM workbooks WHERE published_version IS NOT NULL AND published_snapshot IS NOT NULL;
    `);
  }

  seed() {
    const userCount = this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    if (userCount === 0) {
      const insert = this.db.prepare('INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      const createdAt = now();
      insert.run(crypto.randomUUID(), 'admin', '系统管理员', hashPassword('Admin123!'), 'admin', createdAt);
      insert.run(crypto.randomUUID(), 'editor', '业务编辑人员', hashPassword('Editor123!'), 'editor', createdAt);
      insert.run(crypto.randomUUID(), 'viewer', '只读查看人员', hashPassword('Viewer123!'), 'viewer', createdAt);
    }

    const workbookCount = this.db.prepare('SELECT COUNT(*) AS count FROM workbooks').get().count;
    if (workbookCount === 0) {
      const admin = this.db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
      this.createWorkbook({ name: '通用工作簿示例', description: '多工作表与公式验证样例', snapshot: createDefaultSnapshot(), userId: admin.id });
    }
  }

  authenticate(username, password) {
    const user = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !verifyPassword(password, user.password_hash)) return null;
    return { id: user.id, username: user.username, displayName: user.display_name, role: user.role };
  }

  createSession(userId) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    this.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
    return { token, expiresAt };
  }

  getUserBySession(token) {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token);
    if (!row || row.expires_at < now()) {
      if (row) this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
  }

  deleteSession(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  hasRole(user, minimumRole) {
    return Boolean(user && ROLE_LEVEL[user.role] >= ROLE_LEVEL[minimumRole]);
  }

  listWorkbooks(user = null) {
    const rows = this.db.prepare(`
      SELECT w.id, w.name, w.description, w.version, w.status, w.published_version AS publishedVersion,
             w.published_at AS publishedAt, w.created_at AS createdAt, w.updated_at AS updatedAt,
             u.display_name AS updatedBy
      FROM workbooks w JOIN users u ON u.id = w.updated_by
      ORDER BY w.updated_at DESC
    `).all();
    if (!user) return rows;
    return rows.flatMap((row) => {
      const accessLevel = this.getWorkbookAccess(user, row.id);
      if (accessLevel !== 'view') return [{ ...row, accessLevel }];
      const published = this.getPublishedWorkbook(row.id);
      return published ? [{ id: row.id, name: published.name, description: published.description,
        version: published.version, publishedVersion: published.version, status: 'published', accessLevel }] : [];
    });
  }

  getWorkbook(id) {
    const row = this.db.prepare('SELECT * FROM workbooks WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      version: row.version,
      status: row.status,
      publishedVersion: row.published_version,
      publishedAt: row.published_at,
      templateConfig: JSON.parse(row.template_config || '{}'),
      dataSourceConfig: JSON.parse(row.data_source_config || '{}'),
      snapshot: JSON.parse(row.snapshot),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createWorkbook({ name, description = '', snapshot, templateConfig = {}, dataSourceConfig = {}, userId }) {
    const id = crypto.randomUUID();
    const createdAt = now();
    const workbookSnapshot = snapshot ?? createDefaultSnapshot(name);
    workbookSnapshot.name = name;
    const encoded = JSON.stringify(workbookSnapshot);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO workbooks (id, name, description, snapshot, template_config, data_source_config, version, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(id, name, description, encoded, JSON.stringify(templateConfig), JSON.stringify(dataSourceConfig), userId, userId, createdAt, createdAt);
      this.db.prepare('INSERT INTO workbook_versions (workbook_id, version, snapshot, saved_by, saved_at) VALUES (?, 1, ?, ?, ?)')
        .run(id, encoded, userId, createdAt);
      this.db.prepare('INSERT OR REPLACE INTO workbook_permissions (workbook_id, user_id, access_level) VALUES (?, ?, ?)')
        .run(id, userId, 'design');
      this.logAudit({ workbookId: id, userId, action: 'create', detail: '创建模板草稿' });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getWorkbook(id);
  }

  saveWorkbook({ id, name, description = '', snapshot, expectedVersion, userId }) {
    const current = this.db.prepare('SELECT version FROM workbooks WHERE id = ?').get(id);
    if (!current) return { status: 'missing' };
    if (Number(expectedVersion) !== current.version) return { status: 'conflict', currentVersion: current.version };
    const nextVersion = current.version + 1;
    const savedAt = now();
    snapshot.name = name;
    const encoded = JSON.stringify(snapshot);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE workbooks SET name = ?, description = ?, snapshot = ?, version = ?, status = 'draft', updated_by = ?, updated_at = ? WHERE id = ?
      `).run(name, description, encoded, nextVersion, userId, savedAt, id);
      this.db.prepare('INSERT INTO workbook_versions (workbook_id, version, snapshot, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, nextVersion, encoded, userId, savedAt);
      this.logAudit({ workbookId: id, userId, action: 'save', detail: `保存工作簿版本 ${nextVersion}` });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { status: 'saved', workbook: this.getWorkbook(id) };
  }

  listVersions(id) {
    return this.db.prepare(`
      SELECT v.version, v.saved_at AS savedAt, u.display_name AS savedBy
      FROM workbook_versions v JOIN users u ON u.id = v.saved_by
      WHERE v.workbook_id = ? ORDER BY v.version DESC LIMIT 50
    `).all(id);
  }

  listUsers() {
    return this.db.prepare('SELECT id, username, display_name AS displayName, role FROM users ORDER BY role, username').all();
  }

  getWorkbookAccess(user, workbookId) {
    if (!user) return null;
    if (user.role === 'admin') return 'design';
    if (user.role === 'viewer') return 'view';
    const explicit = this.db.prepare('SELECT access_level FROM workbook_permissions WHERE workbook_id = ? AND user_id = ?').get(workbookId, user.id);
    if (explicit) return explicit.access_level;
    return user.role === 'editor' ? 'edit' : 'view';
  }

  hasWorkbookAccess(user, workbookId, required) {
    const level = { view: 1, edit: 2, design: 3 };
    return (level[this.getWorkbookAccess(user, workbookId)] ?? 0) >= level[required];
  }

  assertExpectedVersion(current, expectedVersion) {
    if (!Number.isInteger(expectedVersion)) throw Object.assign(new Error('请提供当前设计版本 expectedVersion'), { statusCode: 428 });
    if (expectedVersion !== current.version) throw Object.assign(new Error('设计已被更新，请刷新后重试'), { statusCode: 409 });
  }

  saveDesign({ id, templateConfig, dataSourceConfig, expectedVersion, userId }) {
    const current = this.getWorkbook(id);
    if (!current) return null;
    this.assertExpectedVersion(current, expectedVersion);
    for (const value of [templateConfig, dataSourceConfig]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw Object.assign(new Error('设计配置必须为对象'), { statusCode: 400 });
      }
    }
    this.validateTemplateModel(templateConfig, current.snapshot);
    const savedAt = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE workbooks SET template_config = ?, data_source_config = ?, version = ?, status = 'draft', updated_by = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(templateConfig), JSON.stringify(dataSourceConfig), current.version + 1, userId, savedAt, id);
      this.db.prepare('INSERT INTO workbook_versions (workbook_id, version, snapshot, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, current.version + 1, JSON.stringify(current.snapshot), userId, savedAt);
      this.logAudit({ workbookId: id, userId, action: 'configure', detail: `保存设计版本 ${current.version + 1}` });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getWorkbook(id);
  }

  publishWorkbook({ id, expectedVersion, userId }) {
    const row = this.db.prepare('SELECT * FROM workbooks WHERE id = ?').get(id);
    if (!row) return null;
    this.assertExpectedVersion(row, expectedVersion);
    this.validateTemplateModel(JSON.parse(row.template_config || '{}'), JSON.parse(row.snapshot));
    const nextModel = JSON.parse(row.template_config || '{}').businessModel;
    const published = this.getPublishedWorkbook(id);
    const previousModel = published?.templateConfig?.businessModel;
    if (nextModel && previousModel) {
      const { breaking } = diffModelSchema(previousModel, nextModel);
      if (breaking.length) {
        throw Object.assign(new Error(breaking.map((item) => `${item.path}：${item.message}`).join('；')), { statusCode: 422, issues: breaking });
      }
    }
    const existing = this.db.prepare('SELECT legacy_inferred FROM workbook_releases WHERE workbook_id = ? AND version = ?').get(id, row.version);
    if (existing?.legacy_inferred) throw Object.assign(new Error('旧版本配置来源未完整记录，请先保存新草稿再发布'), { statusCode: 409 });
    if (existing) return this.getWorkbook(id);
    const publishedAt = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO workbook_releases
        (workbook_id, version, name, description, snapshot, template_config, data_source_config, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, row.version, row.name, row.description, row.snapshot, row.template_config, row.data_source_config, publishedAt);
      this.db.prepare(`
        UPDATE workbooks SET status = 'published', published_version = ?, published_snapshot = ?, published_at = ?, updated_by = ?, updated_at = ? WHERE id = ?
      `).run(row.version, row.snapshot, publishedAt, userId, publishedAt, id);
      this.logAudit({ workbookId: id, userId, action: 'publish', detail: `发布版本 ${row.version}` });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getWorkbook(id);
  }

  listReleases(id) {
    return this.db.prepare('SELECT version, published_at AS publishedAt FROM workbook_releases WHERE workbook_id = ? ORDER BY version DESC').all(id);
  }

  rollbackPublishedWorkbook({ id, version, expectedVersion, userId }) {
    const current = this.getWorkbook(id);
    if (!current) return null;
    this.assertExpectedVersion(current, expectedVersion);
    if (!Number.isInteger(version) || version === current.publishedVersion) throw Object.assign(new Error('请选择不同的已发布版本'), { statusCode: 422 });
    const release = this.db.prepare('SELECT snapshot FROM workbook_releases WHERE workbook_id = ? AND version = ?').get(id, version);
    if (!release) throw Object.assign(new Error('目标发布版本不存在'), { statusCode: 404 });
    const stamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE workbooks SET status = 'published', published_version = ?, published_snapshot = ?, published_at = ?, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(version, release.snapshot, stamp, userId, stamp, id);
      this.logAudit({ workbookId: id, userId, action: 'rollback', detail: `发布版本回滚到 ${version}` });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getWorkbook(id);
  }

  validateTemplateModel(config, snapshot) {
    if (config.businessModel == null) return; // Legacy prototypes remain readable.
    const report = validateBusinessModel(config.businessModel, snapshot);
    if (!report.valid) throw Object.assign(new Error(report.issues.map((issue) => `${issue.path}: ${issue.message}`).join('；')), { statusCode: 422, issues: report.issues });
  }

  getPublishedWorkbook(id) {
    const row = this.db.prepare(`
      SELECT r.* FROM workbook_releases r JOIN workbooks w
        ON r.workbook_id = w.id AND r.version = w.published_version
      WHERE w.id = ?
    `).get(id);
    if (!row) return null;
    return {
      id: row.workbook_id, name: row.name, description: row.description, status: 'published',
      version: row.version, publishedVersion: row.version, publishedAt: row.published_at,
      legacyInferred: Boolean(row.legacy_inferred),
      snapshot: JSON.parse(row.snapshot),
      templateConfig: JSON.parse(row.template_config || '{}'),
      dataSourceConfig: JSON.parse(row.data_source_config || '{}'),
    };
  }

  getPermissions(id) {
    return this.db.prepare(`
      SELECT u.id AS userId, u.username, u.display_name AS displayName, u.role,
             CASE WHEN u.role = 'admin' THEN 'design' WHEN u.role = 'viewer' THEN 'view'
                  ELSE COALESCE(p.access_level, 'edit') END AS accessLevel
      FROM users u LEFT JOIN workbook_permissions p ON p.user_id = u.id AND p.workbook_id = ?
      ORDER BY u.role, u.username
    `).all(id);
  }

  savePermissions({ id, permissions, userId }) {
    if (!this.getWorkbook(id)) throw Object.assign(new Error('工作簿不存在'), { statusCode: 404 });
    const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
    if (!Array.isArray(permissions)) invalid('权限配置必须是数组');
    const users = new Map(this.listUsers().map((user) => [user.id, user]));
    const seen = new Set();
    for (const permission of permissions) {
      const user = users.get(permission?.userId);
      if (!user || !['view', 'edit', 'design'].includes(permission?.accessLevel)) invalid('权限配置包含无效用户或权限值');
      if (seen.has(user.id)) invalid('同一用户不能重复配置权限');
      seen.add(user.id);
      if ((user.role === 'admin' && permission.accessLevel !== 'design') || (user.role === 'viewer' && permission.accessLevel !== 'view')) {
        invalid('管理员固定为设计权限，只读账号固定为查看权限');
      }
    }
    const statement = this.db.prepare('INSERT OR REPLACE INTO workbook_permissions (workbook_id, user_id, access_level) VALUES (?, ?, ?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const permission of permissions) {
        statement.run(id, permission.userId, permission.accessLevel);
      }
      this.logAudit({ workbookId: id, userId, action: 'permission', detail: '更新模板级权限' });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getPermissions(id);
  }

  logAudit({ workbookId = null, userId, action, detail = '' }) {
    this.db.prepare('INSERT INTO audit_logs (workbook_id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(workbookId, userId, action, detail, now());
  }

  listAudit(id) {
    return this.db.prepare(`
      SELECT a.id, a.action, a.detail, a.created_at AS createdAt, u.display_name AS userName
      FROM audit_logs a JOIN users u ON u.id = a.user_id
      WHERE a.workbook_id = ? ORDER BY a.created_at DESC LIMIT 100
    `).all(id);
  }

  close() {
    this.db.close();
  }
}
