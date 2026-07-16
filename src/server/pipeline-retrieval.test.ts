import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORPUS } from '../knowledge/corpus';
import {
  appendServingTrace,
  appendTraceToPath,
  readRetrievalTraces,
  servingTracePath,
  toTraceHit,
  SERVING_TRACES_PATH,
} from '../retrieval/trace';
import { retrieveContext, type RetrieveContextOptions } from './pipeline';

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

await check('eval 调用可注入 run-scoped trace sink', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-eval-trace-'));
  try {
    const tracePath = join(dir, 'data', 'eval', 'traces', 'run-1.jsonl');
    const result = await retrieveContext(
      '解释当前字段',
      3,
      { kind: 'Service', cursorPath: 'spec.type' },
      'explain_field',
      { traceSink: (trace) => appendTraceToPath(tracePath, trace) },
    );

    assert.equal(result.trace.path, 'exact');
    assert.equal(existsSync(tracePath), true);
    const traces = readRetrievalTraces(tracePath);
    assert.equal(traces.length, 1);
    assert.equal(traces[0]!.path, 'exact');
    assert.equal(traces[0]!.queryExpansion?.status, 'skipped_exact');
    assert.deepEqual(traces[0]!.finalHits[0]!.targets, [
      { apiVersion: 'v1', kind: 'Service', path: 'spec.type' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check(
  'serving trace sink 写入 data/observability,不写 eval artifact',
  async () => {
    assert.equal(
      SERVING_TRACES_PATH.endsWith('data/observability/serving-traces.jsonl'),
      true,
    );
    assert.equal(SERVING_TRACES_PATH.includes('/data/eval/'), false);

    const dir = mkdtempSync(join(tmpdir(), 'pipeline-serving-trace-'));
    try {
      const servingPath = servingTracePath(dir);
      const evalPath = join(dir, 'data', 'eval', 'traces', 'run-1.jsonl');

      await retrieveContext(
        '解释当前字段',
        3,
        { kind: 'Ingress', cursorPath: 'spec.tls' },
        'explain_field',
        { traceSink: (trace) => appendServingTrace(trace, servingPath) },
      );

      assert.equal(existsSync(servingPath), true);
      assert.equal(existsSync(evalPath), false);
      const traces = readRetrievalTraces(servingPath);
      assert.equal(traces.length, 1);
      assert.equal(traces[0]!.path, 'exact');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await check('serving trace sink 失败不中断 editor retrieval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-serving-fail-open-'));
  const blockedParent = join(dir, 'blocked');
  writeFileSync(blockedParent, 'not a directory');
  const previousConsoleError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  try {
    const result = await retrieveContext(
      '解释当前字段',
      3,
      { kind: 'Service', cursorPath: 'spec.type' },
      'explain_field',
      {
        traceSink: (trace) => {
          appendServingTrace(trace, join(blockedParent, 'trace.jsonl'));
        },
      },
    );

    assert.equal(result.trace.path, 'exact');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /serving retrieval trace write failed/);
  } finally {
    console.error = previousConsoleError;
    rmSync(dir, { recursive: true, force: true });
  }
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

console.log(`\n通过 ${passed} 项`);
