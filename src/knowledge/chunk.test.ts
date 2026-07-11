import assert from 'node:assert/strict';
import {
  chunkPaths,
  chunkResources,
  primaryPath,
  primaryResource,
  type Chunk,
} from './chunk';

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

console.log('chunk helpers:');

check('schema chunk 兼容 resource/path', () => {
  const chunk: Chunk = {
    id: 'Deployment::spec.replicas',
    resource: 'Deployment',
    path: 'spec.replicas',
    title: 'Deployment · spec.replicas',
    text: 'replicas',
    sourceType: 'schema',
  };

  assert.deepEqual(chunkResources(chunk), ['Deployment']);
  assert.deepEqual(chunkPaths(chunk), ['spec.replicas']);
  assert.equal(primaryResource(chunk), 'Deployment');
  assert.equal(primaryPath(chunk), 'spec.replicas');
});

check('policy chunk 可从 appliesTo 推导资源和字段', () => {
  const chunk: Chunk = {
    id: 'policy.deployment.image.tag.no-latest',
    title: '平台规范 · Deployment · spec.template.spec.containers.image',
    text: '禁止 latest tag',
    sourceType: 'policy',
    appliesTo: {
      resource: 'Deployment',
      field: 'spec.template.spec.containers.image',
    },
  };

  assert.deepEqual(chunkResources(chunk), ['Deployment']);
  assert.deepEqual(chunkPaths(chunk), ['spec.template.spec.containers.image']);
});

check('docs/example 可以没有单一字段路径', () => {
  const chunk: Chunk = {
    id: 'docs.networkpolicy.concept',
    title: 'NetworkPolicy 概念',
    text: 'NetworkPolicy controls traffic.',
    sourceType: 'docs',
    resources: ['NetworkPolicy'],
  };

  assert.deepEqual(chunkResources(chunk), ['NetworkPolicy']);
  assert.deepEqual(chunkPaths(chunk), []);
  assert.equal(primaryPath(chunk), undefined);
});

console.log(`\n通过 ${passed} 项`);
