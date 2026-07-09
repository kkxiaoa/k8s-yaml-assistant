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
  chunkId: 'PersistentVolumeClaim::spec.volumeMode',
  fieldTerms: ['volumeMode', 'Block', 'Filesystem'],
  weakZhAliases: ['卷模式'],
  strongZhAliases: ['裸块设备'],
  source: 'llm_offline',
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
