// Stage 6:context 里的来源标签(schema/policy 分层),供生成 prompt 区分表达。
// 运行: npx tsx src/retrieval/sources.test.ts

import assert from 'node:assert/strict';
import { extractSourceUri, formatSources, type SourceInput } from './sources';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

const policy: SourceInput = {
  id: 'policy-1',
  title: '禁止使用 latest tag',
  text: '生产环境镜像禁止使用 latest tag。',
  sourceType: 'policy',
};

const schema: SourceInput = {
  id: 'schema-1',
  title: 'Container.image',
  text: 'image 字段是字符串类型。',
  sourceType: 'schema',
};

const docs: SourceInput = {
  id: 'docs-1',
  title: 'NetworkPolicy concepts',
  text: 'NetworkPolicy controls traffic.',
  sourceType: 'docs',
  resources: ['NetworkPolicy'],
};

const example: SourceInput = {
  id: 'example-1',
  title: 'Deployment example',
  text: 'apiVersion: apps/v1',
  sourceType: 'example',
  resources: ['Deployment'],
};

console.log('formatSources:');

check('policy 来源带 [S1][policy][组织策略]', () => {
  const { context } = formatSources([policy, schema]);
  assert.ok(context.includes('[S1][policy][组织策略]'), context);
});

check('schema 来源带 [S2][schema][K8s schema]', () => {
  const { context } = formatSources([policy, schema]);
  assert.ok(context.includes('[S2][schema][K8s schema]'), context);
});

check('schema-only:label 逻辑不假设混合输入', () => {
  const { context } = formatSources([schema]);
  assert.ok(context.includes('[S1][schema][K8s schema]'), context);
});

check('docs/example 来源标签可区分', () => {
  const { context } = formatSources([docs, example]);
  assert.ok(context.includes('[S1][docs][官方文档]'), context);
  assert.ok(context.includes('[S2][example][示例]'), context);
});

check('sources 元数据包含 resources/paths 与默认 trustLevel', () => {
  const { sources } = formatSources([schema, docs]);
  assert.equal(sources[0]!.trustLevel, 'k8s-official');
  assert.deepEqual(sources[1]!.resources, ['NetworkPolicy']);
  assert.deepEqual(sources[1]!.paths, []);
  assert.equal(sources[1]!.resource, 'NetworkPolicy');
  assert.equal(sources[1]!.path, undefined);
  assert.equal(sources[1]!.trustLevel, 'k8s-docs');
});

check('空数组 → context 空串、sources 空', () => {
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

check('无 More info → undefined', () => {
  assert.equal(extractSourceUri('image 字段是字符串类型。'), undefined);
});

console.log(`\n通过 ${passed} 项`);
