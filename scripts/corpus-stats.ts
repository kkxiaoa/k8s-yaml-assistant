// 语料统计:可复现 chunk/resource 口径,并核对 curated 白名单的命中/缺失。
// 用法:npm run corpus:stats

import { buildCorpusManifest, CORPUS } from '../src/knowledge/corpus';
import { chunkResources } from '../src/knowledge/chunk';
import { SCHEMA_DOCS } from '../src/knowledge/schemas';
import curated from '../data/schemas/curated.json';

interface CuratedEntry {
  kind: string;
  apiVersion: string;
}

const builtin = curated.builtin as CuratedEntry[];
const crd = curated.crd as CuratedEntry[];

const loadedKeys = new Set(
  SCHEMA_DOCS.map((d) => `${d.apiVersion}/${d.kind ?? d.resource}`),
);

// 每资源 chunk 数
const perResource = new Map<string, number>();
for (const c of CORPUS) {
  for (const resource of chunkResources(c))
    perResource.set(resource, (perResource.get(resource) ?? 0) + 1);
}
const manifest = buildCorpusManifest();

console.log('=== 语料规模 ===');
console.log(`chunks(CORPUS.length)        : ${CORPUS.length}`);
console.log(`resources(unique resource)   : ${perResource.size}`);
console.log(`schema docs(loaded)          : ${SCHEMA_DOCS.length}`);
console.log(`corpus content hash          : ${manifest.contentHash}`);
console.log(`corpus manifest hash         : ${manifest.manifestHash}`);

console.log('\n=== Provider manifest ===');
for (const provider of manifest.providers)
  console.log(
    `${provider.providerId.padEnd(24)} source=${provider.sourceType.padEnd(8)} count=${provider.count} contentHash=${provider.contentHash} manifestHash=${provider.manifestHash}`,
  );

console.log('\n=== 每资源 chunk 数(降序) ===');
for (const [res, n] of [...perResource.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(5)}  ${res}`);
}

console.log('\n=== curated 白名单命中情况 ===');
const missing: string[] = [];
for (const e of [...builtin, ...crd]) {
  const key = `${e.apiVersion}/${e.kind}`;
  const ok = loadedKeys.has(key);
  if (!ok) missing.push(key);
  console.log(`${ok ? '✓' : '✗ 缺'}  ${key}`);
}
console.log(
  `\n白名单 ${builtin.length + crd.length} 项,命中 ${builtin.length + crd.length - missing.length},缺失 ${missing.length}`,
);
if (missing.length)
  console.log(
    `缺失项(检查 apiVersion/kind 是否与 generated 一致): ${missing.join(', ')}`,
  );
