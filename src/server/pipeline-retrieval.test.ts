import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORPUS } from '../knowledge/corpus';
import {
  GROUNDED_ANSWER_CASES,
  resolveGroundedAnswerCase,
} from '../eval/cases/grounded-answer-cases';
import { textOfRequest } from '../eval/llm';
import type { ServingObservationConfig } from '../observability/config';
import {
  createLocalObservationSink,
  type LocalObservationSink,
} from '../observability/local-sink';
import {
  createServingObservationRecorder,
  type ServingObservationRecordResult,
} from '../observability/recorder';
import { ServingRedactionError } from '../observability/redaction';
import { decodeServingRetrievalObservation } from '../observability/serving-observation';
import { toTraceHit, type RetrievalTrace } from '../retrieval/trace';
import {
  ANSWER_MODEL,
  ASK_MAX_TOKENS,
  ASK_SYSTEM,
  prepareAsk,
  retrieveContext,
  type RetrieveContextOptions,
} from './pipeline';

let passed = 0;
async function check(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(
      `  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exitCode = 1;
  }
}

function chunk(id: string) {
  const found = CORPUS.find((c) => c.id === id);
  assert.ok(found, `missing test chunk: ${id}`);
  return found;
}

const SERVING_RAW_SECRET = 'PipelineServingSecretFixture987';
const SERVING_REQUEST_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
] as const;
const SERVING_OBSERVATION_IDS = [
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
] as const;
const SERVING_NOW = new Date('2026-07-21T12:34:56.000Z');

const LOCAL_SERVING_CONFIG: Extract<
  ServingObservationConfig,
  { mode: 'local' }
> = {
  mode: 'local',
  sampleRate: 1,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 256 * 1024,
  retentionDays: 7,
  maxInputBytes: 4096,
  maxTextBytes: 2048,
};

function requiredLocalSink(
  result: ReturnType<typeof createLocalObservationSink>,
): LocalObservationSink {
  if (!result.ok) assert.fail(result.error.code);
  return result.sink;
}

function fakeSearchFor(
  chunkId: string,
): NonNullable<RetrieveContextOptions['search']> {
  const found = chunk(chunkId);
  return async (queryText, options = {}) => ({
    hits: [{ chunk: found, score: 0.9 }],
    trace: {
      queryText,
      queryExpansion: {
        enabled: false,
        status: 'disabled',
        originalQueryText: queryText,
        expandedQueryText: queryText,
        matchedAliases: [],
        expansionTerms: [],
        routedResource: options.boostResource,
        selectedResource: options.boostResource,
      },
      coarseHits: [toTraceHit(found, 0.8)],
      rerankHits: [toTraceHit(found, 0.9)],
      latencyMs: { total: 1 },
      cache: { index: { status: 'hit' }, embeddingHit: false },
    },
  });
}

const exactCases = [
  {
    name: 'Deployment container image',
    kind: 'Deployment',
    cursorPath: 'spec.template.spec.containers.image',
    expectedIds: [
      'schema::apps/v1::Deployment::spec.template.spec.containers.image',
      'policy.deployment.image.tag.no-latest',
    ],
  },
  {
    name: 'Pod privileged',
    kind: 'Pod',
    cursorPath: 'spec.containers.securityContext.privileged',
    expectedIds: [
      'schema::v1::Pod::spec.containers.securityContext.privileged',
      'policy.pod.security.privileged.forbidden',
    ],
  },
  {
    name: 'Service type',
    kind: 'Service',
    cursorPath: 'spec.type',
    expectedIds: [
      'schema::v1::Service::spec.type',
      'policy.service.type.nodeport.forbidden',
    ],
  },
  {
    name: 'Ingress TLS',
    kind: 'Ingress',
    cursorPath: 'spec.tls',
    expectedIds: ['schema::networking.k8s.io/v1::Ingress::spec.tls', 'policy.ingress.tls.required'],
  },
  {
    name: 'PVC resource requests',
    kind: 'PersistentVolumeClaim',
    cursorPath: 'spec.resources.requests',
    expectedIds: ['schema::v1::PersistentVolumeClaim::spec.resources.requests'],
  },
];

console.log('pipeline retrieval:');

await check('Ask route 只注入安全 recorder 且不恢复原始持久化入口', () => {
  const routeSource = readFileSync(
    new URL('../../app/api/ask/route.ts', import.meta.url),
    'utf8',
  );

  assert.match(routeSource, /randomUUID\(\)/);
  assert.match(routeSource, /decodeServingObservationConfig\(process\.env\)/);
  assert.match(routeSource, /createLocalObservationSink\(/);
  assert.match(routeSource, /createServingObservationRecorder\(/);
  assert.match(routeSource, /\.traceSink\(/);
  assert.match(routeSource, /\bretrievalOptions\s*:/);
  assert.match(
    routeSource,
    /if \(servingObservation\.mode === 'off'\) return undefined;/,
  );
  assert.match(
    routeSource,
    /console\.error\(`\[serving-observation\] stage=\$\{stage\} code=\$\{code\}`\)/,
  );
  assert.doesNotMatch(
    routeSource,
    /SERVING_TRACES_PATH|servingTracePath|appendServingTrace|appendTraceToPath|readRetrievalTraces/,
  );
  assert.doesNotMatch(
    routeSource,
    /trace\.(?:question|queryText|coarseHits|rerankHits|finalHits)/,
  );
  assert.match(routeSource, /getReadiness\(\)/);
  assert.match(routeSource, /await import\('@\/server\/pipeline'\)/);
  assert.doesNotMatch(
    routeSource,
    /import\s*\{[^}]*\b(?:getClient|prepareAsk)\b[^}]*\}\s*from\s*['"]@\/server\/pipeline['"]/s,
  );
  const readinessOffset = routeSource.indexOf('await getReadiness()');
  const bodyOffset = routeSource.indexOf('await req.json()');
  const pipelineOffset = routeSource.indexOf(
    "await import('@/server/pipeline')",
  );
  assert.ok(readinessOffset >= 0 && readinessOffset < bodyOffset);
  assert.ok(bodyOffset < pipelineOffset);
});

await check('健康路由隔离 liveness 并封闭 readiness 响应', () => {
  const liveSource = readFileSync(
    new URL('../../app/api/health/live/route.ts', import.meta.url),
    'utf8',
  );
  const readySource = readFileSync(
    new URL('../../app/api/health/ready/route.ts', import.meta.url),
    'utf8',
  );

  assert.match(liveSource, /getLiveness\(\)/);
  assert.doesNotMatch(
    liveSource,
    /getReadiness|getCorpusIndex|prepareAsk|DEEPSEEK|VOYAGE/,
  );
  assert.match(readySource, /getReadiness\(\)/);
  assert.match(readySource, /status:\s*readiness\.status\s*===\s*'ready'\s*\?\s*200\s*:\s*503/);
  assert.doesNotMatch(readySource, /detail|path|hash|process\.env/);
});

await check('默认 off recorder 不调用 sink 或创建 observation 文件', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pipeline-serving-off-'));
  const observationRoot = join(tempRoot, 'data', 'observability');
  let appendCalls = 0;
  const recorder = createServingObservationRecorder(
    { mode: 'off' },
    {
      sink: {
        append() {
          appendCalls++;
          throw new Error('off mode must not call sink');
        },
      },
    },
  );

  try {
    const result = await retrieveContext(
      `password=${SERVING_RAW_SECRET}`,
      3,
      { kind: 'Service', cursorPath: 'spec.type' },
      'explain_field',
      { traceSink: recorder.traceSink(SERVING_REQUEST_IDS[0]) },
    );

    assert.equal(result.trace.path, 'exact');
    assert.equal(appendCalls, 0);
    assert.equal(existsSync(observationRoot), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

await check(
  'local recorder 对 exact/search 写入同一 strict observation contract',
  async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'pipeline-serving-local-'));
    const observationRoot = join(tempRoot, 'data', 'observability');
    const observationIds = [...SERVING_OBSERVATION_IDS];
    const sink = requiredLocalSink(
      createLocalObservationSink({
        rootDir: observationRoot,
        maxFileBytes: LOCAL_SERVING_CONFIG.maxFileBytes,
        maxTotalBytes: LOCAL_SERVING_CONFIG.maxTotalBytes,
        retentionDays: LOCAL_SERVING_CONFIG.retentionDays,
        clock: () => SERVING_NOW,
      }),
    );
    const recorder = createServingObservationRecorder(LOCAL_SERVING_CONFIG, {
      clock: () => SERVING_NOW,
      idFactory: () => {
        const id = observationIds.shift();
        assert.ok(id);
        return id;
      },
      sampler: () => true,
      sink,
    });

    try {
      const exact = await retrieveContext(
        `password=${SERVING_RAW_SECRET}`,
        3,
        { kind: 'Service', cursorPath: 'spec.type' },
        'explain_field',
        { traceSink: recorder.traceSink(SERVING_REQUEST_IDS[0]) },
      );
      const search = await retrieveContext(
        `password=${SERVING_RAW_SECRET}`,
        3,
        { kind: 'Deployment', cursorPath: 'unknown.image' },
        'explain_field',
        {
          search: fakeSearchFor('schema::v1::Service::spec.type'),
          queryExpansion: false,
          traceSink: recorder.traceSink(SERVING_REQUEST_IDS[1]),
        },
      );

      assert.equal(exact.trace.path, 'exact');
      assert.equal(search.trace.path, 'search');
      const segmentNames = readdirSync(observationRoot);
      assert.deepEqual(segmentNames, [
        'serving-observations.2026-07-21.0001.jsonl',
      ]);
      const lines = readFileSync(
        join(observationRoot, segmentNames[0]!),
        'utf8',
      )
        .trimEnd()
        .split('\n');
      const observations = lines.map((line) =>
        decodeServingRetrievalObservation(JSON.parse(line)),
      );

      assert.deepEqual(
        observations.map((observation) => observation.route.path),
        ['exact', 'search'],
      );
      assert.deepEqual(
        observations.map((observation) => observation.requestId),
        SERVING_REQUEST_IDS,
      );
      const serialized = JSON.stringify(observations);
      assert.equal(serialized.includes(SERVING_RAW_SECRET), false);
      assert.equal(serialized.includes('queryText'), false);
      assert.equal(serialized.includes('selectedText'), false);
      assert.equal(existsSync(join(tempRoot, 'data', 'eval')), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

await check(
  'observation 丢弃与写入故障不改变 pipeline 检索结果',
  async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'pipeline-serving-failures-'));
    const oversizedConfig = {
      ...LOCAL_SERVING_CONFIG,
      maxFileBytes: 1,
      maxTotalBytes: 1,
    };
    const oversizedSink = requiredLocalSink(
      createLocalObservationSink({
        rootDir: join(tempRoot, 'oversized'),
        maxFileBytes: oversizedConfig.maxFileBytes,
        maxTotalBytes: oversizedConfig.maxTotalBytes,
        retentionDays: oversizedConfig.retentionDays,
        clock: () => SERVING_NOW,
      }),
    );
    const sinkMustNotRun: LocalObservationSink = {
      append() {
        throw new Error('dropped observation must not call sink');
      },
    };
    const cases: {
      name: string;
      recorder: ReturnType<typeof createServingObservationRecorder>;
      expected: ServingObservationRecordResult;
    }[] = [
      {
        name: 'sample miss',
        recorder: createServingObservationRecorder(LOCAL_SERVING_CONFIG, {
          sampler: () => false,
          sink: sinkMustNotRun,
        }),
        expected: { status: 'sampled_out' },
      },
      {
        name: 'redaction verification failure',
        recorder: createServingObservationRecorder(LOCAL_SERVING_CONFIG, {
          sampler: () => true,
          redactor() {
            throw new ServingRedactionError('verification_failed');
          },
          sink: sinkMustNotRun,
        }),
        expected: {
          status: 'redaction_failed',
          errorCode: 'verification_failed',
        },
      },
      {
        name: 'oversized observation',
        recorder: createServingObservationRecorder(oversizedConfig, {
          clock: () => SERVING_NOW,
          idFactory: () => SERVING_OBSERVATION_IDS[0],
          sampler: () => true,
          sink: oversizedSink,
        }),
        expected: {
          status: 'write_failed',
          errorCode: 'observation_too_large',
        },
      },
      {
        name: 'rotation failure',
        recorder: createServingObservationRecorder(LOCAL_SERVING_CONFIG, {
          clock: () => SERVING_NOW,
          idFactory: () => SERVING_OBSERVATION_IDS[0],
          sampler: () => true,
          sink: {
            append() {
              return {
                ok: false,
                error: { code: 'segment_create_failed' },
              };
            },
          },
        }),
        expected: {
          status: 'write_failed',
          errorCode: 'segment_create_failed',
        },
      },
      {
        name: 'write failure',
        recorder: createServingObservationRecorder(LOCAL_SERVING_CONFIG, {
          clock: () => SERVING_NOW,
          idFactory: () => SERVING_OBSERVATION_IDS[0],
          sampler: () => true,
          sink: {
            append() {
              throw new Error(SERVING_RAW_SECRET);
            },
          },
        }),
        expected: { status: 'write_failed', errorCode: 'sink_internal' },
      },
    ];

    try {
      for (const testCase of cases) {
        const recordResults: ServingObservationRecordResult[] = [];
        const result = await retrieveContext(
          `password=${SERVING_RAW_SECRET}`,
          3,
          { kind: 'Service', cursorPath: 'spec.type' },
          'explain_field',
          {
            traceSink(trace) {
              recordResults.push(
                testCase.recorder.record(SERVING_REQUEST_IDS[0], trace),
              );
            },
          },
        );

        assert.equal(result.trace.path, 'exact', testCase.name);
        assert.deepEqual(
          result.hits.map((hit) => hit.id),
          [
            'schema::v1::Service::spec.type',
            'policy.service.type.nodeport.forbidden',
          ],
          testCase.name,
        );
        assert.deepEqual(recordResults, [testCase.expected], testCase.name);
        assert.equal(
          JSON.stringify(recordResults).includes(SERVING_RAW_SECRET),
          false,
          testCase.name,
        );
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

await check(
  '未传 trace sink 时只返回 trace',
  async () => {
    const result = await retrieveContext(
      '解释当前字段',
      3,
      { kind: 'Deployment', cursorPath: 'spec.template.spec.containers.image' },
      'explain_field',
    );

    assert.equal(result.trace.path, 'exact');
    assert.deepEqual(result.trace.cache?.index, { status: 'not_used' });
    assert.equal(result.trace.queryExpansion?.status, 'skipped_exact');
    assert.deepEqual(
      result.trace.finalHits.map((hit) => hit.id),
      [
        'schema::apps/v1::Deployment::spec.template.spec.containers.image',
        'policy.deployment.image.tag.no-latest',
      ],
    );
    const [schemaHit, policyHit] = result.trace.finalHits;
    assert.deepEqual(schemaHit?.targets, [
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        path: 'spec.template.spec.containers.image',
      },
    ]);
    assert.equal(schemaHit?.provenance.authority, 'cluster_api');
    assert.equal(policyHit?.provenance.authority, 'organization');
    assert.equal('resource' in schemaHit!, false);
    assert.equal('trustLevel' in schemaHit!, false);
  },
);

await check('调用方可注入内存 trace sink', async () => {
  const traces: RetrievalTrace[] = [];
  const result = await retrieveContext(
    '解释当前字段',
    3,
    { kind: 'Service', cursorPath: 'spec.type' },
    'explain_field',
    { traceSink: (trace) => traces.push(trace) },
  );

  assert.equal(result.trace.path, 'exact');
  assert.deepEqual(traces, [result.trace]);
  assert.equal(traces[0]!.queryExpansion?.status, 'skipped_exact');
  assert.deepEqual(traces[0]!.finalHits[0]!.targets, [
    { apiVersion: 'v1', kind: 'Service', path: 'spec.type' },
  ]);
});

await check(
  'exact path 覆盖核心字段,并返回 schema/policy 分层来源',
  async () => {
    for (const tc of exactCases) {
      const result = await retrieveContext(
        '解释当前字段',
        5,
        { kind: tc.kind, cursorPath: tc.cursorPath },
        'explain_field',
      );

      assert.equal(result.trace.path, 'exact', tc.name);
      assert.deepEqual(
        result.hits.map((hit) => hit.id),
        tc.expectedIds,
        tc.name,
      );
      assert.deepEqual(
        result.sources.map((source) => source.id),
        tc.expectedIds,
        tc.name,
      );
    }
  },
);

await check('exact path 未命中时回到 search path', async () => {
  const serviceType = chunk('schema::v1::Service::spec.type');
  let called = false;
  let boostPath: string | undefined;
  const fakeSearch: RetrieveContextOptions['search'] = async (
    queryText,
    options = {},
  ) => {
    called = true;
    boostPath = options.boostPath;
    return {
      hits: [{ chunk: serviceType, score: 0.9 }],
      trace: {
        queryText,
        queryExpansion: {
          enabled: false,
          status: 'disabled',
          originalQueryText: queryText,
          expandedQueryText: queryText,
          matchedAliases: [],
          expansionTerms: [],
          routedResource: options.boostResource,
          selectedResource: options.boostResource,
        },
        coarseHits: [toTraceHit(serviceType, 0.8)],
        rerankHits: [toTraceHit(serviceType, 0.9)],
        latencyMs: { total: 1 },
        cache: { index: { status: 'hit' }, embeddingHit: false },
      },
    };
  };

  const result = await retrieveContext(
    '解释当前字段',
    3,
    { kind: 'Deployment', cursorPath: 'unknown.image' },
    'explain_field',
    { search: fakeSearch, queryExpansion: false },
  );

  assert.equal(called, true);
  assert.equal(boostPath, 'unknown.image');
  assert.equal(result.trace.path, 'search');
  assert.deepEqual(
    result.hits.map((hit) => hit.id),
    ['schema::v1::Service::spec.type'],
  );
});

await check(
  '错误解释复用真实 fixture、Ask 检索和共享模型请求',
  async () => {
    const evalCase = GROUNDED_ANSWER_CASES.find(
      (candidate) => candidate.id === 'error-deployment-replicas-type',
    );
    assert.ok(evalCase);
    const resolved = resolveGroundedAnswerCase(evalCase);
    assert.ok(resolved.editorContext);

    let searchCalled = false;
    const search: RetrieveContextOptions['search'] = async () => {
      searchCalled = true;
      throw new Error('exact error path must not call search');
    };
    const prepared = await prepareAsk({
      question: resolved.question,
      k: 3,
      editorContext: resolved.editorContext,
      mode: 'explain_error',
      retrievalOptions: { search, queryExpansion: false },
    });

    assert.equal(searchCalled, false);
    assert.equal(prepared.trace.mode, 'explain_error');
    assert.equal(prepared.trace.fieldPathHint, 'spec.replicas');
    assert.match(prepared.trace.queryText, /spec\.replicas/);
    assert.match(prepared.trace.queryText, /错误:/);
    assert.deepEqual(
      prepared.hits.map((hit) => hit.id),
      [
        'schema::apps/v1::Deployment::spec.replicas',
        'policy.deployment.replicas.min-two',
      ],
    );
    assert.equal(prepared.request.system, ASK_SYSTEM);
    assert.equal(prepared.request.model, ANSWER_MODEL);
    assert.equal(prepared.request.max_tokens, ASK_MAX_TOKENS);
    const userMessage = prepared.request.messages[0]?.content;
    assert.equal(typeof userMessage, 'string');
    assert.match(userMessage as string, /<ask_mode>\nexplain_error/);
    assert.match(userMessage as string, /<current_yaml>/);
    assert.match(userMessage as string, /replicas: "3"/);
    assert.match(userMessage as string, /spec\.replicas/);

    const requests: unknown[] = [];
    const client = {
      messages: {
        create: async (request: unknown) => {
          requests.push(request);
          return {
            content: [{ type: 'text', text: 'replicas 应使用整数。' }],
          };
        },
      },
    } as unknown as Anthropic;
    assert.equal(
      await textOfRequest(client, prepared.request),
      'replicas 应使用整数。',
    );
    assert.deepEqual(requests, [prepared.request]);
  },
);

console.log(`\n通过 ${passed} 项`);
