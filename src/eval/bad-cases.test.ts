import assert from 'node:assert/strict';
import {
  assertCanonicalBadCase,
  canonicalBadCaseId,
  mergeCanonicalObservations,
  normalizeCanonicalBadCases,
  readBadCases,
  retrievalMiss,
  type BadCase,
  type BadCaseTracking,
} from './bad-cases';

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
  };
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
  assert.equal(miss.actual.traceId, 'run-a:pod-volumes');
}

{
  assert.throws(
    () =>
      retrievalMiss({
        evalCaseId: '',
        runId: 'run-a',
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
