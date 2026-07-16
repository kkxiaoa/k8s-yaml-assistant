import assert from 'node:assert/strict';
import type { KnowledgeChunk } from './chunk';
import {
  buildCorpusIdentity,
  buildSourceManifest,
  canonicalHash,
  canonicalJson,
  canonicalTargets,
  schemaChunkId,
  type KnowledgeTarget,
} from './identity';

const SCHEMA_CHUNK: KnowledgeChunk = {
  id: 'schema::v1::Pod::spec.containers.image',
  title: 'Pod · spec.containers.image',
  text: 'Pod 的字段 spec.containers.image:容器镜像。类型 string',
  sourceType: 'schema',
  provenance: { authority: 'kubernetes_official', version: 'v1' },
  targets: [
    { apiVersion: 'v1', kind: 'Pod', path: 'spec.containers.image' },
  ],
};

const POLICY_CHUNK: KnowledgeChunk = {
  id: 'policy.pod.image.no-latest',
  title: '平台规范 · Pod · spec.containers.image',
  text: '容器镜像禁止使用 latest tag。',
  sourceType: 'policy',
  provenance: { authority: 'organization', version: '2026-07-07' },
  targets: [{ kind: 'Pod', path: 'spec.containers.image' }],
};

function schemaProvider(
  overrides: Partial<{
    version: string;
    generatedAt: string;
    chunks: KnowledgeChunk[];
  }> = {},
) {
  return {
    providerId: 'schema.curated-openapi',
    sourceType: 'schema' as const,
    chunks: [SCHEMA_CHUNK],
    ...overrides,
  };
}

function policyProvider(chunks: KnowledgeChunk[] = [POLICY_CHUNK]) {
  return {
    providerId: 'policy.organization',
    sourceType: 'policy' as const,
    chunks,
  };
}

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

console.log('knowledge identity:');

check('target 缺少非空 kind 时拒绝', () => {
  assert.throws(
    () =>
      canonicalTargets([
        { apiVersion: 'v1', path: 'spec.containers' } as KnowledgeTarget,
      ]),
    /kind/,
  );
  assert.throws(
    () => canonicalTargets([{ kind: '  ' }]),
    /kind/,
  );
});

check('target 按 apiVersion/kind/path 去重并稳定排序', () => {
  assert.deepEqual(
    canonicalTargets([
      { apiVersion: 'v1', kind: 'Pod', path: 'spec.containers.image' },
      { kind: 'ConfigMap' },
      { kind: 'Pod', apiVersion: 'v1' },
      { path: 'spec.replicas', kind: 'Deployment', apiVersion: 'apps/v1' },
      { kind: 'Pod', path: 'spec.containers.image', apiVersion: 'v1' },
    ]),
    [
      { kind: 'ConfigMap' },
      { apiVersion: 'apps/v1', kind: 'Deployment', path: 'spec.replicas' },
      { apiVersion: 'v1', kind: 'Pod' },
      { apiVersion: 'v1', kind: 'Pod', path: 'spec.containers.image' },
    ],
  );
});

check('schema ID 固定包含 apiVersion、kind 与 path', () => {
  assert.equal(
    schemaChunkId({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      path: 'spec.replicas',
    }),
    'schema::apps/v1::Deployment::spec.replicas',
  );

  const base = { apiVersion: 'v1', kind: 'Pod', path: 'spec.containers.image' };
  assert.notEqual(schemaChunkId(base), schemaChunkId({ ...base, apiVersion: 'v2' }));
  assert.notEqual(schemaChunkId(base), schemaChunkId({ ...base, kind: 'Deployment' }));
  assert.notEqual(schemaChunkId(base), schemaChunkId({ ...base, path: 'spec.initContainers.image' }));
});

check('同 Kind 的不同 apiVersion 不冲突', () => {
  assert.notEqual(
    schemaChunkId({ apiVersion: 'apps/v1', kind: 'Deployment', path: 'spec.replicas' }),
    schemaChunkId({ apiVersion: 'apps/v1beta1', kind: 'Deployment', path: 'spec.replicas' }),
  );
});

check('schema ID 拒绝缺少版本、路径或含分隔符的字段', () => {
  assert.throws(
    () => schemaChunkId({ kind: 'Pod', path: 'spec.containers' }),
    /apiVersion/,
  );
  assert.throws(
    () => schemaChunkId({ apiVersion: 'v1', kind: 'Pod' }),
    /path/,
  );
  assert.throws(
    () =>
      schemaChunkId({
        apiVersion: 'v1',
        kind: 'Invalid::Kind',
        path: 'spec.containers',
      }),
    /kind/,
  );
});

check('canonical JSON/hash 不受对象键和 target 声明顺序影响', () => {
  const first = {
    metadata: { version: 'v1', providerId: 'schema.curated-openapi' },
    targets: canonicalTargets([
      { apiVersion: 'v1', kind: 'Pod', path: 'spec.containers.image' },
      { apiVersion: 'apps/v1', kind: 'Deployment', path: 'spec.replicas' },
    ]),
  };
  const second = {
    targets: canonicalTargets([
      { path: 'spec.replicas', kind: 'Deployment', apiVersion: 'apps/v1' },
      { path: 'spec.containers.image', kind: 'Pod', apiVersion: 'v1' },
    ]),
    metadata: { providerId: 'schema.curated-openapi', version: 'v1' },
  };

  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(canonicalHash(first), canonicalHash(second));
  assert.match(canonicalHash(first), /^[a-f0-9]{64}$/);
});

check('canonical JSON 拒绝会被 JSON 静默丢失或改写的输入', () => {
  assert.throws(() => canonicalJson({ value: undefined }));
  assert.throws(() => canonicalJson({ value: Number.NaN }));
  assert.throws(() => canonicalJson([, 'value']));

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalHash(cyclic));
});

check('provider 与 corpus identity 不受 chunk/provider 输入顺序影响', () => {
  const secondSchemaChunk: KnowledgeChunk = {
    ...SCHEMA_CHUNK,
    id: 'schema::v1::Pod::spec.restartPolicy',
    title: 'Pod · spec.restartPolicy',
    text: 'Pod 的字段 spec.restartPolicy:重启策略。类型 string',
    targets: [{ apiVersion: 'v1', kind: 'Pod', path: 'spec.restartPolicy' }],
  };
  const forward = schemaProvider({ chunks: [SCHEMA_CHUNK, secondSchemaChunk] });
  const reverse = schemaProvider({ chunks: [secondSchemaChunk, SCHEMA_CHUNK] });

  assert.deepEqual(buildSourceManifest(forward), buildSourceManifest(reverse));
  assert.deepEqual(
    buildCorpusIdentity([forward, policyProvider()]),
    buildCorpusIdentity([policyProvider(), reverse]),
  );
});

check('text 变化同时改变 contentHash 与 manifestHash', () => {
  const before = buildSourceManifest(schemaProvider());
  const after = buildSourceManifest(
    schemaProvider({ chunks: [{ ...SCHEMA_CHUNK, text: `${SCHEMA_CHUNK.text}。已更新` }] }),
  );

  assert.notEqual(after.contentHash, before.contentHash);
  assert.notEqual(after.manifestHash, before.manifestHash);
});

check('metadata-only 变化只改变 manifestHash', () => {
  const before = buildSourceManifest(schemaProvider());
  const after = buildSourceManifest(
    schemaProvider({
      chunks: [
        {
          ...SCHEMA_CHUNK,
          provenance: { authority: 'cluster_api', version: 'v1' },
        },
      ],
    }),
  );

  assert.equal(after.contentHash, before.contentHash);
  assert.notEqual(after.manifestHash, before.manifestHash);
});

check('generatedAt 只用于审计，不改变 provider/corpus hash', () => {
  const first = schemaProvider({ generatedAt: '2026-07-12T00:00:00.000Z' });
  const second = schemaProvider({ generatedAt: '2026-07-13T00:00:00.000Z' });
  const firstSource = buildSourceManifest(first);
  const secondSource = buildSourceManifest(second);

  assert.notEqual(firstSource.generatedAt, secondSource.generatedAt);
  assert.equal(firstSource.contentHash, secondSource.contentHash);
  assert.equal(firstSource.manifestHash, secondSource.manifestHash);
  assert.equal(
    buildCorpusIdentity([first]).manifestHash,
    buildCorpusIdentity([second]).manifestHash,
  );
});

check('provider version 只改变 manifestHash', () => {
  const before = buildSourceManifest(schemaProvider({ version: 'v1' }));
  const after = buildSourceManifest(schemaProvider({ version: 'v2' }));

  assert.equal(after.contentHash, before.contentHash);
  assert.notEqual(after.manifestHash, before.manifestHash);
});

check('provider 内与跨 provider 的重复 chunk ID 都明确失败', () => {
  assert.throws(
    () =>
      buildSourceManifest(
        schemaProvider({ chunks: [SCHEMA_CHUNK, { ...SCHEMA_CHUNK }] }),
      ),
    /duplicate.*schema::v1::Pod::spec\.containers\.image/i,
  );
  assert.throws(
    () =>
      buildCorpusIdentity([
        schemaProvider(),
        policyProvider([
          {
            ...POLICY_CHUNK,
            id: SCHEMA_CHUNK.id,
          },
        ]),
      ]),
    /duplicate.*schema::v1::Pod::spec\.containers\.image/i,
  );
});

console.log(`\n通过 ${passed} 项`);
