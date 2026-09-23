import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSyntheticWorkbookBenchmark } from '../server/benchmark.mjs';

const dist = new URL('../dist/', import.meta.url);
const indexHtml = readFileSync(new URL('index.html', dist), 'utf8');
const entryName = indexHtml.match(/src="\.\/assets\/([^"]+\.js)"/)?.[1] || indexHtml.match(/src="\/assets\/([^"]+\.js)"/)?.[1];
const workspaceName = readdirSync(dist).length && readdirSync(new URL('assets/', dist)).find((name) => /^WorkspaceView-.*\.js$/.test(name));

function asset(name) {
  if (!name) throw new Error('生产构建未包含预期的入口或 WorkspaceView 懒加载文件；请先执行 npm run build');
  const buffer = readFileSync(new URL(`assets/${name}`, dist));
  return { file: basename(name), rawBytes: buffer.length, gzipBytes: gzipSync(buffer).length };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function workload(rows, columns) {
  const generate = [], serialize = [];
  let bytes = 0;
  for (let index = 0; index < 5; index += 1) {
    const begin = performance.now();
    const snapshot = createSyntheticWorkbookBenchmark(rows, columns);
    const generated = performance.now();
    const encoded = JSON.stringify(snapshot);
    const serialized = performance.now();
    generate.push(generated - begin);
    serialize.push(serialized - generated);
    bytes = Buffer.byteLength(encoded);
  }
  return { rows, columns, jsonBytes: bytes, generateMedianMs: Number(median(generate).toFixed(2)), serializeMedianMs: Number(median(serialize).toFixed(2)) };
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  lazyLoading: {
    entry: asset(entryName),
    workspace: asset(workspaceName),
    verified: !indexHtml.includes(workspaceName),
  },
  syntheticWorkloads: [workload(100, 26), workload(1000, 200), workload(10000, 200)],
};

const budgets = {
  entryGzipBytes: 80 * 1024,
  workspaceGzipBytes: 3 * 1024 * 1024,
  rows10000GenerateMs: 1000,
  rows10000SerializeMs: 1000,
};
report.budgets = budgets;
report.passed = report.lazyLoading.verified
  && report.lazyLoading.entry.gzipBytes <= budgets.entryGzipBytes
  && report.lazyLoading.workspace.gzipBytes <= budgets.workspaceGzipBytes
  && report.syntheticWorkloads[2].generateMedianMs <= budgets.rows10000GenerateMs
  && report.syntheticWorkloads[2].serializeMedianMs <= budgets.rows10000SerializeMs;

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
