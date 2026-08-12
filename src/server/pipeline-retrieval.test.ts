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
  buildAskUserMessage,
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
  targetResource?: string,
): NonNullable<RetrieveContextOptions['search']> {
  return fakeSearchForIds([chunkId], targetResource);
}

function fakeSearchForIds(
  chunkIds: readonly string[],
  targetResource?: string,
): NonNullable<RetrieveContextOptions['search']> {
  const found = chunkIds.map(chunk);
  return async (queryText, options = {}) => {
    const selectedResource = targetResource ?? options.boostResource;
    return {
      hits: found.map((candidate, index) => ({
        chunk: candidate,
        score: 0.9 - index * 0.1,
      })),
      targetResource: selectedResource,
      trace: {
        queryText,
        queryExpansion: {
          enabled: targetResource !== undefined,
          status: targetResource === undefined ? 'disabled' : 'applied',
          originalQueryText: queryText,
          expandedQueryText: queryText,
          matchedAliases: [],
          expansionTerms: [],
          routedResource: options.boostResource,
          selectedResource,
          ...(targetResource !== undefined &&
          targetResource !== options.boostResource
            ? {
                resourceSelectionReason:
                  'cross_resource_strong_alias' as const,
              }
            : {}),
        },
        coarseHits: found.map((candidate, index) =>
          toTraceHit(candidate, 0.8 - index * 0.1),
        ),
        rerankHits: found.map((candidate, index) =>
          toTraceHit(candidate, 0.9 - index * 0.1),
        ),
        latencyMs: { total: 1 },
        cache: { index: { status: 'hit' }, embeddingHit: false },
      },
    };
  };
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

await check('Ask 使用统一的严格证据与拒答边界', () => {
  assert.match(ASK_SYSTEM, /证据边界:事实只能来自 <docs>/);
  assert.match(ASK_SYSTEM, /有限选项中限定用户所指对象/);
  assert.match(ASK_SYSTEM, /常识、模型记忆、未展示内容和外部链接都不是证据/);
  assert.match(ASK_SYSTEM, /候选证据,不是逐条介绍清单/);
  assert.match(ASK_SYSTEM, /字段、资源、API、参数、键、命令/);
  assert.match(ASK_SYSTEM, /限制本身不能推出未明示的补救动作/);
  assert.match(ASK_SYSTEM, /核心问题已有完整答案时立即结束/);
  assert.match(ASK_SYSTEM, /即使是否定描述.*不得点名证据中未出现的字段或选项/);
  assert.match(ASK_SYSTEM, /path 是完整字段路径.*必须原样使用/);
  assert.match(ASK_SYSTEM, /单字段段 path 表示顶层字段/);
  assert.match(ASK_SYSTEM, /问题目标资源与当前资源不同时,不得复制当前 YAML/);
  assert.match(ASK_SYSTEM, /应基于该来源输出一个最小完整资源 YAML 代码块/);
  assert.match(ASK_SYSTEM, /example 只提供配置参考,不替代 schema 合法性/);
  assert.match(
    ASK_SYSTEM,
    /只含 `apiVersion`、`kind`、`metadata\.name` 的通用骨架/,
  );
  assert.match(ASK_SYSTEM, /保留其 `apiVersion`、`kind`、`metadata\.name`/);
  assert.match(ASK_SYSTEM, /名称使用 `example` 或 `example-` 开头/);
  assert.match(ASK_SYSTEM, /`metadata\.namespace` 不属于通用骨架/);
  assert.match(ASK_SYSTEM, /object 字段而没有子字段 schema 或 example/);
  assert.match(ASK_SYSTEM, /不得命名真实或占位子键/);
  assert.match(ASK_SYSTEM, /不得生成该对象的 YAML/);
  assert.match(ASK_SYSTEM, /不得列举证据中未出现的具体例子/);
  assert.match(ASK_SYSTEM, /无法据此回答.*并停止/);
  assert.match(ASK_SYSTEM, /不追加命令、替代方案或无关片段/);
  assert.doesNotMatch(ASK_SYSTEM, /可为该字段使用明显占位值/);
  assert.doesNotMatch(ASK_SYSTEM, /可附加只含/);
  assert.doesNotMatch(ASK_SYSTEM, /不得输出 YAML 代码块/);
  assert.match(
    buildAskUserMessage({
      question: 'Pod 镜像拉取策略怎么配?',
      context: '<docs>',
      mode: 'free',
    }),
    /<current_yaml>\n无\n<\/current_yaml>/,
  );
});

await check('配置型 Ask 在真实编辑器上下文中附加目标资源的官方示例', async () => {
  const rankedIds = [
    'docs::kubernetes::resource-quotas::compute-resource-quota',
    'schema::v1::ResourceQuota::spec.hard',
    'schema::v1::ResourceQuota::status.hard',
  ];
  const search = fakeSearchForIds(rankedIds);

  const prepared = await prepareAsk({
    question: 'ResourceQuota 怎么设置命名空间的资源硬限制?',
    k: 3,
    mode: 'free',
    retrievalOptions: { search, queryExpansion: false },
  });
  assert.deepEqual(
    prepared.hits.map((hit) => hit.id),
    [...rankedIds, 'example::kubernetes::resource-quota-mem-cpu'],
  );
  assert.deepEqual(
    prepared.trace.finalHits.map((hit) => hit.id),
    prepared.hits.map((hit) => hit.id),
  );
  assert.match(prepared.context, /CPU 与内存配额示例/);
  assert.match(prepared.context, /```yaml\napiVersion: v1/u);
  assert.doesNotMatch(prepared.context, /ResourceQuota · metadata\.namespace/);

  const disabled = await prepareAsk({
    question: 'ResourceQuota 怎么设置命名空间的资源硬限制?',
    k: 3,
    mode: 'free',
    retrievalOptions: {
      search,
      queryExpansion: false,
      resourceExampleScaffoldEvidence: false,
    },
  });
  assert.deepEqual(
    disabled.hits.map((hit) => hit.id),
    rankedIds,
  );

  const conceptual = await prepareAsk({
    question: 'ResourceQuota 的 spec.hard 是什么?',
    k: 3,
    mode: 'free',
    retrievalOptions: { search, queryExpansion: false },
  });
  assert.deepEqual(
    conceptual.hits.map((hit) => hit.id),
    rankedIds,
  );

  const withCurrentYaml = await prepareAsk({
    question: 'ResourceQuota 怎么设置命名空间的资源硬限制?',
    k: 3,
    mode: 'free',
    editorContext: {
      yaml: 'apiVersion: v1\nkind: ResourceQuota\nmetadata:\n  name: current',
      kind: 'ResourceQuota',
      apiVersion: 'v1',
    },
    retrievalOptions: { search, queryExpansion: false },
  });
  assert.deepEqual(
    withCurrentYaml.hits.map((hit) => hit.id),
    [...rankedIds, 'example::kubernetes::resource-quota-mem-cpu'],
  );

  const withDifferentCurrentYaml = await prepareAsk({
    question: 'ResourceQuota 怎么设置命名空间的资源硬限制?',
    k: 3,
    mode: 'free',
    editorContext: {
      yaml: 'apiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: current',
      kind: 'StorageClass',
      apiVersion: 'storage.k8s.io/v1',
      selectedText: 'reclaimPolicy: Retain',
      cursorPath: 'reclaimPolicy',
    },
    retrievalOptions: { search, queryExpansion: false },
  });
  assert.deepEqual(
    withDifferentCurrentYaml.hits.map((hit) => hit.id),
    [...rankedIds, 'example::kubernetes::resource-quota-mem-cpu'],
  );
  assert.equal(withDifferentCurrentYaml.trace.resourceHint, 'ResourceQuota');
  assert.equal(withDifferentCurrentYaml.trace.apiVersionHint, undefined);
  assert.equal(withDifferentCurrentYaml.trace.fieldPathHint, undefined);
  assert.match(withDifferentCurrentYaml.trace.queryText, /资源:ResourceQuota/u);
  assert.doesNotMatch(
    withDifferentCurrentYaml.trace.queryText,
    /StorageClass|storage\.k8s\.io|reclaimPolicy/u,
  );
});

await check('配置型 Ask 的官方示例不占用三条核心证据槽', async () => {
  const exampleId = 'example::kubernetes::limit-range-mem-cpu-container';
  const coreIds = [
    'docs::kubernetes::limit-range::constraints-on-resource-limits-and-requests',
    'schema::v1::LimitRange::spec.limits.default',
    'schema::v1::LimitRange::spec.limits.defaultRequest',
  ];
  const rankedIds = [
    exampleId,
    ...coreIds,
    'policy.limitrange.per-namespace.recommended',
  ];
  const search = fakeSearchForIds(rankedIds);

  const prepared = await prepareAsk({
    question: 'LimitRange 怎么给容器设默认资源?',
    k: 3,
    mode: 'free',
    retrievalOptions: { search, queryExpansion: false },
  });
  assert.deepEqual(
    prepared.trace.rerankHits.map((hit) => hit.id),
    rankedIds,
  );
  assert.deepEqual(
    prepared.hits.map((hit) => hit.id),
    [...coreIds, exampleId],
  );
  assert.deepEqual(
    prepared.trace.finalHits.map((hit) => hit.id),
    prepared.hits.map((hit) => hit.id),
  );

  const disabled = await prepareAsk({
    question: 'LimitRange 怎么给容器设默认资源?',
    k: 3,
    mode: 'free',
    retrievalOptions: {
      search,
      queryExpansion: false,
      resourceExampleScaffoldEvidence: false,
    },
  });
  assert.deepEqual(
    disabled.hits.map((hit) => hit.id),
    rankedIds.slice(0, 3),
  );
});

await check('申请类配置问题按核心字段追加唯一官方示例', async () => {
  const cases = [
    {
      question: 'StatefulSet 怎么给每个副本申请独立存储?',
      rankedIds: [
        'docs::kubernetes::statefulset::volume-claim-templates',
        'docs::kubernetes::statefulset::stable-storage',
        'schema::apps/v1::StatefulSet::spec.volumeClaimTemplates',
      ],
      exampleId:
        'example::kubernetes::statefulset-volume-claim-template',
      expectedKind: 'StatefulSet',
    },
    {
      question: 'PVC 怎么申请存储大小?',
      rankedIds: [
        'policy.pvc.resources.requests.storage.required',
        'schema::v1::PersistentVolumeClaim::spec.resources.requests',
        'schema::v1::PersistentVolumeClaim::spec.resources',
      ],
      exampleId:
        'example::kubernetes::persistent-volume-claim-storage-request',
      expectedKind: 'PersistentVolumeClaim',
    },
  ] as const;

  for (const candidate of cases) {
    const prepared = await prepareAsk({
      question: candidate.question,
      k: 3,
      mode: 'free',
      retrievalOptions: {
        search: fakeSearchForIds(candidate.rankedIds),
        queryExpansion: false,
      },
    });
    assert.deepEqual(prepared.hits.map((hit) => hit.id), [
      ...candidate.rankedIds,
      candidate.exampleId,
    ]);
    assert.match(prepared.context, new RegExp(`kind: ${candidate.expectedKind}`, 'u'));
    if (candidate.expectedKind === 'StatefulSet') {
      assert.match(
        prepared.context,
        /设置 `\.spec\.volumeClaimTemplates` 字段来创建/u,
      );
      assert.match(
        prepared.context,
        /每个 Pod 接收到一个 PersistentVolumeClaim/u,
      );
    }
  }
});

await check('配置型 Ask 按核心证据而非问题中的关联资源选择官方示例', async () => {
  const rankedIds = [
    'docs::kubernetes::storage-classes::volume-binding-mode',
    'schema::storage.k8s.io/v1::StorageClass::volumeBindingMode',
    'schema::v1::Pod::spec.nodeName',
  ];
  const prepared = await prepareAsk({
    question: '怎么让卷延迟到 Pod 调度后再绑定?',
    k: 3,
    mode: 'free',
    editorContext: {
      yaml: 'apiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: current',
      kind: 'StorageClass',
      apiVersion: 'storage.k8s.io/v1',
    },
    retrievalOptions: {
      search: fakeSearchForIds(rankedIds, 'StorageClass'),
      queryExpansion: false,
    },
  });

  assert.equal(prepared.trace.resourceHint, 'StorageClass');
  assert.equal(prepared.trace.queryExpansion?.routedResource, 'Pod');
  assert.equal(
    prepared.trace.queryExpansion?.selectedResource,
    'StorageClass',
  );
  assert.deepEqual(
    prepared.hits.map((hit) => hit.id),
    [...rankedIds, 'example::kubernetes::storageclass-low-latency'],
  );
  assert.match(prepared.context, /kind: StorageClass/u);
  assert.match(prepared.context, /name: low-latency/u);
  assert.doesNotMatch(prepared.context, /Pod · metadata\.name/u);
});

await check('跨资源最终目标驱动无示例时的通用骨架身份', async () => {
  const rankedIds = [
    'schema::autoscaling/v2::HorizontalPodAutoscaler::spec.maxReplicas',
  ];
  const prepared = await prepareAsk({
    question: 'Pod 怎么设置最大副本数?',
    k: 3,
    mode: 'free',
    retrievalOptions: {
      search: fakeSearchForIds(rankedIds, 'HorizontalPodAutoscaler'),
      queryExpansion: true,
    },
  });

  assert.equal(prepared.trace.resourceHint, 'HorizontalPodAutoscaler');
  assert.deepEqual(
    prepared.hits.map((hit) => hit.id),
    [
      ...rankedIds,
      'schema::autoscaling/v2::HorizontalPodAutoscaler::metadata.name',
    ],
  );
  assert.doesNotMatch(prepared.context, /Pod · metadata\.name/u);
});

await check('多资源核心证据分别匹配官方示例时不猜测', async () => {
  const rankedIds = [
    'schema::v1::ResourceQuota::spec.hard',
    'schema::v1::LimitRange::spec.limits.default',
  ];
  const prepared = await prepareAsk({
    question: '这些资源怎么配置?',
    k: 3,
    mode: 'free',
    editorContext: {
      yaml: 'apiVersion: v1\nkind: ResourceQuota\nmetadata:\n  name: current',
      kind: 'ResourceQuota',
      apiVersion: 'v1',
    },
    retrievalOptions: {
      search: fakeSearchForIds(rankedIds),
      queryExpansion: false,
    },
  });

  assert.deepEqual(
    prepared.hits.map((hit) => hit.id),
    rankedIds,
  );
  assert.equal(
    prepared.hits.some((hit) => hit.sourceType === 'example'),
    false,
  );
});

await check('没有匹配官方示例时保留 schema 驱动的通用骨架', async () => {
  const rankedIds = [
    'schema::autoscaling/v2::HorizontalPodAutoscaler::spec.maxReplicas',
  ];
  const prepared = await prepareAsk({
    question: 'HPA 怎么设置最大副本数?',
    k: 3,
    mode: 'free',
    retrievalOptions: {
      search: fakeSearchForIds(rankedIds),
      queryExpansion: false,
    },
  });
  assert.deepEqual(
    prepared.hits.map((hit) => hit.id),
    [
      ...rankedIds,
      'schema::autoscaling/v2::HorizontalPodAutoscaler::metadata.name',
    ],
  );
});

await check('Ask route 只注入安全 recorder 且不恢复原始持久化入口', () => {
  const routeSource = readFileSync(
    new URL('../../app/api/ask/route.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(routeSource, /randomUUID\(\)/);
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
  assert.match(
    routeSource,
    /requireAskRuntimeAccess\(\)/,
  );
  assert.match(
    routeSource,
    /controller\.enqueue\(sse\('error', upstreamErrorEvent\(error\)\)\)/,
  );
  assert.match(
    routeSource,
    /requireModelText\(modelTextResponse\(finalMessage\)\)/,
  );
  const requireTextOffset = routeSource.indexOf(
    'requireModelText(modelTextResponse(finalMessage))',
  );
  const successAccountingOffset = routeSource.indexOf(
    "finishAccounting('success')",
  );
  const doneEventOffset = routeSource.indexOf("sse('done'");
  assert.ok(requireTextOffset >= 0);
  assert.ok(requireTextOffset < successAccountingOffset);
  assert.ok(successAccountingOffset < doneEventOffset);
  assert.doesNotMatch(routeSource, /controller\.error\(/);
  assert.doesNotMatch(routeSource, /process\.env\.(?:DEEPSEEK|VOYAGE)/);
  assert.match(routeSource, /await import\('@\/server\/pipeline'\)/);
  assert.doesNotMatch(
    routeSource,
    /import\s*\{[^}]*\b(?:getClient|prepareAsk)\b[^}]*\}\s*from\s*['"]@\/server\/pipeline['"]/s,
  );
  const readinessOffset = routeSource.indexOf('await getReadiness()');
  const capabilityOffset = routeSource.indexOf(
    'requireAskRuntimeAccess()',
  );
  const bodyOffset = routeSource.indexOf('await req.json()');
  const boundedBodyOffset = routeSource.indexOf(
    "await readApiRequest(req, 'ask')",
  );
  const pipelineOffset = routeSource.indexOf(
    "await import('@/server/pipeline')",
  );
  assert.ok(
    capabilityOffset >= 0 &&
      capabilityOffset < readinessOffset &&
      readinessOffset < boundedBodyOffset,
  );
  assert.equal(bodyOffset, -1);
  assert.ok(boundedBodyOffset < pipelineOffset);
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
  const indexedServiceType = {
    ...serviceType,
    embedding: new Float32Array([0.25, 0.75]),
  };
  let called = false;
  let boostPath: string | undefined;
  const fakeSearch: RetrieveContextOptions['search'] = async (
    queryText,
    options = {},
  ) => {
    called = true;
    boostPath = options.boostPath;
    return {
      hits: [{ chunk: indexedServiceType, score: 0.9 }],
      targetResource: options.boostResource,
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
  assert.equal('embedding' in result.hits[0]!, false);
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
    assert.deepEqual(prepared.request.thinking, { type: 'disabled' });
    assert.equal(prepared.request.temperature, 0);
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

await check('对象字段错误进入 search 路径以检索子字段证据', async () => {
  const evalCase = GROUNDED_ANSWER_CASES.find(
    (candidate) => candidate.id === 'error-deployment-missing-selector',
  );
  assert.ok(evalCase);
  const resolved = resolveGroundedAnswerCase(evalCase);
  assert.ok(resolved.editorContext);

  const ranked = [
    chunk('schema::apps/v1::Deployment::spec.selector'),
    chunk('schema::apps/v1::Deployment::spec.selector.matchLabels'),
    chunk('schema::apps/v1::Deployment::spec.selector.matchExpressions'),
  ];
  let searchCalled = false;
  let boostPath: string | undefined;
  let boostDirectSchemaChildren: boolean | undefined;
  const search: RetrieveContextOptions['search'] = async (
    queryText,
    options = {},
  ) => {
    searchCalled = true;
    boostPath = options.boostPath;
    boostDirectSchemaChildren = options.boostDirectSchemaChildren;
    return {
      hits: ranked.map((schemaChunk, index) => ({
        chunk: schemaChunk,
        score: 0.9 - index * 0.1,
      })),
      targetResource: options.boostResource,
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
        coarseHits: ranked.map((schemaChunk, index) =>
          toTraceHit(schemaChunk, 0.8 - index * 0.1),
        ),
        rerankHits: ranked.map((schemaChunk, index) =>
          toTraceHit(schemaChunk, 0.9 - index * 0.1),
        ),
        latencyMs: { total: 1 },
        cache: { index: { status: 'hit' }, embeddingHit: false },
      },
    };
  };

  const prepared = await prepareAsk({
    question: resolved.question,
    k: 3,
    editorContext: resolved.editorContext,
    mode: 'explain_error',
    retrievalOptions: { search, queryExpansion: false },
  });

  assert.equal(searchCalled, true);
  assert.equal(boostPath, 'spec.selector');
  assert.equal(boostDirectSchemaChildren, true);
  assert.equal(prepared.trace.path, 'search');
  assert.deepEqual(
    prepared.hits.map((hit) => hit.id),
    ranked.map((schemaChunk) => schemaChunk.id),
  );
  assert.deepEqual(
    resolved.expectedChunkIds.filter((id) =>
      prepared.hits.some((hit) => hit.id === id),
    ),
    resolved.expectedChunkIds,
  );

  await prepareAsk({
    question: resolved.question,
    k: 3,
    editorContext: resolved.editorContext,
    mode: 'explain_error',
    retrievalOptions: {
      search,
      queryExpansion: false,
      structuredErrorDirectSchemaChildBoost: false,
    },
  });
  assert.equal(boostDirectSchemaChildren, false);
});

console.log(`\n通过 ${passed} 项`);
