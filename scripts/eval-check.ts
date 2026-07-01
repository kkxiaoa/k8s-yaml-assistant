// 校验 eval-set 完整性(纯本地,不调 embedding/rerank,不花额度):
// 1. 每个 expectedChunkId 必须真实存在于 CORPUS;
// 2. case.resource 必须是白名单内的资源;
// 3. 报告覆盖的资源,便于看代表性。
// 用法:npm run eval:check

import { CORPUS } from '../src/knowledge/corpus';
import { EVAL_SET } from '../src/eval/eval-set';

const ids = new Set(CORPUS.map((c) => c.id));
const resources = new Set(CORPUS.map((c) => c.resource));

const missingIds: Array<{ q: string; id: string }> = [];
const badResource: Array<{ q: string; resource: string }> = [];

for (const ec of EVAL_SET) {
  if (!resources.has(ec.resource)) badResource.push({ q: ec.question, resource: ec.resource });
  for (const id of ec.expectedChunkIds) {
    if (!ids.has(id)) missingIds.push({ q: ec.question, id });
  }
}

const covered = new Set(EVAL_SET.map((c) => c.resource));
console.log(`=== eval-set 校验 ===`);
console.log(`用例数            : ${EVAL_SET.length}`);
console.log(`覆盖资源 (${covered.size}/${resources.size}) : ${[...covered].sort().join(', ')}`);
const uncovered = [...resources].filter((r) => !covered.has(r)).sort();
if (uncovered.length) console.log(`未覆盖资源        : ${uncovered.join(', ')}`);

if (badResource.length) {
  console.log(`\n✗ resource 不在语料(${badResource.length}):`);
  for (const b of badResource) console.log(`  [${b.resource}] ${b.q}`);
}
if (missingIds.length) {
  console.log(`\n✗ expectedChunkId 不存在(${missingIds.length}):`);
  for (const m of missingIds) console.log(`  ${m.id}   ← ${m.q}`);
}

if (missingIds.length === 0 && badResource.length === 0) {
  console.log(`\n✓ 全部 ${EVAL_SET.length} 条用例的 expectedChunkIds 均存在于 CORPUS。`);
} else {
  process.exit(1);
}
