import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendTraceEnvelope,
  baselinePath,
  evalArtifactPath,
  runPath,
  writeJsonAtomic,
} from '../artifacts';
import {
  METRIC_DEFINITION_VERSION,
  metricDefinitionsForKind,
} from './definitions';
import type { JudgeCalibrationCase } from './judge-metrics';
import {
  decodeEvalRun,
  EVAL_SCHEMA_VERSION,
  metricObservation,
  ratioObservation,
  type EvalDatasetIdentity,
  type EvalKind,
  type EvalRun,
  type EvalScope,
  type MetricObservation,
  type TraceEnvelope,
} from '../protocol';
import { judgeDatasetIdentity } from '../runner-protocol';
import { promoteRun, readBaseline } from '../run-store';
import {
  createErrorTraceEnvelope,
  createTraceEnvelope,
} from '../run-session';

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
const HASH_C = 'c'.repeat(64);
const CREATED_AT = '2026-07-16T00:00:00.000Z';
const PROMOTED_AT = '2026-07-16T01:00:00.000Z';

function datasetIdentity(
  id: string,
  caseIds: readonly string[] = ['case-1'],
): EvalDatasetIdentity {
  return {
    id,
    hash: HASH_A,
    caseIds: [...caseIds],
    caseCount: caseIds.length,
  };
}

function requiredMetrics(
  kind: EvalKind,
  harnessErrorCount = 0,
): Record<string, MetricObservation> {
  return Object.fromEntries(
    metricDefinitionsForKind(kind)
      .filter((definition) => definition.stability === 'required')
      .map((definition) => {
        if (definition.key === `${kind}.harness_error_count`) {
          return [definition.key, metricObservation(harnessErrorCount)];
        }
        return [
          definition.key,
          definition.denominator === undefined
            ? metricObservation(0)
            : ratioObservation(1, 1),
        ];
      }),
  );
}

function configForKind(kind: EvalKind): EvalRun['config'] {
  const retrieval = {
    corpusContentHash: HASH_A,
    corpusManifestHash: HASH_B,
    indexHash: HASH_C,
    embeddingModel: 'embedding-model',
    rerankModel: 'rerank-model',
    queryExpansion: {
      enabled: false,
      registryHash: null,
      reviewedAliasCount: 0,
    },
    k: 3,
  };

  switch (kind) {
    case 'retrieval':
      return retrieval;
    case 'faith':
      return {
        ...retrieval,
        answerModel: 'answer-model',
        judgeModel: 'judge-model',
        answerPromptHash: HASH_A,
        judgePromptHash: HASH_B,
        judgeParserSchemaIdentity: 'judge-parser-v1',
        judgeAttemptLimit: 3,
      };
    case 'judge':
      return {
        judgeModel: 'judge-model',
        voteCount: 5,
        promptHash: HASH_A,
        parserSchemaIdentity: 'judge-parser-v1',
      };
    case 'generation':
    case 'fix':
      return {
        answerModel: 'answer-model',
        systemPromptHash: HASH_A,
        toolSchemaIdentity: 'submit-yaml-v1',
        validationSchemaIdentity: 'validation-v1',
      };
  }
}

function completedRun(params: {
  id: string;
  kind?: EvalKind;
  scope?: EvalScope;
  dataset?: EvalDatasetIdentity;
  metricDefinitionVersion?: string;
  metrics?: Record<string, MetricObservation>;
}): EvalRun {
  const kind = params.kind ?? 'retrieval';
  return decodeEvalRun({
    schemaVersion: EVAL_SCHEMA_VERSION,
    id: params.id,
    kind,
    status: 'completed',
    scope: params.scope ?? (kind === 'judge' ? 'calibration' : 'full'),
    createdAt: CREATED_AT,
    completedAt: CREATED_AT,
    dataset:
      params.dataset ??
      datasetIdentity(
        kind === 'judge' ? 'judge/calibration' : `${kind}/cases`,
      ),
    artifactPaths: { trace: `traces/${params.id}.${kind}.jsonl` },
    metricDefinitionVersion:
      params.metricDefinitionVersion ?? METRIC_DEFINITION_VERSION,
    config: configForKind(kind),
    metrics: params.metrics ?? requiredMetrics(kind),
  });
}

function writeRun(run: EvalRun, evalRoot: string): void {
  writeJsonAtomic(runPath(run.id, evalRoot), run);
}

function appendTrace(
  run: EvalRun,
  evalRoot: string,
  envelope: TraceEnvelope,
): void {
  appendTraceEnvelope(
    evalArtifactPath(run.artifactPaths.trace, evalRoot),
    envelope,
  );
}

function appendSuccessTraces(run: EvalRun, evalRoot: string): void {
  for (const evalCaseId of run.dataset.caseIds) {
    appendTrace(
      run,
      evalRoot,
      createTraceEnvelope({
        runId: run.id,
        evalCaseId,
        kind: run.kind,
        outcome: 'success',
        payload: { result: 'fixture' },
      }),
    );
  }
}

function calibrationCase(id: string): JudgeCalibrationCase {
  return {
    id,
    category: 'policy_conflict',
    sourceFaithRunId: 'faith-run',
    sourceFaithTraceId: `faith-trace-${id}`,
    question: `question ${id}`,
    context: `context ${id}`,
    sources: [
      {
        n: 1,
        id: `source-${id}`,
        title: `source ${id}`,
        sourceType: 'policy',
        provenance: { authority: 'organization', version: 'v1' },
        targets: [{ apiVersion: 'v1', kind: 'Pod', path: 'spec' }],
      },
    ],
    answer: `answer ${id}`,
    human: {
      faithful: true,
      policy: {
        distinguished: true,
        conflictExplained: true,
        misstatedAsOfficial: false,
      },
      note: `note ${id}`,
    },
  };
}

function writeCalibration(
  evalRoot: string,
  cases: readonly JudgeCalibrationCase[],
): void {
  writeFileSync(
    evalArtifactPath('judge-calibration.jsonl', evalRoot),
    `${cases.map((item) => JSON.stringify(item)).join('\n')}\n`,
  );
}

console.log('metric promotion:');

check('promotes a fully validated run to a portable baseline snapshot', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'eval-promotion-'));
  const run = completedRun({ id: 'portable-run' });
  writeRun(run, evalRoot);
  appendSuccessTraces(run, evalRoot);

  const baseline = promoteRun(run.id, { evalRoot, promotedAt: PROMOTED_AT });

  assert.deepEqual(baseline, {
    schemaVersion: EVAL_SCHEMA_VERSION,
    sourceRunId: run.id,
    promotedAt: PROMOTED_AT,
    kind: run.kind,
    scope: run.scope,
    dataset: run.dataset,
    metricDefinitionVersion: METRIC_DEFINITION_VERSION,
    config: run.config,
    metrics: run.metrics,
  });
  assert.deepEqual(readBaseline('retrieval', { evalRoot }), baseline);

  const serialized = readFileSync(
    baselinePath('retrieval', evalRoot),
    'utf8',
  );
  assert.doesNotMatch(serialized, /artifactPaths|traces\//);
  assert.equal(serialized.includes(evalRoot), false);

  writeJsonAtomic(baselinePath('retrieval', evalRoot), {
    ...baseline,
    artifactPaths: { trace: join(evalRoot, 'traces', 'portable.jsonl') },
  });
  assert.throws(
    () => readBaseline('retrieval', { evalRoot }),
    /invalid eval baseline/i,
  );
});

check('rejects running and failed runs', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'eval-promotion-'));
  const completed = completedRun({ id: 'running-run' });
  const { completedAt: _completedAt, ...runningDefinition } = completed;
  writeJsonAtomic(runPath(completed.id, evalRoot), {
    ...runningDefinition,
    status: 'running',
    metrics: {},
  });
  assert.throws(
    () => promoteRun(completed.id, { evalRoot }),
    /completed.*status running|status running.*completed/i,
  );

  const failed = completedRun({ id: 'failed-run' });
  writeJsonAtomic(runPath(failed.id, evalRoot), {
    ...failed,
    status: 'failed',
    failure: { stage: 'index', message: 'index unavailable' },
  });
  assert.throws(
    () => promoteRun(failed.id, { evalRoot }),
    /completed.*status failed|status failed.*completed/i,
  );
});

check('rejects every non-full scope for non-judge baselines', () => {
  for (const kind of [
    'retrieval',
    'faith',
    'generation',
    'fix',
  ] as const) {
    for (const scope of ['smoke', 'policy', 'targeted'] as const) {
      const evalRoot = mkdtempSync(join(tmpdir(), 'eval-promotion-'));
      const run = completedRun({ id: `${kind}-${scope}`, kind, scope });
      writeRun(run, evalRoot);
      appendSuccessTraces(run, evalRoot);
      assert.throws(
        () => promoteRun(run.id, { evalRoot }),
        new RegExp(`scope ${scope}.*requires full`, 'i'),
      );
    }
  }
});

check('rejects a judge subset and accepts the complete calibration identity', () => {
  const cases = [calibrationCase('judge-1'), calibrationCase('judge-2')];

  const subsetRoot = mkdtempSync(join(tmpdir(), 'eval-promotion-'));
  writeCalibration(subsetRoot, cases);
  const subsetRun = completedRun({
    id: 'judge-subset',
    kind: 'judge',
    dataset: judgeDatasetIdentity(cases.slice(0, 1)),
  });
  writeRun(subsetRun, subsetRoot);
  appendSuccessTraces(subsetRun, subsetRoot);
  assert.throws(
    () => promoteRun(subsetRun.id, { evalRoot: subsetRoot }),
    /complete calibration|calibration.*identity/i,
  );

  const fullRoot = mkdtempSync(join(tmpdir(), 'eval-promotion-'));
  writeCalibration(fullRoot, cases);
  const fullRun = completedRun({
    id: 'judge-full',
    kind: 'judge',
    dataset: judgeDatasetIdentity(cases),
  });
  writeRun(fullRun, fullRoot);
  appendSuccessTraces(fullRun, fullRoot);
  assert.equal(
    promoteRun(fullRun.id, { evalRoot: fullRoot }).sourceRunId,
    fullRun.id,
  );
});

check('rejects judge promotion when the complete calibration cannot be verified', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'eval-promotion-'));
  const run = completedRun({ id: 'judge-unverifiable', kind: 'judge' });
  writeRun(run, evalRoot);
  appendSuccessTraces(run, evalRoot);

  assert.throws(
    () => promoteRun(run.id, { evalRoot }),
    /calibration.*not found|cannot verify.*calibration/i,
  );
});

check('rejects missing or empty dataset identity fields', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'eval-promotion-'));
  const withoutDataset = completedRun({ id: 'missing-dataset' });
  const { dataset: _dataset, ...missingDatasetArtifact } = withoutDataset;
  writeJsonAtomic(runPath(withoutDataset.id, evalRoot), missingDatasetArtifact);
  assert.throws(
    () => promoteRun(withoutDataset.id, { evalRoot }),
    /invalid eval run/i,
  );

  const withoutCaseCount = completedRun({ id: 'missing-case-count' });
  const { caseCount: _caseCount, ...incompleteDataset } =
    withoutCaseCount.dataset;
  writeJsonAtomic(runPath(withoutCaseCount.id, evalRoot), {
    ...withoutCaseCount,
    dataset: incompleteDataset,
  });
  assert.throws(
    () => promoteRun(withoutCaseCount.id, { evalRoot }),
    /invalid eval run/i,
  );

  const empty = completedRun({
    id: 'empty-dataset',
    dataset: datasetIdentity('retrieval/cases', []),
  });
  writeRun(empty, evalRoot);
  assert.throws(
    () => promoteRun(empty.id, { evalRoot }),
    /empty dataset|case count.*positive/i,
  );
});

check('rejects metric version mismatch and missing or null required metrics', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'eval-promotion-'));

  const wrongVersion = completedRun({
    id: 'wrong-version',
    metricDefinitionVersion: 'not-current',
  });
  writeRun(wrongVersion, evalRoot);
  appendSuccessTraces(wrongVersion, evalRoot);
  assert.throws(
    () => promoteRun(wrongVersion.id, { evalRoot }),
    /metric definition version.*not current/i,
  );

  const missingMetrics = requiredMetrics('retrieval');
  delete missingMetrics['retrieval.semantic.recall'];
  const missingRequired = completedRun({
    id: 'missing-required',
    metrics: missingMetrics,
  });
  writeRun(missingRequired, evalRoot);
  appendSuccessTraces(missingRequired, evalRoot);
  assert.throws(
    () => promoteRun(missingRequired.id, { evalRoot }),
    /missing required metric.*retrieval\.semantic\.recall/i,
  );

  const nullMetrics = requiredMetrics('retrieval');
  nullMetrics['retrieval.semantic.recall'] = ratioObservation(0, 0);
  const nullRequired = completedRun({
    id: 'null-required',
    metrics: nullMetrics,
  });
  writeRun(nullRequired, evalRoot);
  appendSuccessTraces(nullRequired, evalRoot);
  assert.throws(
    () => promoteRun(nullRequired.id, { evalRoot }),
    /required metrics cannot be null.*retrieval\.semantic\.recall/i,
  );
});

check('rejects missing traces and trace coverage outside the dataset selection', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'eval-promotion-'));
  const missingTrace = completedRun({ id: 'missing-trace' });
  writeRun(missingTrace, evalRoot);
  assert.throws(
    () => promoteRun(missingTrace.id, { evalRoot }),
    /trace artifact not found/i,
  );

  const incomplete = completedRun({
    id: 'incomplete-trace',
    dataset: datasetIdentity('retrieval/cases', ['case-1', 'case-2']),
  });
  writeRun(incomplete, evalRoot);
  appendTrace(
    incomplete,
    evalRoot,
    createTraceEnvelope({
      runId: incomplete.id,
      evalCaseId: 'case-1',
      kind: incomplete.kind,
      outcome: 'success',
      payload: { result: 'fixture' },
    }),
  );
  assert.throws(
    () => promoteRun(incomplete.id, { evalRoot }),
    /trace coverage.*case-2|trace count.*dataset/i,
  );

  const wrongSelection = completedRun({ id: 'wrong-trace-selection' });
  writeRun(wrongSelection, evalRoot);
  appendTrace(
    wrongSelection,
    evalRoot,
    createTraceEnvelope({
      runId: wrongSelection.id,
      evalCaseId: 'other-case',
      kind: wrongSelection.kind,
      outcome: 'success',
      payload: { result: 'fixture' },
    }),
  );
  assert.throws(
    () => promoteRun(wrongSelection.id, { evalRoot }),
    /unexpected case other-case/i,
  );
});

check('rejects unexplained case errors and provides no harness-error override', () => {
  const malformedRoot = mkdtempSync(join(tmpdir(), 'eval-promotion-'));
  const malformed = completedRun({ id: 'unexplained-error' });
  writeRun(malformed, malformedRoot);
  const successEnvelope = createTraceEnvelope({
    runId: malformed.id,
    evalCaseId: 'case-1',
    kind: malformed.kind,
    outcome: 'success',
    payload: { result: 'fixture' },
  });
  appendTrace(malformed, malformedRoot, successEnvelope);
  writeFileSync(
    evalArtifactPath(malformed.artifactPaths.trace, malformedRoot),
    `${JSON.stringify({ ...successEnvelope, outcome: 'error' })}\n`,
  );
  assert.throws(
    () => promoteRun(malformed.id, { evalRoot: malformedRoot }),
    /error outcome requires error details/i,
  );

  const errorRoot = mkdtempSync(join(tmpdir(), 'eval-promotion-'));
  const errorRun = completedRun({
    id: 'harness-error',
    metrics: requiredMetrics('retrieval', 1),
  });
  writeRun(errorRun, errorRoot);
  appendTrace(
    errorRun,
    errorRoot,
    createErrorTraceEnvelope({
      runId: errorRun.id,
      evalCaseId: 'case-1',
      kind: errorRun.kind,
      stage: 'retrieval',
      error: new Error('retrieval unavailable'),
      payload: { input: 'fixture' },
    }),
  );
  assert.throws(
    () => promoteRun(errorRun.id, { evalRoot: errorRoot }),
    /harness error.*must be 0|cannot promote.*harness error/i,
  );

  const mismatchRoot = mkdtempSync(join(tmpdir(), 'eval-promotion-'));
  const mismatch = completedRun({
    id: 'untraced-harness-error',
    metrics: requiredMetrics('retrieval', 1),
  });
  writeRun(mismatch, mismatchRoot);
  appendSuccessTraces(mismatch, mismatchRoot);
  assert.throws(
    () => promoteRun(mismatch.id, { evalRoot: mismatchRoot }),
    /harness error.*trace|trace.*harness error/i,
  );
});

check('does not overwrite an existing baseline when validation fails', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'eval-promotion-'));
  const accepted = completedRun({ id: 'accepted-run' });
  writeRun(accepted, evalRoot);
  appendSuccessTraces(accepted, evalRoot);
  promoteRun(accepted.id, { evalRoot, promotedAt: PROMOTED_AT });
  const path = baselinePath('retrieval', evalRoot);
  const before = readFileSync(path, 'utf8');

  const metrics = requiredMetrics('retrieval');
  delete metrics['retrieval.semantic.mrr'];
  const rejected = completedRun({ id: 'rejected-run', metrics });
  writeRun(rejected, evalRoot);
  appendSuccessTraces(rejected, evalRoot);

  assert.throws(
    () => promoteRun(rejected.id, { evalRoot }),
    /missing required metric.*retrieval\.semantic\.mrr/i,
  );
  assert.equal(readFileSync(path, 'utf8'), before);
});

console.log(`\n通过 ${passed} 项`);
