import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  baselinePath,
  runPath,
  writeJsonAtomic,
} from './artifacts';
import {
  latestRun,
  listRuns,
  readBaseline,
  readRun,
} from './run-store';
import {
  EVAL_SCHEMA_VERSION,
  metricObservation,
  type EvalBaseline,
  type EvalRun,
} from './protocol';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(
      `  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const GOVERNANCE = {
  task: 'field_explanation',
  origin: 'human',
  role: 'development',
} as const;

function runFixture(
  id: string,
  createdAt = '2026-07-12T00:00:00.000Z',
): Extract<EvalRun, { kind: 'retrieval' }> {
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    id,
    kind: 'retrieval',
    status: 'completed',
    scope: 'full',
    createdAt,
    completedAt: createdAt,
    dataset: {
      id: 'retrieval/semantic',
      hash: HASH_A,
      cases: [{ id: 'case-1', governance: GOVERNANCE }],
      caseCount: 1,
    },
    artifactPaths: { trace: `traces/${id}.retrieval.jsonl` },
    metricDefinitionVersion: 'legacy-v1',
    config: {
      corpusManifestHash: HASH_B,
      indexHash: HASH_B,
      embeddingModel: 'embedding-model',
      rerankModel: 'rerank-model',
      queryExpansion: {
        enabled: false,
        registryHash: null,
        reviewedAliasCount: 0,
      },
      k: 3,
    },
    metrics: {
      'retrieval.recall': metricObservation(1, 1, 1),
    },
  };
}

function baselineFixture(): EvalBaseline {
  const run = runFixture('run-1');
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    sourceRunId: run.id,
    promotedAt: '2026-07-12T01:00:00.000Z',
    kind: run.kind,
    scope: run.scope,
    dataset: run.dataset,
    metricDefinitionVersion: run.metricDefinitionVersion,
    config: run.config,
    metrics: run.metrics,
  };
}

console.log('run-store:');

check('readRun resolves by run id and runtime-decodes the artifact', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'run-store-'));
  writeJsonAtomic(runPath('run-1', evalRoot), runFixture('run-1'));

  assert.deepEqual(readRun('run-1', { evalRoot }), runFixture('run-1'));
});

check('readRun rejects old or malformed contracts instead of defaulting them', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'run-store-'));
  writeJsonAtomic(runPath('legacy', evalRoot), {
    id: 'legacy',
    createdAt: '2026-07-12T00:00:00.000Z',
    metrics: {},
  });

  assert.throws(() => readRun('legacy', { evalRoot }), /invalid eval run/);
});

check('readRun preserves artifact context for malformed JSON', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'run-store-'));
  const path = runPath('broken-json', evalRoot);
  writeJsonAtomic(path, {});
  writeFileSync(path, '{');

  assert.throws(
    () => readRun('broken-json', { evalRoot }),
    /invalid eval run broken-json: invalid eval run JSON at/,
  );
});

check('readRun rejects a filename/run-id mismatch', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'run-store-'));
  writeJsonAtomic(runPath('run-1', evalRoot), runFixture('other-run'));

  assert.throws(
    () => readRun('run-1', { evalRoot }),
    /run id mismatch.*run-1.*other-run/,
  );
});

check('listRuns decodes every file, filters by kind, and latestRun uses createdAt', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'run-store-'));
  writeJsonAtomic(
    runPath('z-older', evalRoot),
    runFixture('z-older', '2026-07-12T00:00:00.000Z'),
  );
  writeJsonAtomic(
    runPath('a-newer', evalRoot),
    runFixture('a-newer', '2026-07-12T01:00:00.000Z'),
  );

  assert.deepEqual(
    listRuns({ kind: 'retrieval', evalRoot }).map((run) => run.id),
    ['z-older', 'a-newer'],
  );
  assert.equal(latestRun({ kind: 'retrieval', evalRoot })?.id, 'a-newer');
  assert.equal(latestRun({ kind: 'faith', evalRoot }), null);
});

check('listRuns fails loudly when a run artifact cannot be decoded', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'run-store-'));
  writeJsonAtomic(runPath('invalid', evalRoot), { id: 'invalid' });

  assert.throws(() => listRuns({ evalRoot }), /invalid eval run/);
});

check('readBaseline uses the per-kind portable layout and decoder', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'run-store-'));
  assert.equal(readBaseline('retrieval', { evalRoot }), null);

  const baseline = baselineFixture();
  writeJsonAtomic(baselinePath('retrieval', evalRoot), baseline);
  assert.deepEqual(readBaseline('retrieval', { evalRoot }), baseline);

  writeJsonAtomic(baselinePath('faith', evalRoot), runFixture('not-baseline'));
  assert.throws(
    () => readBaseline('faith', { evalRoot }),
    /invalid eval baseline/,
  );
});

console.log(`\n通过 ${passed} 项`);
