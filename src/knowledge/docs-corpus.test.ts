import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { loadKubernetesDocsProviderSnapshot } from './docs-corpus';

const root = join(
  process.cwd(),
  'data',
  'knowledge',
  'kubernetes-docs',
);

interface ManifestFixture {
  documents: Array<{
    snapshot: string;
    upstreamBlobSha1: string;
    sourceUri: string;
    sections: Array<{
      heading: string;
      anchor: string;
    }>;
  }>;
}

function readManifestFixture(): ManifestFixture & Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(root, 'manifest.json'), 'utf8'),
  ) as ManifestFixture & Record<string, unknown>;
}

function gitBlobSha1(markdown: string): string {
  const content = Buffer.from(markdown);
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex');
}

function withMarkdownFixture(
  markdown: string,
  configure: (manifest: ManifestFixture) => void,
  run: (temporary: string) => void,
): void {
  const temporary = mkdtempSync(join(tmpdir(), 'kubernetes-docs-'));
  try {
    const manifest = readManifestFixture();
    const [document] = manifest.documents;
    assert.ok(document);
    manifest.documents = [document];
    document.upstreamBlobSha1 = gitBlobSha1(markdown);
    configure(manifest);
    writeFileSync(
      join(temporary, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    writeFileSync(join(temporary, document.snapshot), markdown);
    run(temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test('官方文档数据提供器只生成清单选中的简体中文章节', () => {
  const snapshot = loadKubernetesDocsProviderSnapshot();

  assert.equal(snapshot.providerId, 'docs.kubernetes-official');
  assert.equal(
    snapshot.version,
    '7eae8915497224dd9ba4803a8ebd0efec33b303b',
  );
  assert.equal(snapshot.chunks.length, 5);

  const chunk = snapshot.chunks[0]!;
  assert.deepEqual(decodeKnowledgeChunk(chunk), chunk);
  assert.equal(
    chunk.id,
    'docs::kubernetes::resource-quotas::compute-resource-quota',
  );
  assert.equal(chunk.sourceType, 'docs');
  assert.equal(
    chunk.title,
    'ResourceQuota · spec.hard · 基础设施资源配额',
  );
  assert.deepEqual(chunk.provenance, {
    authority: 'kubernetes_official',
    sourceUri:
      'https://kubernetes.io/zh-cn/docs/concepts/policy/resource-quotas/#compute-resource-quota',
    version: '7eae8915497224dd9ba4803a8ebd0efec33b303b',
  });
  assert.deepEqual(chunk.targets, [
    { apiVersion: 'v1', kind: 'ResourceQuota', path: 'spec.hard' },
  ]);
  assert.match(chunk.text, /`requests\.cpu`/u);
  assert.match(chunk.text, /`limits\.memory`/u);
  assert.match(chunk.text, /配额机制所支持的资源类型/u);
  assert.match(chunk.text, /CPU 需求总量不能超过该值/u);
  assert.match(
    chunk.text,
    /https:\/\/kubernetes\.io\/zh-cn\/docs\/concepts\/configuration\/manage-resources-containers\//u,
  );
  assert.doesNotMatch(chunk.text, /\]\(\/zh-cn\/docs\//u);
  assert.doesNotMatch(chunk.text, /\n{3,}/u);
  assert.doesNotMatch(chunk.text, /The following resource types/u);
  assert.doesNotMatch(chunk.text, /<!--|-->/u);
  assert.doesNotMatch(chunk.text, /apiVersion: v1|kind: ResourceQuota/u);
  assert.doesNotMatch(chunk.text, /扩展资源的配额/u);

  const chunksById = new Map(
    snapshot.chunks.map((candidate) => [candidate.id, candidate] as const),
  );
  const limitRange = chunksById.get(
    'docs::kubernetes::limit-range::constraints-on-resource-limits-and-requests',
  );
  const configMap = chunksById.get(
    'docs::kubernetes::configmap::configmap-immutable',
  );
  const deployment = chunksById.get(
    'docs::kubernetes::deployment::selector',
  );
  const images = chunksById.get(
    'docs::kubernetes::images::image-pull-policy',
  );
  assert.ok(limitRange);
  assert.ok(configMap);
  assert.ok(deployment);
  assert.ok(images);
  assert.match(limitRange.text, /设置默认请求值与限制值/u);
  assert.match(configMap.text, /将 `immutable` 字段设置为 `true`/u);
  assert.match(
    deployment.text,
    /`\.spec\.selector` 必须匹配 `\.spec\.template\.metadata\.labels`/u,
  );
  assert.match(images.text, /`IfNotPresent`/u);
  assert.match(images.text, /默认镜像拉取策略/u);
  assert.doesNotMatch(configMap.text, /\{\{< feature-state/u);
  assert.doesNotMatch(deployment.text, /\{\{< \/?note/u);
  assert.doesNotMatch(images.text, /\{\{< \/?note/u);
});

test('官方文档数据提供器拒绝偏离固定 Git blob 的快照', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'kubernetes-docs-'));
  try {
    cpSync(join(root, 'manifest.json'), join(temporary, 'manifest.json'));
    const source = readFileSync(join(root, 'resource-quotas.md'), 'utf8');
    writeFileSync(join(temporary, 'resource-quotas.md'), `${source}\n已修改\n`);

    assert.throws(
      () => loadKubernetesDocsProviderSnapshot(temporary),
      /Git blob mismatch/u,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('官方文档数据提供器拒绝非规范官方页面地址', () => {
  const source = readFileSync(join(root, 'resource-quotas.md'), 'utf8');
  for (const sourceUri of [
    'https://example.com/zh-cn/docs/concepts/policy/resource-quotas/',
    'https://user@kubernetes.io/zh-cn/docs/concepts/policy/resource-quotas/',
    'https://kubernetes.io/zh-cn/docs/concepts/policy/resource-quotas/?view=old',
    'https://kubernetes.io/zh-cn/docs/concepts/policy/resource-quotas/#existing',
  ]) {
    withMarkdownFixture(
      source,
      (manifest) => {
        manifest.documents[0]!.sourceUri = sourceUri;
      },
      (temporary) => {
        assert.throws(
          () => loadKubernetesDocsProviderSnapshot(temporary),
          /canonical Kubernetes simplified Chinese docs page/u,
        );
      },
    );
  }
});

test('官方文档数据提供器在清单标题偏离快照时失败', () => {
  const source = readFileSync(join(root, 'resource-quotas.md'), 'utf8');
  withMarkdownFixture(
    source,
    (manifest) => {
      manifest.documents[0]!.sections[0]!.heading = '不存在的标题';
    },
    (temporary) => {
      assert.throws(
        () => loadKubernetesDocsProviderSnapshot(temporary),
        /expected one heading.*found 0/u,
      );
    },
  );
});

test('官方文档数据提供器忽略代码围栏内的伪标题并停在下一同级章节', () => {
  const markdown = [
    '## 目标章节 {#target-section}',
    '',
    '保留的正文。',
    '',
    '```markdown',
    '```not-a-closing-fence',
    '## 围栏内的伪标题 {#next-section}',
    '```',
    '',
    '仍属于目标章节。',
    '',
    '## 下一章节 {#next-section}',
    '',
    '不得进入目标 chunk。',
  ].join('\n');

  withMarkdownFixture(
    markdown,
    (manifest) => {
      const section = manifest.documents[0]!.sections[0]!;
      section.heading = '目标章节';
      section.anchor = 'target-section';
    },
    (temporary) => {
      const [chunk] = loadKubernetesDocsProviderSnapshot(temporary).chunks;
      assert.ok(chunk);
      assert.match(chunk.text, /围栏内的伪标题/u);
      assert.match(chunk.text, /仍属于目标章节/u);
      assert.doesNotMatch(chunk.text, /不得进入目标 chunk/u);
    },
  );
});

test('官方文档数据提供器拒绝符号链接快照', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'kubernetes-docs-'));
  try {
    const manifest = readManifestFixture();
    const [document] = manifest.documents;
    assert.ok(document);
    const source = readFileSync(join(root, document.snapshot));
    writeFileSync(join(temporary, 'actual.md'), source);
    symlinkSync('actual.md', join(temporary, document.snapshot));
    writeFileSync(
      join(temporary, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    assert.throws(
      () => loadKubernetesDocsProviderSnapshot(temporary),
      /must be a regular file/u,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
