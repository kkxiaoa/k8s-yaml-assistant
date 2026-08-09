import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeKnowledgeChunk } from './chunk';
import { loadKubernetesExamplesProviderSnapshot } from './example-corpus';

const root = join(
  process.cwd(),
  'data',
  'knowledge',
  'kubernetes-examples',
);

interface ManifestFixture {
  examples: Array<{
    id: string;
    snapshot: string;
    upstreamBlobSha1: string;
    targets: Array<{
      apiVersion?: string;
      kind: string;
      path?: string;
    }>;
  }>;
}

interface ProviderFixture {
  parent: string;
  root: string;
}

function copyFixture(): ProviderFixture {
  const parent = mkdtempSync(join(tmpdir(), 'kubernetes-examples-'));
  const fixtureRoot = join(parent, 'provider');
  cpSync(root, fixtureRoot, { recursive: true });
  return { parent, root: fixtureRoot };
}

function removeFixture(fixture: ProviderFixture): void {
  rmSync(fixture.parent, { recursive: true, force: true });
}

function readManifest(temporary: string): ManifestFixture &
  Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(temporary, 'manifest.json'), 'utf8'),
  ) as ManifestFixture & Record<string, unknown>;
}

function writeManifest(
  temporary: string,
  manifest: ManifestFixture & Record<string, unknown>,
): void {
  writeFileSync(
    join(temporary, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

test('官方示例数据提供器生成五个版本固定的完整 YAML 片段', () => {
  const snapshot = loadKubernetesExamplesProviderSnapshot();

  assert.equal(snapshot.providerId, 'example.kubernetes-official');
  assert.equal(
    snapshot.version,
    '7eae8915497224dd9ba4803a8ebd0efec33b303b',
  );
  assert.equal(snapshot.chunks.length, 5);
  assert.deepEqual(
    snapshot.chunks.map((chunk) => chunk.id),
    [
      'example::kubernetes::resource-quota-mem-cpu',
      'example::kubernetes::limit-range-mem-cpu-container',
      'example::kubernetes::configmap-immutable',
      'example::kubernetes::deployment-selector',
      'example::kubernetes::pod-image-pull-policy',
    ],
  );

  for (const chunk of snapshot.chunks) {
    assert.deepEqual(decodeKnowledgeChunk(chunk), chunk);
    assert.equal(chunk.sourceType, 'example');
    assert.equal(chunk.provenance.authority, 'kubernetes_official');
    assert.match(
      chunk.provenance.sourceUri ?? '',
      /^https:\/\/github\.com\/kubernetes\/website\/blob\/7eae8915497224dd9ba4803a8ebd0efec33b303b\/content\/zh-cn\/examples\//u,
    );
    assert.match(chunk.text, /^```yaml\napiVersion:/u);
    assert.match(chunk.text, /\nkind: /u);
    assert.match(chunk.text, /\nmetadata:\n/u);
    assert.match(chunk.text, /\n```$/u);
  }

  const resourceQuota = snapshot.chunks[0]!;
  assert.deepEqual(resourceQuota.targets, [
    { apiVersion: 'v1', kind: 'ResourceQuota', path: 'spec.hard' },
  ]);
  assert.match(resourceQuota.text, /requests\.cpu: "1"/u);
  assert.match(resourceQuota.text, /name: mem-cpu-demo/u);
});

test('官方示例数据提供器拒绝偏离固定 Git blob 的快照', () => {
  const fixture = copyFixture();
  try {
    const path = join(fixture.root, 'resource-quota-mem-cpu.yaml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}# changed\n`);
    assert.throws(
      () => loadKubernetesExamplesProviderSnapshot(fixture.root),
      /Git blob mismatch/u,
    );
  } finally {
    removeFixture(fixture);
  }
});

test('官方示例数据提供器拒绝资源身份与目标不一致', () => {
  const fixture = copyFixture();
  try {
    const manifest = readManifest(fixture.root);
    manifest.examples[0]!.targets[0]!.kind = 'LimitRange';
    writeManifest(fixture.root, manifest);
    assert.throws(
      () => loadKubernetesExamplesProviderSnapshot(fixture.root),
      /resource identity differs from targets/u,
    );
  } finally {
    removeFixture(fixture);
  }
});

test('官方示例数据提供器拒绝快照中不存在的目标路径', () => {
  const fixture = copyFixture();
  try {
    const manifest = readManifest(fixture.root);
    manifest.examples[0]!.targets[0]!.path = 'spec.missing';
    writeManifest(fixture.root, manifest);
    assert.throws(
      () => loadKubernetesExamplesProviderSnapshot(fixture.root),
      /target path missing: spec\.missing/u,
    );
  } finally {
    removeFixture(fixture);
  }
});

test('官方示例数据提供器拒绝符号链接快照', () => {
  const fixture = copyFixture();
  try {
    const manifest = readManifest(fixture.root);
    const snapshot = manifest.examples[0]!.snapshot;
    const original = join(fixture.root, snapshot);
    const actual = join(fixture.root, 'actual.yaml');
    cpSync(original, actual);
    rmSync(original);
    symlinkSync('actual.yaml', original);
    assert.throws(
      () => loadKubernetesExamplesProviderSnapshot(fixture.root),
      /must be a regular file/u,
    );
  } finally {
    removeFixture(fixture);
  }
});
