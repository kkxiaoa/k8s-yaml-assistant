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
  EVAL_CASE_ERROR_STAGES,
  EVAL_RUN_FATAL_STAGES,
  decodeEvalRun,
  metricObservation,
  type EvalRun,
  type TraceEnvelope,
} from './protocol';
import { METRIC_DEFINITION_VERSION } from './metrics/definitions';
import {
  EvalCaseExecutionError,
  EvalRunExecutionError,
  createErrorTraceEnvelope,
  createTraceEnvelope,
  executeEvalCases,
  executeEvalRunStage,
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

async function checkAsync(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
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

const GOVERNANCE = {
  task: 'field_explanation',
  origin: 'human',
  role: 'development',
} as const;

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
      cases: caseIds.map((caseId) => ({
        id: caseId,
        governance: GOVERNANCE,
      })),
      caseCount: caseIds.length,
    },
    metricDefinitionVersion: METRIC_DEFINITION_VERSION,
    config: {
      corpusContentHash: 'b'.repeat(64),
      corpusManifestHash: 'e'.repeat(64),
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

function retrievalMetrics(
  caseCount: number,
  harnessErrorCount = 0,
): Record<string, ReturnType<typeof metricObservation>> {
  return {
    'retrieval.semantic.recall': metricObservation(
      caseCount === 0 ? null : 1,
      caseCount,
      caseCount,
    ),
    'retrieval.semantic.mrr': metricObservation(
      caseCount === 0 ? null : 1,
      caseCount,
      caseCount,
    ),
    'retrieval.harness_error_count': metricObservation(harnessErrorCount),
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
      governance: GOVERNANCE,
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

check('append rejects governance that differs from the dataset case', () => {
  const root = evalRoot();
  const session = startEvalRun(definition(['case-1']), { evalRoot: root });

  assert.throws(
    () =>
      session.appendCase(
        trace('case-1', {
          governance: { ...GOVERNANCE, role: 'regression' },
        }),
      ),
    /governance/i,
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
      governance: GOVERNANCE,
      kind: 'retrieval',
      payload: { rank: 0 },
      stage: 'rerank',
      error: new Error('rerank failed token=case-secret'),
    }),
  );

  const metrics = retrievalMetrics(2, 1);
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
  assert.throws(
    () => session.fail('artifact_write', new Error('late')),
    /completed/,
  );
});

check('complete enforces the current registered metric contract', () => {
  const staleRoot = evalRoot();
  const staleSession = startEvalRun(
    {
      ...definition(['case-1'], 'stale-run'),
      metricDefinitionVersion: 'legacy-v1',
    },
    { evalRoot: staleRoot },
  );
  staleSession.appendCase(
    trace('case-1', { runId: 'stale-run' }),
  );
  assert.throws(
    () => staleSession.complete(retrievalMetrics(1)),
    (error: unknown) => {
      assert.ok(error instanceof EvalRunExecutionError);
      assert.equal(error.stage, 'metric_aggregation');
      assert.match(error.message, /metric definition version.*current/i);
      return true;
    },
  );
  assert.equal(readRun('stale-run', staleRoot).status, 'running');

  const root = evalRoot();
  const session = startEvalRun(definition(['case-1']), { evalRoot: root });
  session.appendCase(trace('case-1'));
  assert.throws(
    () =>
      session.complete({
        ...retrievalMetrics(1),
        'retrieval.unregistered': metricObservation(0),
      }),
    /unregistered metric key.*retrieval\.unregistered/i,
  );

  const missingRequired = retrievalMetrics(1);
  delete missingRequired['retrieval.semantic.recall'];
  assert.throws(
    () => session.complete(missingRequired),
    /missing required metric.*retrieval\.semantic\.recall/i,
  );

  session.complete(retrievalMetrics(1));
  assert.equal(readRun('run-1', root).status, 'completed');
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
      governance: GOVERNANCE,
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
  session.fail('runner_initialization', failure);

  const run = readRun('run-1', root);
  assert.equal(run.status, 'failed');
  assert.equal(run.failure?.stage, 'runner_initialization');
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
  assert.throws(() => session.fail('runner_initialization', failure), /failed/);
});

await checkAsync(
  'every case-error stage writes one error envelope and continues the batch',
  async () => {
    for (const [index, stage] of EVAL_CASE_ERROR_STAGES.entries()) {
      const root = evalRoot();
      const runId = `run-case-stage-${index}`;
      const caseIds = ['case-before', 'case-error', 'case-after'];
      const session = startEvalRun(definition(caseIds, runId), {
        evalRoot: root,
      });
      const summary = await executeEvalCases({
        cases: caseIds.map((id) => ({ id })),
        evaluate: async (evalCase) => {
          if (evalCase.id === 'case-error') {
            throw new EvalCaseExecutionError(
              stage,
              new Error(`${stage} failed`),
              { stage },
            );
          }
          return { id: evalCase.id };
        },
        appendSuccess: (evalCase, result) => {
          session.appendCase(
            createTraceEnvelope({
              runId,
              evalCaseId: evalCase.id,
              governance: GOVERNANCE,
              kind: 'retrieval',
              outcome: 'success',
              payload: result,
            }),
          );
        },
        appendError: (evalCase, failure) => {
          session.appendCase(
            createErrorTraceEnvelope({
              runId,
              evalCaseId: evalCase.id,
              governance: GOVERNANCE,
              kind: 'retrieval',
              payload: failure.payload ?? {},
              stage: failure.stage,
              error: failure.originalError,
            }),
          );
        },
      });

      assert.deepEqual(
        summary.results.map((result) => result.id),
        ['case-before', 'case-after'],
      );
      assert.deepEqual(summary.harnessErrors, [
        { evalCaseId: 'case-error', stage },
      ]);
      session.complete(retrievalMetrics(2, 1));
      const envelopes = readTraceEnvelopes(
        evalArtifactPath(traceRelativePath(runId, 'retrieval'), root),
      );
      assert.deepEqual(
        envelopes.map((envelope) => envelope.outcome),
        ['success', 'error', 'success'],
      );
    }
  },
);

await checkAsync('fatal stages abort instead of becoming case errors', async () => {
  for (const stage of EVAL_RUN_FATAL_STAGES) {
    await assert.rejects(
      () =>
        executeEvalRunStage(stage, async () => {
          throw new Error(`${stage} failed`);
        }),
      (error: unknown) => {
        assert.ok(error instanceof EvalRunExecutionError);
        assert.equal(error.stage, stage);
        return true;
      },
    );
  }
});

await checkAsync('artifact append failure aborts the batch', async () => {
  const evaluated: string[] = [];
  await assert.rejects(
    () =>
      executeEvalCases({
        cases: [{ id: 'case-1' }, { id: 'case-2' }],
        evaluate: async (evalCase) => {
          evaluated.push(evalCase.id);
          return evalCase.id;
        },
        appendSuccess: () => {
          throw new Error('disk full');
        },
        appendError: () => undefined,
      }),
    (error: unknown) => {
      assert.ok(error instanceof EvalRunExecutionError);
      assert.equal(error.stage, 'artifact_write');
      return true;
    },
  );
  assert.deepEqual(evaluated, ['case-1']);
});

check('an empty dataset completes without a fabricated trace file', () => {
  const root = evalRoot();
  const session = startEvalRun(definition([]), { evalRoot: root });
  session.complete(retrievalMetrics(0));

  assert.equal(readRun('run-1', root).status, 'completed');
  assert.equal(
    existsSync(
      evalArtifactPath(traceRelativePath('run-1', 'retrieval'), root),
    ),
    false,
  );
});

console.log(`\n通过 ${passed} 项`);
