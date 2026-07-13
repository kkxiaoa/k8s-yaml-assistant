import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendTraceEnvelope,
  evalArtifactPath,
  runPath,
  traceRelativePath,
  writeJsonAtomic,
} from './artifacts';
import {
  assertCanonicalBadCase,
  canonicalBadCaseId,
  decodeBadCase,
  mergeCanonicalObservations,
  normalizeCanonicalBadCases,
  readBadCases,
  retrievalMiss,
  upsertBadCases,
  verifyBadCaseLatestEvidence,
  writeBadCases,
  type BadCase,
  type BadCaseTracking,
} from './bad-cases';
import {
  EVAL_SCHEMA_VERSION,
  metricObservation,
  type EvalRun,
} from './protocol';
import { createTraceEnvelope } from './run-session';

function tracking(
  evalCaseId: string,
  source: BadCaseTracking['source'] = 'retrieval_eval',
  observedRunIds: string[] = [],
): BadCaseTracking {
  const firstRunId = observedRunIds[0];
  const lastRunId = observedRunIds[observedRunIds.length - 1];
  return {
    evalCaseId,
    source,
    firstSeenAt: '2026-07-09T00:00:00.000Z',
    lastSeenAt: '2026-07-09T00:00:00.000Z',
    firstSeenRunId: firstRunId,
    lastSeenRunId: lastRunId,
    observedRunIds,
    occurrenceCount: Math.max(1, observedRunIds.length),
  };
}

function badCase(params: {
  evalCaseId: string;
  layer: BadCase['failure']['layer'];
  type: BadCase['failure']['type'];
  status?: BadCase['status'];
  observedRunIds?: string[];
  latestEvidence?: BadCase['latestEvidence'];
}): BadCase {
  return {
    id: canonicalBadCaseId({
      evalCaseId: params.evalCaseId,
      layer: params.layer,
      type: params.type,
    }),
    createdAt: '2026-07-09T00:00:00.000Z',
    taskType: 'ask_free',
    input: { question: 'existing question' },
    expected: { sourceIds: ['expected'] },
    actual: { sourceIds: ['actual'] },
    failure: {
      layer: params.layer,
      type: params.type,
      note: 'existing note',
    },
    severity: 'medium',
    status: params.status ?? 'new',
    tracking: tracking(
      params.evalCaseId,
      'retrieval_eval',
      params.observedRunIds,
    ),
    ...(params.latestEvidence
      ? { latestEvidence: params.latestEvidence }
      : {}),
  };
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function retrievalRun(id: string, evalCaseId: string): EvalRun {
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    id,
    kind: 'retrieval',
    status: 'completed',
    scope: 'full',
    createdAt: '2026-07-12T00:00:00.000Z',
    completedAt: '2026-07-12T00:01:00.000Z',
    dataset: {
      id: 'retrieval/answerable',
      hash: HASH_A,
      caseIds: [evalCaseId],
      caseCount: 1,
    },
    artifactPaths: { trace: traceRelativePath(id, 'retrieval') },
    metricDefinitionVersion: 'legacy-v1',
    config: {
      corpusHash: HASH_A,
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
    metrics: { 'serving.recall@3': metricObservation(0, 0, 1) },
  };
}

function withTempDir(fn: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'bad-cases-'));
  try {
    fn(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

{
  const first = canonicalBadCaseId({
    evalCaseId: 'pod-volumes',
    layer: 'retrieval',
    type: 'retrieval_miss',
  });
  const same = canonicalBadCaseId({
    evalCaseId: 'pod-volumes',
    layer: 'retrieval',
    type: 'retrieval_miss',
  });
  const generation = canonicalBadCaseId({
    evalCaseId: 'pod-volumes',
    layer: 'generation',
    type: 'hallucination',
  });

  assert.match(first, /^[a-f0-9]{12}$/);
  assert.equal(first, same);
  assert.notEqual(first, generation);
}

{
  const miss = retrievalMiss({
    evalCaseId: 'pod-volumes',
    runId: 'run-a',
    traceId: 'trace-a',
    question: 'Pod 用哪个字段挂载卷来源?',
    resource: 'Pod',
    expectedChunkIds: ['Pod::spec.volumes'],
    actualTopIds: ['Pod::spec.volumes.projected.sources'],
    rankedIds: ['Pod::spec.volumes.projected.sources'],
    k: 3,
  });

  assert.equal(
    miss.id,
    canonicalBadCaseId({
      evalCaseId: 'pod-volumes',
      layer: 'retrieval',
      type: 'retrieval_miss',
    }),
  );
  assert.equal(miss.tracking.evalCaseId, 'pod-volumes');
  assert.equal(miss.tracking.source, 'retrieval_eval');
  assert.equal(miss.tracking.firstSeenRunId, 'run-a');
  assert.equal(miss.tracking.lastSeenRunId, 'run-a');
  assert.deepEqual(miss.tracking.observedRunIds, ['run-a']);
  assert.equal(miss.tracking.occurrenceCount, 1);
  assert.deepEqual(miss.latestEvidence, {
    runId: 'run-a',
    traceId: 'trace-a',
  });
  assert.equal('traceId' in miss.actual, false);
}

{
  assert.throws(
    () =>
      retrievalMiss({
        evalCaseId: '',
        runId: 'run-a',
        traceId: 'trace-a',
        question: 'Pod 用哪个字段挂载卷来源?',
        resource: 'Pod',
        expectedChunkIds: ['Pod::spec.volumes'],
        actualTopIds: [],
        rankedIds: [],
        k: 3,
      }),
    /evalCaseId/,
  );
}

{
  assert.throws(
    () =>
      retrievalMiss({
        evalCaseId: 'pod-volumes',
        runId: '',
        traceId: 'trace-a',
        question: 'Pod 用哪个字段挂载卷来源?',
        resource: 'Pod',
        expectedChunkIds: ['Pod::spec.volumes'],
        actualTopIds: [],
        rankedIds: [],
        k: 3,
      }),
    /runId/,
  );
}

{
  const miss = retrievalMiss({
    evalCaseId: 'endpoints-subsets',
    runId: 'run-a',
    traceId: 'trace-a',
    question: 'Endpoints 用哪个字段声明后端地址和端口?',
    resource: 'Endpoints',
    expectedChunkIds: [
      'Endpoints::subsets.addresses',
      'Endpoints::subsets.ports',
    ],
    actualTopIds: ['Endpoints::subsets.ports', 'Endpoints::subsets.ports.port'],
    rankedIds: ['Endpoints::subsets.ports', 'Endpoints::subsets.ports.port'],
    k: 3,
  });

  assert.equal(miss.failure.layer, 'retrieval');
  assert.match(
    miss.failure.note ?? '',
    /未进候选: Endpoints::subsets.addresses/,
  );
  assert.match(miss.failure.note ?? '', /top-3 命中 1\/2/);
}

{
  const miss = retrievalMiss({
    evalCaseId: 'pvc-resources',
    runId: 'run-a',
    traceId: 'trace-a',
    question: 'PVC 怎么申请存储大小?',
    resource: 'PersistentVolumeClaim',
    expectedChunkIds: ['PersistentVolumeClaim::spec.resources.requests'],
    actualTopIds: ['PersistentVolumeClaim::status.allocatedResources'],
    rankedIds: [
      'PersistentVolumeClaim::status.allocatedResources',
      'PersistentVolumeClaim::status.allocatedResourceStatuses',
      'PersistentVolume::spec.capacity',
      'PersistentVolumeClaim::spec.resources.requests',
    ],
    k: 3,
  });

  assert.equal(miss.failure.layer, 'rerank');
  assert.equal(miss.failure.type, 'rerank_miss');
  assert.match(
    miss.failure.note ?? '',
    /候选中但排在 top-3 外: PersistentVolumeClaim::spec.resources.requests\(rank=4\)/,
  );
}

{
  const canonical = readBadCases();
  assert.equal(canonical.length > 0, true);
  for (const badCase of canonical) {
    assert.doesNotThrow(() => assertCanonicalBadCase(badCase));
  }
}

{
  const first = badCase({
    evalCaseId: 'case-a',
    layer: 'generation',
    type: 'hallucination',
    status: 'triaged',
    observedRunIds: ['run-a'],
  });
  const second = {
    ...badCase({
      evalCaseId: 'case-a',
      layer: 'generation',
      type: 'hallucination',
      status: 'new',
      observedRunIds: ['run-b'],
    }),
    actual: { answer: 'latest answer' },
  };
  const merged = normalizeCanonicalBadCases([first, second]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.status, 'triaged');
  assert.deepEqual(merged[0]!.actual, { answer: 'latest answer' });
  assert.deepEqual(merged[0]!.tracking.observedRunIds, ['run-a', 'run-b']);
  assert.equal(merged[0]!.tracking.occurrenceCount, 2);
  assert.equal(merged[0]!.tracking.firstSeenRunId, 'run-a');
  assert.equal(merged[0]!.tracking.lastSeenRunId, 'run-b');
}

{
  const first = badCase({
    evalCaseId: 'case-b',
    layer: 'retrieval',
    type: 'retrieval_miss',
    status: 'triaged',
    observedRunIds: ['run-a'],
  });
  const second = {
    ...badCase({
      evalCaseId: 'case-b',
      layer: 'retrieval',
      type: 'retrieval_miss',
      status: 'new',
      observedRunIds: ['run-b'],
    }),
    actual: { sourceIds: ['latest'] },
  };
  const merged = mergeCanonicalObservations(first, second);

  assert.equal(merged.status, 'triaged');
  assert.deepEqual(merged.actual, { sourceIds: ['latest'] });
  assert.deepEqual(merged.tracking.observedRunIds, ['run-a', 'run-b']);
  assert.equal(merged.tracking.occurrenceCount, 2);
  assert.equal(merged.tracking.lastSeenRunId, 'run-b');
}

{
  const first = badCase({
    evalCaseId: 'case-c',
    layer: 'rerank',
    type: 'rerank_miss',
    observedRunIds: ['run-a'],
  });
  const duplicateSameRun = {
    ...badCase({
      evalCaseId: 'case-c',
      layer: 'rerank',
      type: 'rerank_miss',
      observedRunIds: ['run-a'],
    }),
    actual: { sourceIds: ['same-run-latest'] },
  };
  const merged = mergeCanonicalObservations(first, duplicateSameRun);

  assert.deepEqual(merged.tracking.observedRunIds, ['run-a']);
  assert.equal(merged.tracking.occurrenceCount, 1);
  assert.equal(merged.tracking.firstSeenRunId, 'run-a');
  assert.equal(merged.tracking.lastSeenRunId, 'run-a');
  assert.deepEqual(merged.actual, { sourceIds: ['same-run-latest'] });
}

{
  const legacy = badCase({
    evalCaseId: 'case-d',
    layer: 'retrieval',
    type: 'retrieval_miss',
    observedRunIds: [],
  });
  const recurrence = badCase({
    evalCaseId: 'case-d',
    layer: 'retrieval',
    type: 'retrieval_miss',
    observedRunIds: ['run-b'],
  });
  recurrence.tracking.firstSeenAt = '2026-07-10T00:00:00.000Z';
  recurrence.tracking.lastSeenAt = '2026-07-10T00:00:00.000Z';

  const merged = mergeCanonicalObservations(legacy, recurrence);

  assert.equal(merged.tracking.firstSeenRunId, undefined);
  assert.equal(merged.tracking.lastSeenRunId, 'run-b');
  assert.deepEqual(merged.tracking.observedRunIds, ['run-b']);
  assert.equal(merged.tracking.occurrenceCount, 2);
}

{
  const valid = badCase({
    evalCaseId: 'case-e',
    layer: 'retrieval',
    type: 'retrieval_miss',
    observedRunIds: ['run-a'],
    latestEvidence: { runId: 'run-a', traceId: 'trace-a' },
  });

  assert.deepEqual(decodeBadCase(valid), valid);
  assert.throws(
    () =>
      decodeBadCase({
        ...valid,
        actual: { ...valid.actual, traceId: 'run-a:case-e' },
      }),
    /traceId|unrecognized/i,
  );
  assert.throws(
    () =>
      decodeBadCase({
        ...valid,
        failure: { layer: 'rerank', type: 'retrieval_miss' },
      }),
    /failure.*combination|retrieval_miss/i,
  );
  assert.throws(
    () =>
      decodeBadCase({
        ...valid,
        latestEvidence: { runId: 'run-a' },
      }),
    /traceId/i,
  );
}

{
  withTempDir((directory) => {
    const path = join(directory, 'bad-cases.jsonl');
    const valid = badCase({
      evalCaseId: 'case-f',
      layer: 'retrieval',
      type: 'retrieval_miss',
      observedRunIds: ['missing-local-run'],
      latestEvidence: {
        runId: 'missing-local-run',
        traceId: 'missing-local-trace',
      },
    });
    writeFileSync(path, `${JSON.stringify(valid)}\n`);

    assert.deepEqual(readBadCases({ path }), [valid]);
    assert.equal(existsSync(join(directory, 'runs')), false);
  });
}

{
  withTempDir((directory) => {
    const path = join(directory, 'bad-cases.jsonl');
    const valid = badCase({
      evalCaseId: 'case-g',
      layer: 'retrieval',
      type: 'retrieval_miss',
    });
    writeBadCases([valid], { path });
    const before = readFileSync(path, 'utf8');

    assert.throws(
      () =>
        writeBadCases(
          [
            valid,
            {
              ...valid,
              id: 'not-canonical',
              tracking: { ...valid.tracking, evalCaseId: 'case-h' },
            },
          ],
          { path },
        ),
      /canonical|id mismatch/i,
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  });
}

{
  withTempDir((evalRoot) => {
    const run = retrievalRun('run-evidence', 'case-i');
    writeJsonAtomic(runPath(run.id, evalRoot), run);
    const envelope = createTraceEnvelope({
      runId: run.id,
      evalCaseId: 'case-i',
      kind: 'retrieval',
      outcome: 'failed',
      payload: { ranking: { recall: 0 } },
    });
    appendTraceEnvelope(
      evalArtifactPath(run.artifactPaths.trace, evalRoot),
      envelope,
    );
    const issue = badCase({
      evalCaseId: 'case-i',
      layer: 'retrieval',
      type: 'retrieval_miss',
      observedRunIds: [run.id],
      latestEvidence: { runId: run.id, traceId: envelope.traceId },
    });

    assert.doesNotThrow(() =>
      verifyBadCaseLatestEvidence(issue, { evalRoot }),
    );
    assert.throws(
      () =>
        verifyBadCaseLatestEvidence(
          {
            ...issue,
            latestEvidence: {
              runId: run.id,
              traceId: 'missing-trace-id',
            },
          },
          { evalRoot },
        ),
      /missing-trace-id.*not found|trace.*missing-trace-id/i,
    );

    const wrongCaseEnvelope = createTraceEnvelope({
      runId: run.id,
      evalCaseId: 'other-case',
      kind: 'retrieval',
      outcome: 'failed',
      payload: { ranking: { recall: 0 } },
    });
    appendTraceEnvelope(
      evalArtifactPath(run.artifactPaths.trace, evalRoot),
      wrongCaseEnvelope,
    );
    assert.throws(
      () =>
        verifyBadCaseLatestEvidence(
          {
            ...issue,
            latestEvidence: {
              runId: run.id,
              traceId: wrongCaseEnvelope.traceId,
            },
          },
          { evalRoot },
        ),
      /other-case.*case-i|evalCaseId.*other-case/i,
    );
  });
}

{
  withTempDir((directory) => {
    const evalRoot = join(directory, 'eval');
    const path = join(directory, 'bad-cases.jsonl');
    const run = retrievalRun('run-upsert', 'case-j');
    writeJsonAtomic(runPath(run.id, evalRoot), run);
    const envelope = createTraceEnvelope({
      runId: run.id,
      evalCaseId: 'case-j',
      kind: 'retrieval',
      outcome: 'failed',
      payload: { ranking: { recall: 0 } },
    });
    appendTraceEnvelope(
      evalArtifactPath(run.artifactPaths.trace, evalRoot),
      envelope,
    );
    const issue = retrievalMiss({
      evalCaseId: 'case-j',
      runId: run.id,
      traceId: envelope.traceId,
      question: 'question',
      resource: 'Pod',
      expectedChunkIds: ['Chunk::expected'],
      actualTopIds: ['Chunk::actual'],
      rankedIds: ['Chunk::actual'],
      k: 1,
    });

    assert.equal(upsertBadCases([issue], { path, evalRoot }), 1);
    assert.deepEqual(readBadCases({ path }), [issue]);
  });
}
