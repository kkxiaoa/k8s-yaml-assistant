import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evalArtifactPath,
  readTraceEnvelopes,
  runPath,
  traceRelativePath,
} from './artifacts';
import {
  decodeEvalRun,
  metricObservation,
  type EvalRun,
  type TraceEnvelope,
} from './protocol';
import {
  createErrorTraceEnvelope,
  createTraceEnvelope,
  startEvalRun,
  type EvalRunDefinition,
} from './run-session';

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

function evalRoot(): string {
  return mkdtempSync(join(tmpdir(), 'kya-run-session-'));
}

function definition(
  caseIds: string[] = ['case-1', 'case-2'],
  id = 'run-1',
): EvalRunDefinition {
  return {
    id,
    kind: 'retrieval',
    scope: 'full',
    dataset: {
      id: 'retrieval-cases',
      hash: 'a'.repeat(64),
      caseIds,
      caseCount: caseIds.length,
    },
    metricDefinitionVersion: 'legacy-v1',
    config: {
      corpusHash: 'b'.repeat(64),
      indexHash: 'c'.repeat(64),
      embeddingModel: 'voyage-4',
      rerankModel: 'rerank-2.5',
      queryExpansion: {
        enabled: true,
        registryHash: 'd'.repeat(64),
        reviewedAliasCount: 12,
      },
      k: 3,
    },
  };
}

function readRun(id: string, root: string): EvalRun {
  return decodeEvalRun(JSON.parse(readFileSync(runPath(id, root), 'utf8')));
}

function trace(
  evalCaseId: string,
  overrides: Partial<TraceEnvelope> = {},
): TraceEnvelope {
  return {
    ...createTraceEnvelope({
      runId: 'run-1',
      evalCaseId,
      kind: 'retrieval',
      outcome: 'success',
      payload: { rank: 1 },
    }),
    ...overrides,
  };
}

console.log('eval-run-session:');

check('startEvalRun immediately persists a running run', () => {
  const root = evalRoot();
  const session = startEvalRun(definition(), { evalRoot: root });
  const run = readRun('run-1', root);

  assert.equal(session.id, 'run-1');
  assert.equal(session.kind, 'retrieval');
  assert.equal(run.status, 'running');
  assert.equal(run.artifactPaths.trace, 'traces/run-1.retrieval.jsonl');
  assert.deepEqual(run.metrics, {});
  assert.equal('completedAt' in run, false);
  assert.equal('failure' in run, false);
  assert.equal(
    existsSync(
      evalArtifactPath(traceRelativePath('run-1', 'retrieval'), root),
    ),
    false,
  );
  assert.deepEqual(readdirSync(join(root, 'runs')), ['run-1.json']);
});

check('startEvalRun refuses existing run or orphan trace artifacts', () => {
  const runRoot = evalRoot();
  startEvalRun(definition(), { evalRoot: runRoot });
  assert.throws(
    () => startEvalRun(definition(), { evalRoot: runRoot }),
    /eval run already exists: run-1/,
  );

  const traceRoot = evalRoot();
  const orphanTracePath = evalArtifactPath(
    traceRelativePath('run-1', 'retrieval'),
    traceRoot,
  );
  mkdirSync(join(traceRoot, 'traces'), { recursive: true });
  writeFileSync(orphanTracePath, `${JSON.stringify(trace('case-1'))}\n`, {
    flag: 'wx',
  });
  assert.throws(
    () => startEvalRun(definition(), { evalRoot: traceRoot }),
    /eval trace already exists: traces\/run-1\.retrieval\.jsonl/,
  );
  assert.equal(existsSync(runPath('run-1', traceRoot)), false);
});

check('trace helper generates protocol-valid unique trace IDs', () => {
  const first = trace('case-1');
  const second = trace('case-2');

  assert.notEqual(first.traceId, second.traceId);
  assert.notEqual(first.traceId, `${first.runId}:${first.evalCaseId}`);
  assert.match(first.createdAt, /^2026-|^20\d\d-/);
});

check('each eval case and trace ID can be appended only once', () => {
  const root = evalRoot();
  const session = startEvalRun(definition(['case-1', 'case-2', 'case-3']), {
    evalRoot: root,
  });
  const first = trace('case-1');
  session.appendCase(first);

  assert.throws(
    () => session.appendCase(trace('case-1')),
    /evalCaseId case-1 already has a final trace/,
  );
  assert.throws(
    () =>
      session.appendCase(
        trace('case-2', {
          traceId: first.traceId,
        }),
      ),
    new RegExp(`traceId ${first.traceId} already exists`),
  );

  const tracePath = evalArtifactPath(
    traceRelativePath('run-1', 'retrieval'),
    root,
  );
  assert.deepEqual(
    readTraceEnvelopes(tracePath).map((envelope) => envelope.evalCaseId),
    ['case-1'],
  );
});

check('append rejects mismatched run, kind, and dataset case IDs', () => {
  const root = evalRoot();
  const session = startEvalRun(definition(), { evalRoot: root });

  assert.throws(
    () => session.appendCase(trace('case-1', { runId: 'other-run' })),
    /runId other-run does not match session run-1/,
  );
  assert.throws(
    () => session.appendCase(trace('case-1', { kind: 'faith' })),
    /kind faith does not match session retrieval/,
  );
  assert.throws(
    () => session.appendCase(trace('unknown-case')),
    /evalCaseId unknown-case is not in dataset/,
  );

  assert.equal(
    existsSync(
      evalArtifactPath(traceRelativePath('run-1', 'retrieval'), root),
    ),
    false,
  );
});

check('complete accepts success, skipped, and error outcomes', () => {
  const root = evalRoot();
  const session = startEvalRun(
    definition(['case-success', 'case-skipped', 'case-error']),
    { evalRoot: root },
  );
  session.appendCase(trace('case-success'));
  session.appendCase(trace('case-skipped', { outcome: 'skipped' }));
  session.appendCase(
    createErrorTraceEnvelope({
      runId: 'run-1',
      evalCaseId: 'case-error',
      kind: 'retrieval',
      payload: { rank: 0 },
      stage: 'rerank',
      error: new Error('rerank failed token=case-secret'),
    }),
  );

  const metrics = {
    'cases.completed': metricObservation(1, 3, 3),
  };
  session.complete(metrics);

  const run = readRun('run-1', root);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.metrics, metrics);
  assert.equal(typeof run.completedAt, 'string');
  assert.equal('failure' in run, false);

  const envelopes = readTraceEnvelopes(
    evalArtifactPath(traceRelativePath('run-1', 'retrieval'), root),
  );
  assert.deepEqual(
    envelopes.map((envelope) => envelope.outcome),
    ['success', 'skipped', 'error'],
  );
  assert.equal(envelopes[2]?.error?.message.includes('case-secret'), false);
  assert.match(envelopes[2]?.error?.message ?? '', /\[REDACTED\]/);

  assert.throws(() => session.appendCase(trace('case-success')), /completed/);
  assert.throws(() => session.complete(metrics), /completed/);
  assert.throws(() => session.fail('runner', new Error('late')), /completed/);
});

check('complete rejects missing or tampered trace coverage', () => {
  const root = evalRoot();
  const session = startEvalRun(definition(), { evalRoot: root });
  const first = trace('case-1');
  session.appendCase(first);

  assert.throws(
    () => session.complete({}),
    /trace coverage mismatch: missing case-2/,
  );
  assert.equal(readRun('run-1', root).status, 'running');

  const second = trace('case-2');
  session.appendCase(second);
  const tracePath = evalArtifactPath(
    traceRelativePath('run-1', 'retrieval'),
    root,
  );
  writeFileSync(tracePath, `${JSON.stringify(first)}\n`);

  assert.throws(
    () => session.complete({}),
    /trace coverage mismatch: missing case-2/,
  );
  assert.equal(readRun('run-1', root).status, 'running');
});

check('failed run keeps prior error trace without fabricating missing cases', () => {
  const root = evalRoot();
  const session = startEvalRun(definition(), { evalRoot: root });
  session.appendCase(
    createErrorTraceEnvelope({
      runId: 'run-1',
      evalCaseId: 'case-1',
      kind: 'retrieval',
      payload: { rank: 0 },
      stage: 'embedding',
      error: new Error('embedding failed authorization=Bearer case-token'),
    }),
  );

  const failure = new Error(
    'request failed api_key=run-secret password="hunter two"',
  );
  failure.stack = 'STACK containing run-secret and internal frames';
  session.fail('runner', failure);

  const run = readRun('run-1', root);
  assert.equal(run.status, 'failed');
  assert.equal(run.failure?.stage, 'runner');
  assert.match(run.failure?.message ?? '', /\[REDACTED\]/);
  assert.doesNotMatch(run.failure?.message ?? '', /run-secret|hunter|STACK/);
  assert.equal(typeof run.completedAt, 'string');

  const envelopes = readTraceEnvelopes(
    evalArtifactPath(traceRelativePath('run-1', 'retrieval'), root),
  );
  assert.deepEqual(
    envelopes.map((envelope) => envelope.evalCaseId),
    ['case-1'],
  );
  assert.equal(envelopes[0]?.error?.message.includes('case-token'), false);
  assert.deepEqual(readdirSync(join(root, 'runs')), ['run-1.json']);

  assert.throws(() => session.appendCase(trace('case-2')), /failed/);
  assert.throws(() => session.complete({}), /failed/);
  assert.throws(() => session.fail('runner', failure), /failed/);
});

check('an empty dataset completes without a fabricated trace file', () => {
  const root = evalRoot();
  const session = startEvalRun(definition([]), { evalRoot: root });
  session.complete({ 'cases.completed': metricObservation(null, 0, 0) });

  assert.equal(readRun('run-1', root).status, 'completed');
  assert.equal(
    existsSync(
      evalArtifactPath(traceRelativePath('run-1', 'retrieval'), root),
    ),
    false,
  );
});

console.log(`\n通过 ${passed} 项`);
