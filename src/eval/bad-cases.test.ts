import assert from 'node:assert/strict';
import {
  assertCanonicalBadCase,
  canonicalBadCaseId,
  mergeCanonicalObservations,
  normalizeCanonicalBadCases,
  readBadCases,
  retrievalMiss,
  type BadCase,
  type BadCaseOrigin,
} from './bad-cases';

function origin(
  evalCaseId: string,
  source: BadCaseOrigin['source'] = 'retrieval_eval',
  observedRunIds: string[] = [],
): BadCaseOrigin {
  return {
    evalCaseId,
    source,
    firstSeenAt: '2026-07-09T00:00:00.000Z',
    lastSeenAt: '2026-07-09T00:00:00.000Z',
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
    origin: origin(params.evalCaseId, 'retrieval_eval', params.observedRunIds),
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
  assert.equal(miss.origin.evalCaseId, 'pod-volumes');
  assert.equal(miss.origin.source, 'retrieval_eval');
}

{
  assert.throws(
    () =>
      retrievalMiss({
        evalCaseId: '',
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
  const miss = retrievalMiss({
    evalCaseId: 'endpoints-subsets',
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
  assert.deepEqual(merged[0]!.origin.observedRunIds, ['run-a', 'run-b']);
  assert.equal(merged[0]!.origin.occurrenceCount, 2);
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
  assert.deepEqual(merged.origin.observedRunIds, ['run-a', 'run-b']);
}
