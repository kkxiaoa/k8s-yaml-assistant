// A3:schema alias query expansion 单测。纯函数,无需网络/key。
// 运行: npm test

import assert from 'node:assert/strict';
import {
  expandQueryWithAliases,
  type SchemaFieldAlias,
} from './query-expansion';

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

function alias(
  partial: Partial<SchemaFieldAlias> & Pick<SchemaFieldAlias, 'id'>,
): SchemaFieldAlias {
  return {
    resource: 'Deployment',
    path: 'spec.template.spec.containers.image',
    chunkId: 'Deployment::spec.template.spec.containers.image',
    fieldTerms: ['image', 'container image'],
    zhAliases: ['镜像', '容器镜像'],
    source: 'llm_offline',
    reviewed: true,
    reviewedAt: '2026-07-08',
    reviewNote: '',
    ...partial,
  };
}

console.log('query-expansion:');

check('未 reviewed alias 不参与', () => {
  const result = expandQueryWithAliases('Deployment 镜像怎么写', 'Deployment', [
    alias({ id: 'image', reviewed: false }),
  ]);

  assert.equal(result.expandedQueryText, result.originalQueryText);
  assert.deepEqual(result.matchedAliases, []);
  assert.deepEqual(result.expansionTerms, []);
});

check('resource 不匹配不参与', () => {
  const result = expandQueryWithAliases('Deployment 镜像怎么写', 'Pod', [
    alias({ id: 'image' }),
  ]);

  assert.equal(result.expandedQueryText, result.originalQueryText);
  assert.deepEqual(result.matchedAliases, []);
  assert.deepEqual(result.expansionTerms, []);
});

check('query 命中中文 alias 后追加 field terms + path', () => {
  const result = expandQueryWithAliases(
    'Deployment 容器镜像怎么写',
    'Deployment',
    [alias({ id: 'image' })],
  );

  assert.match(result.expandedQueryText, /字段术语:/);
  assert.deepEqual(result.expansionTerms, [
    'image',
    'container image',
    'spec.template.spec.containers.image',
  ]);
  assert.deepEqual(result.matchedAliases, [
    {
      chunkId: 'Deployment::spec.template.spec.containers.image',
      resource: 'Deployment',
      path: 'spec.template.spec.containers.image',
      zhAlias: '容器镜像',
    },
  ]);
});

check('topN 限制生效', () => {
  const result = expandQueryWithAliases(
    '镜像 资源 卷',
    'Deployment',
    [
      alias({
        id: 'image',
        zhAliases: ['镜像'],
        fieldTerms: ['image', 'container image'],
      }),
      alias({
        id: 'resources',
        path: 'spec.template.spec.containers.resources.requests',
        chunkId: 'Deployment::spec.template.spec.containers.resources.requests',
        zhAliases: ['资源'],
        fieldTerms: ['resources', 'requests'],
      }),
      alias({
        id: 'volumes',
        path: 'spec.template.spec.volumes',
        chunkId: 'Deployment::spec.template.spec.volumes',
        zhAliases: ['卷'],
        fieldTerms: ['volumes'],
      }),
    ],
    { maxFields: 2, maxTermsPerField: 2 },
  );

  assert.deepEqual(
    result.matchedAliases.map((hit) => hit.chunkId),
    [
      'Deployment::spec.template.spec.containers.image',
      'Deployment::spec.template.spec.containers.resources.requests',
    ],
  );
  assert.deepEqual(result.expansionTerms, [
    'image',
    'container image',
    'resources',
    'requests',
  ]);
});

check('无 routedResource 时不扩展', () => {
  const result = expandQueryWithAliases('镜像怎么写', undefined, [
    alias({ id: 'image' }),
  ]);

  assert.equal(result.expandedQueryText, result.originalQueryText);
  assert.deepEqual(result.matchedAliases, []);
  assert.deepEqual(result.expansionTerms, []);
});

check('无命中时 expandedQueryText === originalQueryText', () => {
  const result = expandQueryWithAliases('副本数怎么写', 'Deployment', [
    alias({ id: 'image' }),
  ]);

  assert.equal(result.expandedQueryText, result.originalQueryText);
  assert.deepEqual(result.matchedAliases, []);
  assert.deepEqual(result.expansionTerms, []);
});

console.log(`\n通过 ${passed} 项`);
