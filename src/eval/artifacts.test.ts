import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendJsonl,
  readJsonl,
  tracePathForRun,
} from './artifacts';
import { EVAL_DIR, baselinePathFor, runKind, type EvalRun } from './run-store';

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

console.log('eval-artifacts:');

check('run-scoped trace path 固定到 data/eval/traces 且带 kind 后缀', () => {
  assert.equal(
    tracePathForRun('2026-07-10T00-00-00-000Z', 'faith'),
    join(EVAL_DIR, 'traces', '2026-07-10T00-00-00-000Z.faith.jsonl'),
  );
});

check('run id 拒绝路径穿越', () => {
  assert.throws(
    () => tracePathForRun('../bad', 'retrieval'),
    /invalid eval run id/,
  );
  assert.throws(
    () => tracePathForRun('bad/name', 'retrieval'),
    /invalid eval run id/,
  );
});

check('JSONL append/read 保持顺序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kya-artifacts-'));
  const path = join(dir, 'nested', 'rows.jsonl');
  appendJsonl(path, { id: 'a', value: 1 });
  appendJsonl(path, { id: 'b', value: 2 });

  assert.deepEqual(readJsonl<{ id: string; value: number }>(path), [
    { id: 'a', value: 1 },
    { id: 'b', value: 2 },
  ]);
});

check('EvalKind 支持所有 eval 类型且旧 run 默认 retrieval', () => {
  const baseRun: EvalRun = {
    id: 'run',
    createdAt: '2026-07-10T00:00:00.000Z',
    corpusHash: 'corpus',
    indexHash: 'index',
    embeddingModel: 'voyage-4',
    k: 3,
    metrics: {},
  };

  assert.equal(runKind(baseRun), 'retrieval');
  for (const kind of [
    'retrieval',
    'faith',
    'judge',
    'generation',
    'fix',
  ] as const) {
    assert.equal(runKind({ ...baseRun, kind }), kind);
  }
});

check('不同 eval kind 使用独立 baseline path', () => {
  assert.equal(baselinePathFor('retrieval'), join(EVAL_DIR, 'baseline.json'));
  assert.equal(
    baselinePathFor('faith'),
    join(EVAL_DIR, 'baseline.faith.json'),
  );
  assert.equal(
    baselinePathFor('judge'),
    join(EVAL_DIR, 'baseline.judge.json'),
  );
  assert.equal(
    baselinePathFor('generation'),
    join(EVAL_DIR, 'baseline.generation.json'),
  );
  assert.equal(baselinePathFor('fix'), join(EVAL_DIR, 'baseline.fix.json'));
});

console.log(`\n通过 ${passed} 项`);
