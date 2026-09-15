import assert from 'node:assert/strict';
import test from 'node:test';
import { detailRowIdentities, newRecordDraft } from '../shared/record-editor.mjs';
import { orderFixture } from './fixtures/business-model.mjs';
import { demoDefinitions } from '../server/business/demo.mjs';
import { validateBusinessModel } from '../shared/business-model.mjs';

test('all synthetic demo templates have valid, shared master/detail contracts', () => {
  const templates = demoDefinitions();
  assert.deepEqual(templates.map((item) => item.key), ['contact', 'catalog_item', 'request']);
  for (const template of templates) assert.deepEqual(validateBusinessModel(template.model, template.snapshot), { valid: true, issues: [] });
  assert.deepEqual(templates[0].model.entities, templates[2].model.entities);
});

test('record editor separates empty data from template values and maps stable identities to grid rows', () => {
  const { model } = orderFixture(); const form = newRecordDraft(model, 3);
  assert.deepEqual(form.values, {}); assert.deepEqual(form.details.items, []);
  form.details.items = [{ id: 'stable-a' }, { id: 'stable-b' }];
  assert.deepEqual(detailRowIdentities(model, form), { items: ['stable-a', 'stable-b', null] });
});
