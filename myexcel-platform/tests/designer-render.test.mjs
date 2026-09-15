import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { compileScript, parse } from 'vue/compiler-sfc';
import { orderFixture } from './fixtures/business-model.mjs';

// SSR validates template rendering and state branches, not browser interaction.
const componentURL = new URL('../src/components/DataModelDesigner.vue', import.meta.url);
const { descriptor } = parse(readFileSync(componentURL, 'utf8'), { filename: componentURL.pathname });
const compiled = compileScript(descriptor, { id: 'model-test', inlineTemplate: true, templateOptions: { ssr: true } });
const source = compiled.content.replace(/from\s+(['"])([^'"]+)\1/g, (_, quote, specifier) => {
  const url = specifier.startsWith('.') ? new URL(specifier, componentURL).href : import.meta.resolve(specifier === 'vue/server-renderer' || specifier === '@vue/server-renderer' ? 'vue/server-renderer' : specifier);
  return `from ${JSON.stringify(url)}`;
});
const { default: Designer } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const render = (modelValue, snapshot) => renderToString(createSSRApp(Designer, { modelValue, snapshot, workbookId: 'fixture', version: 1 }));

test('designer renders an explicit opt-in for legacy templates', async () => {
  const html = await render(null, orderFixture().snapshot);
  assert.match(html, /启用业务数据模型/);
  assert.match(html, /旧版字段说明不等于数据库字段绑定/);
});

test('designer renders stable relationships, editable bindings and validation state', async () => {
  const { model, snapshot } = orderFixture();
  const html = await render(model, snapshot);
  assert.match(html, /模型和绑定校验通过/);
  assert.match(html, /item.order_id → order/);
  assert.match(html, /主表单元格 1/);
  assert.match(html, /明细列 1-1/);
  assert.match(html, /业务记录入口可选择有权访问的关联记录/);
  assert.match(html, /工作人员字段状态/);
  assert.match(html, /只读人员字段状态/);
  assert.match(html, /公式兼容检查/);
  assert.match(html, /模拟关联权限角色/);
  assert.match(html, /稳定记录 ID，因此数据库主键保证不会出现多匹配/);
  model.document.fields[0].cell = 'C6';
  const invalid = await render(model, snapshot);
  assert.match(invalid, /输入绑定不能覆盖公式单元格/);
  assert.match(invalid, /disabled[^>]*>校验并提取测试数据/);
});
