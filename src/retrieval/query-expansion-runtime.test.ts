import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAliasRegistrySnapshot,
  prepareQueryExpansion,
  resolveQueryExpansionEnabled,
  skippedExactQueryExpansionTrace,
} from './query-expansion-runtime';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(
      `  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exitCode = 1;
  }
}

const reviewedAlias = {
  id: 'pvc-volume-mode',
  resource: 'PersistentVolumeClaim',
  path: 'spec.volumeMode',
  chunkId: 'schema::v1::PersistentVolumeClaim::spec.volumeMode',
  fieldTerms: ['volumeMode', 'Block', 'Filesystem'],
  weakZhAliases: ['卷模式'],
  strongZhAliases: ['裸块设备'],
  source: 'llm_offline' as const,
  reviewed: true,
  reviewedAt: '2026-07-08',
  reviewNote: '',
};

console.log('query-expansion-runtime:');

check('feature flag 默认开启且显式参数优先', () => {
  assert.equal(resolveQueryExpansionEnabled(undefined, undefined), true);
  assert.equal(resolveQueryExpansionEnabled(undefined, 'false'), false);
  assert.equal(resolveQueryExpansionEnabled(true, 'false'), true);
  assert.equal(resolveQueryExpansionEnabled(false, undefined), false);
  assert.equal(resolveQueryExpansionEnabled(undefined), true);
});

check('registry 缺失和非法 JSON 返回可诊断错误', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alias-runtime-'));
  try {
    assert.deepEqual(loadAliasRegistrySnapshot(join(dir, 'missing.jsonl')), {
      ok: false,
      errorCode: 'aliases_missing',
    });

    const invalidPath = join(dir, 'invalid.jsonl');
    writeFileSync(invalidPath, '{bad json}\n');
    assert.deepEqual(loadAliasRegistrySnapshot(invalidPath), {
      ok: false,
      errorCode: 'aliases_invalid',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('registry 只加载 reviewed alias 并生成稳定 hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alias-runtime-'));
  try {
    const path = join(dir, 'aliases.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify(reviewedAlias),
        JSON.stringify({
          ...reviewedAlias,
          id: 'unreviewed',
          reviewed: false,
          reviewedAt: null,
        }),
      ].join('\n') + '\n',
    );

    const result = loadAliasRegistrySnapshot(path);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.snapshot.reviewedAliasCount, 1);
    assert.equal(result.snapshot.aliases[0]?.id, reviewedAlias.id);
    assert.match(result.snapshot.registryHash, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('strong alias 可扩展 query 并选择跨语言字段资源', () => {
  const raw = `${JSON.stringify(reviewedAlias)}\n`;
  const dir = mkdtempSync(join(tmpdir(), 'alias-runtime-'));
  try {
    const path = join(dir, 'aliases.jsonl');
    writeFileSync(path, raw);
    const registry = loadAliasRegistrySnapshot(path);
    const result = prepareQueryExpansion(
      '怎么把卷设成裸块设备?',
      undefined,
      true,
      registry,
    );

    assert.equal(result.trace.status, 'applied');
    assert.equal(result.boostResource, 'PersistentVolumeClaim');
    assert.equal(result.boostPath, 'spec.volumeMode');
    assert.equal(result.trace.selectedResource, 'PersistentVolumeClaim');
    assert.equal(result.trace.resourceSelectionReason, 'no_route_strong_alias');
    assert.match(result.queryText, /volumeMode/);
    assert.deepEqual(result.trace.expansionTerms, [
      'volumeMode',
      'Block',
      'Filesystem',
      'spec.volumeMode',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('唯一跨资源强 alias 同时更新检索与重排的结构化目标', () => {
  const registry = {
    ok: true as const,
    snapshot: {
      aliases: [
        {
          ...reviewedAlias,
          id: 'sc-volume-binding-mode',
          resource: 'StorageClass',
          path: 'volumeBindingMode',
          chunkId:
            'schema::storage.k8s.io/v1::StorageClass::volumeBindingMode',
          fieldTerms: ['volumeBindingMode', 'WaitForFirstConsumer'],
          weakZhAliases: [],
          strongZhAliases: ['Pod 调度后再绑定'],
        },
      ],
      registryHash: 'b'.repeat(64),
      reviewedAliasCount: 1,
    },
  };
  const result = prepareQueryExpansion(
    [
      '怎么让卷延迟到 Pod 调度后再绑定?',
      '资源:Pod',
      'apiVersion:v1',
      '字段:spec.volumes',
    ].join('\n'),
    'Pod',
    true,
    registry,
    (selectedResource) =>
      [
        '怎么让卷延迟到 Pod 调度后再绑定?',
        `资源:${selectedResource}`,
      ].join('\n'),
  );

  assert.equal(result.boostResource, 'StorageClass');
  assert.equal(result.boostPath, 'volumeBindingMode');
  assert.equal(result.trace.routedResource, 'Pod');
  assert.equal(result.trace.selectedResource, 'StorageClass');
  assert.equal(
    result.trace.resourceSelectionReason,
    'cross_resource_strong_alias',
  );
  assert.match(result.queryText, /资源:StorageClass/u);
  assert.match(result.rerankQueryText, /资源:StorageClass/u);
  assert.doesNotMatch(
    `${result.queryText}\n${result.rerankQueryText}`,
    /资源:Pod|apiVersion:v1|字段:spec\.volumes/u,
  );
});

check('跨资源 strong alias 有歧义时不改写原查询', () => {
  const registry = {
    ok: true as const,
    snapshot: {
      aliases: [
        {
          ...reviewedAlias,
          id: 'sc-volume-binding-mode',
          resource: 'StorageClass',
          path: 'volumeBindingMode',
          chunkId:
            'schema::storage.k8s.io/v1::StorageClass::volumeBindingMode',
          weakZhAliases: [],
          strongZhAliases: ['Pod 调度后再绑定'],
        },
        {
          ...reviewedAlias,
          id: 'pvc-volume-name',
          resource: 'PersistentVolumeClaim',
          path: 'spec.volumeName',
          chunkId: 'schema::v1::PersistentVolumeClaim::spec.volumeName',
          weakZhAliases: [],
          strongZhAliases: ['Pod 调度后再绑定'],
        },
      ],
      registryHash: 'c'.repeat(64),
      reviewedAliasCount: 2,
    },
  };
  const queryText = [
    'Pod 调度后再绑定怎么配置?',
    '资源:Pod',
    'apiVersion:v1',
  ].join('\n');
  let retargetCalls = 0;
  const result = prepareQueryExpansion(
    queryText,
    'Pod',
    true,
    registry,
    () => {
      retargetCalls += 1;
      return '不应生成';
    },
  );

  assert.equal(result.boostResource, 'Pod');
  assert.equal(result.boostPath, undefined);
  assert.equal(result.rerankQueryText, queryText);
  assert.equal(retargetCalls, 0);
  assert.equal(
    result.trace.resourceSelectionReason,
    'ambiguous_cross_resource_strong_alias',
  );
});

check('多个 alias 命中时不推断单一 boost path', () => {
  const registry = {
    ok: true as const,
    snapshot: {
      aliases: [
        {
          ...reviewedAlias,
          id: 'endpoints-addresses',
          resource: 'Endpoints',
          path: 'subsets.addresses',
          chunkId: 'schema::v1::Endpoints::subsets.addresses',
          strongZhAliases: ['后端地址和端口'],
        },
        {
          ...reviewedAlias,
          id: 'endpoints-ports',
          resource: 'Endpoints',
          path: 'subsets.ports',
          chunkId: 'schema::v1::Endpoints::subsets.ports',
          strongZhAliases: ['后端地址和端口'],
        },
      ],
      registryHash: 'a'.repeat(64),
      reviewedAliasCount: 2,
    },
  };
  const result = prepareQueryExpansion(
    '后端地址和端口怎么写?',
    undefined,
    true,
    registry,
  );

  assert.equal(result.boostResource, 'Endpoints');
  assert.equal(result.boostPath, undefined);
  assert.equal(result.trace.matchedAliases.length, 2);
});

check('关闭或 registry 失败时保留原 query 和 routed resource', () => {
  const disabled = prepareQueryExpansion(
    'Deployment 镜像怎么写',
    'Deployment',
    false,
  );
  assert.equal(disabled.trace.status, 'disabled');
  assert.equal(disabled.queryText, 'Deployment 镜像怎么写');
  assert.equal(disabled.boostResource, 'Deployment');

  const failed = prepareQueryExpansion(
    'Deployment 镜像怎么写',
    'Deployment',
    true,
    { ok: false, errorCode: 'aliases_missing' },
  );
  assert.equal(failed.trace.status, 'failed');
  assert.equal(failed.trace.errorCode, 'aliases_missing');
  assert.equal(failed.queryText, 'Deployment 镜像怎么写');
  assert.equal(failed.boostResource, 'Deployment');
});

check('exact path 记录 skipped_exact 且不加载 registry', () => {
  const trace = skippedExactQueryExpansionTrace(
    '解释当前字段\n资源:Deployment\n字段:spec.replicas',
    'Deployment',
    true,
  );

  assert.equal(trace.status, 'skipped_exact');
  assert.equal(trace.enabled, true);
  assert.equal(trace.originalQueryText, trace.expandedQueryText);
  assert.equal(trace.selectedResource, 'Deployment');
  assert.deepEqual(trace.matchedAliases, []);
  assert.deepEqual(trace.expansionTerms, []);
  assert.equal(trace.registryHash, undefined);
});

console.log(`\n通过 ${passed} 项`);
