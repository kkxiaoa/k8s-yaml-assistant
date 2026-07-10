import assert from 'node:assert/strict';
import {
  badCaseId,
  canonicalBadCaseId,
  migrateBadCasesToCanonical,
  readBadCases,
  retrievalMiss,
  type BadCase,
} from './bad-cases';
import { EVAL_SET } from './eval-set';

function legacyRetrievalFixture(): BadCase[] {
  return readBadCases()
    .filter(
      (c) =>
        (c.failure.layer === 'retrieval' || c.failure.layer === 'rerank') &&
        (c.failure.type === 'retrieval_miss' ||
          c.failure.type === 'rerank_miss'),
    )
    .map((c) => {
      const sourceIds = c.expected?.sourceIds ?? [];
      const legacy: BadCase = {
        ...c,
        id: badCaseId(c.taskType, c.input.question ?? '', sourceIds),
        convertedEvalId: undefined,
        origin: undefined,
        relatedBadCaseIds: undefined,
      };
      return JSON.parse(JSON.stringify(legacy)) as BadCase;
    });
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
  assert.equal(miss.origin?.evalCaseId, 'pod-volumes');
  assert.equal(miss.origin?.source, 'retrieval_eval');
  assert.equal(miss.convertedEvalId, 'pod-volumes');
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
  const legacy = legacyRetrievalFixture();
  assert.equal(legacy.length, 10);

  const migrated = migrateBadCasesToCanonical({
    cases: legacy,
    evalSet: EVAL_SET,
    now: '2026-07-09T00:00:00.000Z',
  }).cases;

  const ids = new Set<string>();
  for (let i = 0; i < legacy.length; i++) {
    const before = legacy[i]!;
    const after = migrated[i]!;
    const evalCase = EVAL_SET.find((c) => c.question === before.input.question);

    assert.ok(evalCase);
    assert.equal(
      after.id,
      canonicalBadCaseId({
        evalCaseId: evalCase.id,
        layer: before.failure.layer,
        type: before.failure.type,
      }),
    );
    assert.equal(after.origin?.evalCaseId, evalCase.id);
    assert.equal(after.origin?.source, 'retrieval_eval');
    assert.equal(after.convertedEvalId, evalCase.id);
    assert.equal(after.createdAt, before.createdAt);
    assert.deepEqual(after.input, before.input);
    assert.deepEqual(after.expected, before.expected);
    assert.deepEqual(after.actual, before.actual);
    assert.equal(after.failure.note, before.failure.note);
    assert.equal(after.severity, before.severity);
    assert.equal(after.status, before.status);
    assert.equal(after.origin?.firstSeenAt, before.createdAt);
    assert.equal(after.origin?.lastSeenAt, before.createdAt);
    assert.deepEqual(after.origin?.observedRunIds, []);
    assert.equal(after.origin?.occurrenceCount, 1);

    assert.equal(ids.has(after.id), false);
    ids.add(after.id);
  }
}

{
  const legacy = legacyRetrievalFixture();
  const broken = [
    {
      ...legacy[0]!,
      id: 'legacy-broken',
      input: { ...legacy[0]!.input, question: '这个问题不存在于 eval set' },
    },
  ];

  assert.throws(
    () =>
      migrateBadCasesToCanonical({
        cases: broken,
        evalSet: EVAL_SET,
      }),
    /legacy-broken.*这个问题不存在于 eval set.*matches=0/s,
  );
}
