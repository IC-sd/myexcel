import { readFileSync } from 'node:fs';
import { compileScript, parse } from 'vue/compiler-sfc';
import { createRenderer, nextTick } from 'vue';

export const settle = async () => { await nextTick(); await new Promise((resolve) => setImmediate(resolve)); };
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Runs the actual setup/lifecycle functions with mock boundaries and no DOM.
// This is a logic test, NOT a browser/Univer rendering or interaction test.
export async function mountLogic(name, { props = {}, api = {}, univerAPI = {}, onEmit = () => {} } = {}) {
  const url = new URL(`../../src/components/${name}.vue`, import.meta.url);
  const { descriptor } = parse(readFileSync(url, 'utf8'), { filename: name });
  const slot = `component-test-${crypto.randomUUID()}`;
  globalThis[slot] = { api, univerAPI, window: globalThis.window };
  let source = `const fixture = globalThis[${JSON.stringify(slot)}]; const window = fixture.window;\n` + compileScript(descriptor, { id: slot }).content;
  source = source
    .replace(/import \{ api \} from [^;]+;/, 'const api = fixture.api;')
    .replace(/import \{ createUniver, LocaleType, mergeLocales \} from [^;]+;/, 'const createUniver = () => ({ univer: { dispose() {} }, univerAPI: fixture.univerAPI }); const LocaleType = { ZH_CN: "zhCN" }; const mergeLocales = x => x;')
    .replace(/import \{ UniverSheetsCorePreset \} from [^;]+;/, 'const UniverSheetsCorePreset = () => ({});')
    .replace(/import sheetsCoreZhCN from [^;]+;/, 'const sheetsCoreZhCN = {};')
    .replace(/import ['"][^'"]+\.css['"];?/g, '')
    .replace(/import (\w+) from ['"][^'"]+\.vue['"];?/g, 'const $1 = {};')
    .replace(/from\s+(['"])([^'"]+)\1/g, (_, quote, specifier) => `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier))}`);
  let component;
  try { component = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default; }
  finally { delete globalThis[slot]; }
  component.render = () => null;
  const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null });
  const handlers = Object.fromEntries(component.emits.map((name) => [`on${name[0].toUpperCase()}${name.slice(1)}`, (...args) => onEmit(name, ...args)]));
  const app = renderer.createApp(component, { ...props, ...handlers });
  app.mount({});
  await settle();
  return { state: app._instance.setupState, exposed: app._instance.exposed,
    async setProps(next) { Object.assign(app._instance.props, next); await settle(); },
    close() { app.unmount(); } };
}

export function installWindow(t, confirm = () => false) {
  const listeners = new Map();
  const original = globalThis.window;
  globalThis.window = { confirm, location: {}, addEventListener: (key, callback) => listeners.set(key, callback), removeEventListener: (key) => listeners.delete(key) };
  t.after(() => { if (original === undefined) delete globalThis.window; else globalThis.window = original; });
  return listeners;
}
