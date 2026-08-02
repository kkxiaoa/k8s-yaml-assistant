import assert from 'node:assert/strict';
import test from 'node:test';
import { CORPUS } from '../knowledge/corpus';
import type { RetrievalTrace } from '../retrieval/trace';
import {
  ServingHitReferenceSchema,
  decodeServingRetrievalObservation,
  projectServingRetrievalObservation,
} from './serving-observation';
import type { RedactedServingQuestion } from './redaction';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const OBSERVATION_ID = '22222222-2222-4222-8222-222222222222';
const RAW_SENSITIVE_VALUE = 'TestRawTraceValue123';

const redactedQuestion: RedactedServingQuestion = {
  disposition: 'redacted',
  text: '解释 Deployment replicas 字段',
  redactionVersion: 'serving-redaction/v1',
  redactionLabels: ['credential_assignment'],
};

function trace(overrides: Partial<RetrievalTrace> = {}): RetrievalTrace {
  return {
    question: RAW_SENSITIVE_VALUE,
    mode: 'explain_field',
    resourceHint: 'Deployment',
    apiVersionHint: 'apps/v1',
    fieldPathHint: 'spec.replicas',
    queryText: RAW_SENSITIVE_VALUE,
    queryExpansion: {
      enabled: true,
      status: 'applied',
      originalQueryText: RAW_SENSITIVE_VALUE,
      expandedQueryText: RAW_SENSITIVE_VALUE,
      matchedAliases: [
        {
          chunkId: 'schema::apps/v1::Deployment::spec.replicas',
          resource: 'Deployment',
          path: 'spec.replicas',
          zhAlias: RAW_SENSITIVE_VALUE,
          strength: 'strong',
        },
      ],
      expansionTerms: [RAW_SENSITIVE_VALUE],
      routedResource: 'Deployment',
      selectedResource: 'Deployment',
      resourceSelectionReason: 'same_resource',
      registryHash: 'a'.repeat(64),
      reviewedAliasCount: 11,
    },
    path: 'search',
    coarseHits: [
      {
        id: 'schema::apps/v1::Deployment::spec.replicas',
        title: RAW_SENSITIVE_VALUE,
        sourceType: 'schema',
        provenance: {
          authority: 'cluster_api',
          sourceUri: `https://example.test/${RAW_SENSITIVE_VALUE}`,
          version: 'v1.36.0',
        },
        targets: [
          {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            path: 'spec.replicas',
          },
        ],
        score: 0.8,
      },
    ],
    rerankHits: [],
    finalHits: [],
    latencyMs: {
      embed: 1,
      dense: 2,
      sparse: 3,
      rerank: 4,
      llm: 5,
      total: 6,
    },
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      estimatedCostUsd: 0.01,
    },
    cache: {
      embeddingHit: true,
      index: { status: 'hit' },
    },
    createdAt: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

function project(overrides: Partial<RetrievalTrace> = {}) {
  return projectServingRetrievalObservation({
    requestId: REQUEST_ID,
    observationId: OBSERVATION_ID,
    trace: trace(overrides),
    redactedQuestion,
  });
}

test('projects only the persisted allowlist and decodes it again', () => {
  const observation = project();

  assert.equal(observation.schemaVersion, 'serving-observation/v2');
  assert.equal(observation.kind, 'retrieval');
  assert.deepEqual(observation.query, redactedQuestion);
  assert.deepEqual(observation.ranking.coarse[0], {
    id: 'schema::apps/v1::Deployment::spec.replicas',
    sourceType: 'schema',
    authority: 'cluster_api',
    version: 'v1.36.0',
    targets: [
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        path: 'spec.replicas',
      },
    ],
    score: 0.8,
  });
  assert.deepEqual(observation.latencyMs, {
    embed: 1,
    dense: 2,
    rerank: 4,
    total: 6,
  });
  assert.deepEqual(observation.queryExpansion?.matches, [
    {
      chunkId: 'schema::apps/v1::Deployment::spec.replicas',
      resource: 'Deployment',
      path: 'spec.replicas',
      strength: 'strong',
    },
  ]);

  const serialized = JSON.stringify(observation);
  assert.equal(serialized.includes(RAW_SENSITIVE_VALUE), false);
  for (const forbiddenField of [
    'queryText',
    'originalQueryText',
    'expandedQueryText',
    'expansionTerms',
    'zhAlias',
    'title',
    'sourceUri',
    'usage',
    'sparse',
    'llm',
  ]) {
    assert.equal(serialized.includes(`"${forbiddenField}"`), false);
  }
});

test('accepts identity metadata from every current corpus chunk', () => {
  let invalidCount = 0;
  for (const chunk of CORPUS) {
    const result = ServingHitReferenceSchema.safeParse({
      id: chunk.id,
      sourceType: chunk.sourceType,
      authority: chunk.provenance.authority,
      version: chunk.provenance.version,
      targets: chunk.targets,
    });
    if (!result.success) invalidCount++;
  }

  assert.ok(CORPUS.length > 0);
  assert.equal(invalidCount, 0);
});

test('strict decoder rejects raw, unknown, and future fields at every level', () => {
  const valid = project();
  const cases: unknown[] = [
    { ...valid, schemaVersion: 'serving-observation/v1' },
    { ...valid, queryText: RAW_SENSITIVE_VALUE },
    { ...valid, selectedText: RAW_SENSITIVE_VALUE },
    { ...valid, errors: [RAW_SENSITIVE_VALUE] },
    { ...valid, yaml: RAW_SENSITIVE_VALUE },
    { ...valid, answer: RAW_SENSITIVE_VALUE },
    { ...valid, chunkText: RAW_SENSITIVE_VALUE },
    {
      ...valid,
      route: { ...valid.route, selectedText: RAW_SENSITIVE_VALUE },
    },
    {
      ...valid,
      ranking: {
        ...valid.ranking,
        coarse: [
          { ...valid.ranking.coarse[0], title: RAW_SENSITIVE_VALUE },
        ],
      },
    },
    {
      ...valid,
      ranking: {
        ...valid.ranking,
        coarse: [
          {
            ...valid.ranking.coarse[0],
            sourceUri: RAW_SENSITIVE_VALUE,
          },
        ],
      },
    },
    {
      ...valid,
      route: {
        ...valid.route,
        resourceHint: 'AKIAIOSFODNN7EXAMPLE',
      },
    },
    {
      ...valid,
      ranking: {
        ...valid.ranking,
        coarse: [
          {
            ...valid.ranking.coarse[0],
            id: 'AKIAIOSFODNN7EXAMPLE',
          },
        ],
      },
    },
  ];

  for (const value of cases) {
    assert.throws(() => decodeServingRetrievalObservation(value));
  }
});

test('strict decoder rejects invalid identity, time, numbers, and duplicate labels', () => {
  const valid = project();
  for (const value of [
    { ...valid, requestId: 'client-controlled-id' },
    { ...valid, observationId: 'not-a-uuid' },
    { ...valid, createdAt: '2026-07-20' },
    {
      ...valid,
      latencyMs: { ...valid.latencyMs, total: Number.NaN },
    },
    {
      ...valid,
      ranking: {
        ...valid.ranking,
        coarse: [
          { ...valid.ranking.coarse[0], score: Number.POSITIVE_INFINITY },
        ],
      },
    },
    {
      ...valid,
      query: {
        ...valid.query,
        redactionLabels: ['jwt', 'jwt'],
      },
    },
    {
      ...valid,
      query: {
        disposition: 'redacted',
        text: 'DEEPSEEK_API_KEY=TestDecoderBypassCredential123',
        redactionVersion: 'serving-redaction/v1',
        redactionLabels: [],
      },
    },
    {
      ...valid,
      query: {
        disposition: 'redacted',
        text: 'password=[REDACTED]TestResidualCredential123',
        redactionVersion: 'serving-redaction/v1',
        redactionLabels: ['credential_assignment'],
      },
    },
    {
      ...valid,
      query: {
        disposition: 'redacted',
        text: 'Authorization: [REDACTED] TestResidualAuthorization123',
        redactionVersion: 'serving-redaction/v1',
        redactionLabels: ['bearer_token'],
      },
    },
  ]) {
    assert.throws(() => decodeServingRetrievalObservation(value));
  }
});

test('query, expansion, and cache cross-field invariants are closed', () => {
  const valid = project();
  for (const value of [
    {
      ...valid,
      query: {
        disposition: 'dropped_sensitive',
        text: 'must not persist',
        redactionVersion: 'serving-redaction/v1',
        redactionLabels: ['k8s_secret'],
      },
    },
    {
      ...valid,
      query: {
        disposition: 'redacted',
        redactionVersion: 'serving-redaction/v1',
        redactionLabels: [],
      },
    },
    {
      ...valid,
      queryExpansion: {
        enabled: true,
        status: 'failed',
        matches: [],
      },
    },
    {
      ...valid,
      queryExpansion: {
        enabled: false,
        status: 'disabled',
        errorCode: 'aliases_invalid',
        matches: [],
      },
    },
    {
      ...valid,
      cache: {
        index: { status: 'hit', reason: 'missing_files' },
      },
    },
  ]) {
    assert.throws(() => decodeServingRetrievalObservation(value));
  }
});

test('projection omits invalid optional hints but rejects an invalid route mode', () => {
  const observation = project({
    resourceHint: 'AKIAIOSFODNN7EXAMPLE',
    apiVersionHint: 'DEEPSEEK_API_KEY=TestHintCredential123',
    fieldPathHint:
      ['ghp', 'TestFieldPathCredential123456789012345678901234567890'].join('_'),
  });
  assert.deepEqual(observation.route, {
    mode: 'explain_field',
    path: 'search',
  });

  assert.throws(() => project({ mode: 'future_mode' }));
});
