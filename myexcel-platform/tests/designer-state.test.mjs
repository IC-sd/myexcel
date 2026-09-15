import assert from 'node:assert/strict';
import test from 'node:test';
import { mountLogic, installWindow, deferred, settle } from './fixtures/component-logic.mjs';

const book = (id = 'a') => ({ id, name: id, version: 1, templateConfig: { fields: [], formulas: [] }, dataSourceConfig: {} });
const services = () => ({ getPermissions: async () => ({ permissions: [] }), getAudit: async () => ({ audit: [] }) });

test('designer preserves empty config, isolates template state and guards unsaved changes', async (t) => {
  const listeners = installWindow(t);
  const first = book(); first.dataSourceConfig = { type: 'static', name: 'A-only' };
  const view = await mountLogic('DesignerPanel', { props: { workbook: first, user: { role: 'admin' } }, api: services() });
  t.after(() => view.close());
  assert.equal(view.state.fields.length, 0);
  assert.equal(view.state.formulas.length, 0);
  assert.equal(typeof view.exposed.mayLeave, 'function');
  assert.equal(view.exposed.mayLeave(), true);
  view.state.dataSource.name = 'unsaved';
  assert.equal(view.exposed.mayLeave(), false);
  let prevented = false;
  listeners.get('beforeunload')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await view.setProps({ workbook: book('b') });
  assert.notEqual(view.state.dataSource.name, 'A-only');
  assert.notEqual(view.state.dataSource.name, 'unsaved');
  assert.equal(view.state.dirty, false);
});

test('designer ignores stale loads and keeps drafts on failed saves without duplicate requests', async (t) => {
  installWindow(t);
  const old = deferred(), save = deferred(); let saves = 0;
  const api = { ...services(), getPermissions: (id) => id === 'a' ? old.promise : Promise.resolve({ permissions: [{ userId: 'b', role: 'editor', accessLevel: 'edit' }] }),
    saveDesign: () => { saves++; return save.promise; } };
  const view = await mountLogic('DesignerPanel', { props: { workbook: book(), user: { role: 'admin' } }, api });
  t.after(() => view.close());
  await view.setProps({ workbook: book('b') });
  old.resolve({ permissions: [{ userId: 'a', accessLevel: 'view' }] }); await settle();
  assert.equal(view.state.permissions[0].userId, 'b');
  view.state.dataSource.name = 'keep draft';
  const pending = view.state.saveDesign();
  await view.state.saveDesign();
  assert.equal(saves, 1);
  assert.equal(view.exposed.mayLeave(), false);
  save.reject(new Error('offline')); await pending;
  assert.equal(view.state.dataSource.name, 'keep draft');
  assert.equal(view.state.dirty, true);
  assert.equal(view.state.busy, false);
});

test('permission save failure keeps advanced version and prevents publication', async (t) => {
  installWindow(t); let publishes = 0, view;
  const api = { ...services(), saveDesign: async () => ({ workbook: { ...book(), version: 2 } }),
    savePermissions: async () => { throw new Error('permission offline'); },
    publishWorkbook: async () => { publishes++; } };
  view = await mountLogic('DesignerPanel', { props: { workbook: book(), user: { role: 'admin' } }, api,
    onEmit: (event, workbook) => { if (event === 'updated') void view.setProps({ workbook }); } });
  t.after(() => view.close());
  view.state.dataSource.name = 'draft';
  await view.state.publish();
  assert.equal(publishes, 0);
  assert.equal(view.state.props.workbook.version, 2);
  assert.equal(view.state.dirty, true);
  assert.match(view.state.message, /已保存.*权限保存失败/);
});
