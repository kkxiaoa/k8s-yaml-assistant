// 校验 eval-set 完整性(纯本地,不调 embedding/rerank,不花额度):
// 1. id 唯一;
// 2. 可答用例:expectedChunkIds 非空且都存在于 CORPUS,resource 在白名单;
// 3. 拒答用例(answerable=false):expectedChunkIds 必须为空;
// 4. 报告覆盖资源与拒答数,便于看代表性。
// 用法:npm run eval:check

import { CORPUS } from '../src/knowledge/corpus';
import { EVAL_SET } from '../src/eval/eval-set';

const ids = new Set(CORPUS.map((c) => c.id));
const resources = new Set(CORPUS.map((c) => c.resource));

const problems: string[] = [];

// 1. id 唯一
const seen = new Set<string>();
for (const ec of EVAL_SET) {
  if (seen.has(ec.id)) problems.push(`重复 id: ${ec.id}`);
  seen.add(ec.id);
}

// 2 & 3. 分可答/拒答校验
const answerableCases = EVAL_SET.filter((c) => c.answerable);
const refusalCases = EVAL_SET.filter((c) => !c.answerable);

for (const ec of answerableCases) {
  if (!ec.resource) problems.push(`[${ec.id}] 可答用例缺 resource`);
  else if (!resources.has(ec.resource))
    problems.push(`[${ec.id}] resource "${ec.resource}" 不在语料`);
  if (ec.expectedChunkIds.length === 0)
    problems.push(`[${ec.id}] 可答用例 expectedChunkIds 为空`);
  for (const id of ec.expectedChunkIds) {
    if (!ids.has(id)) problems.push(`[${ec.id}] expectedChunkId 不存在: ${id}`);
  }
}

for (const ec of refusalCases) {
  if (ec.expectedChunkIds.length > 0)
    problems.push(`[${ec.id}] 拒答用例不应有 expectedChunkIds`);
}

const covered = new Set(answerableCases.map((c) => c.resource));
console.log('=== eval-set 校验 ===');
console.log(`用例数            : ${EVAL_SET.length}(可答 ${answerableCases.length} / 拒答 ${refusalCases.length})`);
console.log(`覆盖资源 (${covered.size}/${resources.size}) : ${[...covered].sort().join(', ')}`);
const uncovered = [...resources].filter((r) => !covered.has(r)).sort();
if (uncovered.length) console.log(`未覆盖资源        : ${uncovered.join(', ')}`);

if (problems.length) {
  console.log(`\n✗ 发现 ${problems.length} 处问题:`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
} else {
  console.log(`\n✓ id 唯一;${answerableCases.length} 条可答用例 expectedChunkIds 均命中 CORPUS;${refusalCases.length} 条拒答用例结构正确。`);
}
