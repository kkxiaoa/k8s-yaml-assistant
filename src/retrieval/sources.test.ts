import assert from 'node:assert/strict';
import { extractSourceUri, formatSources, type SourceInput } from './sources';

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

const policy: SourceInput = {
  id: 'policy-1',
  title: '禁止使用 latest tag',
  text: '生产环境镜像禁止使用 latest tag。',
  sourceType: 'policy',
  provenance: { authority: 'organization' },
  targets: [
    { kind: 'Deployment', path: 'spec.template.spec.containers.image' },
  ],
};

const officialSchema: SourceInput = {
  id: 'schema::v1::Pod::spec.containers.image',
  title: 'Container.image',
  text: 'image 字段是字符串类型。',
  sourceType: 'schema',
  provenance: { authority: 'kubernetes_official' },
  targets: [
    { apiVersion: 'v1', kind: 'Pod', path: 'spec.containers.image' },
  ],
};

const clusterSchema: SourceInput = {
  ...officialSchema,
  id: 'schema::example.io/v1::Widget::spec.image',
  provenance: { authority: 'cluster_api' },
  targets: [
    { apiVersion: 'example.io/v1', kind: 'Widget', path: 'spec.image' },
  ],
};

const docs: SourceInput = {
  id: 'docs-1',
  title: 'NetworkPolicy concepts',
  text: 'NetworkPolicy controls traffic. More info: https://k8s.io/network-policy',
  sourceType: 'docs',
  provenance: { authority: 'kubernetes_official' },
  targets: [{ kind: 'NetworkPolicy' }],
};

console.log('formatSources:');

check('context 同时标记知识形态和 authority', () => {
  const { context } = formatSources([policy, officialSchema, clusterSchema]);
  assert.ok(context.includes('[S1][policy][Policy][组织]'), context);
  assert.ok(context.includes('[S2][schema][Schema][Kubernetes 官方]'), context);
  assert.ok(context.includes('[S3][schema][Schema][当前集群 API]'), context);
});

check('sources 只输出 canonical targets/provenance', () => {
  const { sources } = formatSources([clusterSchema, docs]);
  assert.deepEqual(sources[0]!.targets, clusterSchema.targets);
  assert.deepEqual(sources[0]!.provenance, clusterSchema.provenance);
  assert.equal('resource' in sources[0]!, false);
  assert.equal('path' in sources[0]!, false);
  assert.equal('trustLevel' in sources[0]!, false);
  assert.deepEqual(sources[1]!.provenance, {
    authority: 'kubernetes_official',
    sourceUri: 'https://k8s.io/network-policy',
  });
});

check('空数组返回空 context 与 sources', () => {
  const { context, sources } = formatSources([]);
  assert.equal(context, '');
  assert.deepEqual(sources, []);
});

console.log('\nextractSourceUri:');

check('命中 More info URL', () => {
  assert.equal(
    extractSourceUri('desc More info: https://k8s.io/x'),
    'https://k8s.io/x',
  );
});

check('剥离 URL 尾部误吞的英文标点', () => {
  assert.equal(
    extractSourceUri('More info: https://k8s.io/docs/images.'),
    'https://k8s.io/docs/images',
  );
});

check('无 More info 返回 undefined', () => {
  assert.equal(extractSourceUri('image 字段是字符串类型。'), undefined);
});

console.log(`\n通过 ${passed} 项`);
