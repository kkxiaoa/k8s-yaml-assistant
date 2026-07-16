import assert from 'node:assert/strict';
import {
  chunkPaths,
  chunkResources,
  decodeKnowledgeChunk,
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
  } catch (error) {
    console.error(
      `  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

const schemaChunk: Chunk = {
  id: 'schema::apps/v1::Deployment::spec.replicas',
  title: 'Deployment · spec.replicas',
  text: 'replicas',
  sourceType: 'schema',
  provenance: {
    authority: 'cluster_api',
    version: 'v1',
  },
  targets: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      path: 'spec.replicas',
    },
  ],
};

console.log('canonical chunk:');

check('runtime decoder 接受完整 canonical contract', () => {
  assert.deepEqual(decodeKnowledgeChunk(schemaChunk), schemaChunk);
});

check('runtime decoder 拒绝缺少 provenance 或 targets', () => {
  const { provenance: _provenance, ...withoutProvenance } = schemaChunk;
  const { targets: _targets, ...withoutTargets } = schemaChunk;
  assert.throws(() => decodeKnowledgeChunk(withoutProvenance));
  assert.throws(() => decodeKnowledgeChunk(withoutTargets));
});

check('runtime decoder 拒绝旧定位与 trust 字段', () => {
  for (const field of [
    'resource',
    'path',
    'resources',
    'paths',
    'appliesTo',
    'sourceUri',
    'version',
    'trustLevel',
  ]) {
    assert.throws(
      () => decodeKnowledgeChunk({ ...schemaChunk, [field]: 'legacy' }),
      field,
    );
  }
});

check('资源与字段视图只从 targets 派生并去重', () => {
  const chunk: Chunk = {
    id: 'docs.workload.resources',
    title: 'Workload resources',
    text: 'Workload fields.',
    sourceType: 'docs',
    provenance: { authority: 'curated' },
    targets: [
      { apiVersion: 'v1', kind: 'Pod', path: 'spec.containers' },
      { apiVersion: 'v1', kind: 'Pod', path: 'spec.initContainers' },
      { apiVersion: 'apps/v1', kind: 'Deployment', path: 'spec.template.spec.containers' },
      { apiVersion: 'v1', kind: 'Pod', path: 'spec.containers' },
    ],
  };

  assert.deepEqual(chunkResources(chunk), ['Pod', 'Deployment']);
  assert.deepEqual(chunkPaths(chunk), [
    'spec.containers',
    'spec.initContainers',
    'spec.template.spec.containers',
  ]);
  assert.equal(primaryResource(chunk), 'Pod');
  assert.equal(primaryPath(chunk), 'spec.containers');
});

check('无 target 的通用知识没有伪造资源或字段', () => {
  const chunk: Chunk = {
    id: 'docs.generic',
    title: 'Generic docs',
    text: 'Generic knowledge.',
    sourceType: 'docs',
    provenance: { authority: 'curated' },
    targets: [],
  };
  assert.deepEqual(chunkResources(chunk), []);
  assert.deepEqual(chunkPaths(chunk), []);
  assert.equal(primaryResource(chunk), undefined);
  assert.equal(primaryPath(chunk), undefined);
});

console.log(`\n通过 ${passed} 项`);
