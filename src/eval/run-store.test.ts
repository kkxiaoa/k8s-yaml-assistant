import assert from 'node:assert/strict';
import {
  queryExpansionRunConfig,
  runKind,
  type EvalRun,
} from './run-store';
import type { QueryExpansionTrace } from '../retrieval/query-expansion-runtime';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(
      `  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exitCode = 1;
  }
}

console.log('run-store:');

check('query expansion trace 映射为可复现 run 配置', () => {
  const trace: QueryExpansionTrace = {
    enabled: true,
    status: 'applied',
    originalQueryText: '怎么把卷设成裸块设备?',
    expandedQueryText: '怎么把卷设成裸块设备?\n字段术语: volumeMode',
    matchedAliases: [],
    expansionTerms: ['volumeMode'],
    registryHash:
      '63d6cfe02b6c016f3dba330537a434787c83af992d724b11043f421e6003e177',
    reviewedAliasCount: 11,
  };

  assert.deepEqual(queryExpansionRunConfig(trace), {
    enabled: true,
    registryHash: trace.registryHash,
    reviewedAliasCount: 11,
  });
});

check('旧 run 不含 query expansion 配置时仍兼容', () => {
  const legacyRun: EvalRun = {
    id: 'legacy',
    createdAt: '2026-07-06T00:00:00.000Z',
    corpusHash: 'corpus',
    indexHash: 'index',
    embeddingModel: 'voyage-3',
    k: 3,
    metrics: {},
  };

  assert.equal(runKind(legacyRun), 'retrieval');
  assert.equal(legacyRun.queryExpansion, undefined);
});

console.log(`\n通过 ${passed} 项`);
