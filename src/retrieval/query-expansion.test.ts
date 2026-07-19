// A3:schema alias query expansion 单测。纯函数,无需网络/key。
// 运行: npm test

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_ALIAS_DRAFT_DIR,
  DEFAULT_ALIASES_PATH,
  expandQueryWithAliases,
  mergeReviewedAliasDraft,
  parseSchemaFieldAliasesJsonl,
  writeSchemaFieldAliasDraft,
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
    chunkId: 'schema::apps/v1::Deployment::spec.template.spec.containers.image',
    fieldTerms: ['image', 'container image'],
    weakZhAliases: ['镜像', '容器镜像'],
    strongZhAliases: [],
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
      chunkId: 'schema::apps/v1::Deployment::spec.template.spec.containers.image',
      resource: 'Deployment',
      path: 'spec.template.spec.containers.image',
      zhAlias: '容器镜像',
      strength: 'weak',
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
        weakZhAliases: ['镜像'],
        fieldTerms: ['image', 'container image'],
      }),
      alias({
        id: 'resources',
        path: 'spec.template.spec.containers.resources.requests',
        chunkId: 'schema::apps/v1::Deployment::spec.template.spec.containers.resources.requests',
        weakZhAliases: ['资源'],
        fieldTerms: ['resources', 'requests'],
      }),
      alias({
        id: 'volumes',
        path: 'spec.template.spec.volumes',
        chunkId: 'schema::apps/v1::Deployment::spec.template.spec.volumes',
        weakZhAliases: ['卷'],
        fieldTerms: ['volumes'],
      }),
    ],
    { maxFields: 2, maxTermsPerField: 2 },
  );

  assert.deepEqual(
    result.matchedAliases.map((hit) => hit.chunkId),
    [
      'schema::apps/v1::Deployment::spec.template.spec.containers.image',
      'schema::apps/v1::Deployment::spec.template.spec.containers.resources.requests',
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

check('alias-aware:无 routedResource 时可由 alias 选中资源字段', () => {
  const result = expandQueryWithAliases(
    '怎么把卷设成裸块设备?',
    undefined,
    [
      alias({
        id: 'volume-mode',
        resource: 'PersistentVolumeClaim',
        path: 'spec.volumeMode',
        chunkId: 'schema::v1::PersistentVolumeClaim::spec.volumeMode',
        weakZhAliases: ['卷模式'],
        strongZhAliases: ['裸块设备'],
        fieldTerms: ['volumeMode', 'Block'],
      }),
    ],
    { resourceStrategy: 'alias-aware' },
  );

  assert.deepEqual(result.matchedAliases, [
    {
      chunkId: 'schema::v1::PersistentVolumeClaim::spec.volumeMode',
      resource: 'PersistentVolumeClaim',
      path: 'spec.volumeMode',
      zhAlias: '裸块设备',
      strength: 'strong',
    },
  ]);
  assert.equal(result.aliasSelectedResource, 'PersistentVolumeClaim');
  assert.equal(result.resourceSelectionReason, 'no_route_strong_alias');
  assert.deepEqual(result.expansionTerms, ['volumeMode', 'Block', 'spec.volumeMode']);
});

check('alias-aware: routedResource 错误时仍可由 alias 选中正确资源', () => {
  const result = expandQueryWithAliases(
    '怎么让卷延迟到 Pod 调度后再绑定?',
    'Pod',
    [
      alias({
        id: 'binding-mode',
        resource: 'StorageClass',
        path: 'volumeBindingMode',
        chunkId: 'schema::storage.k8s.io/v1::StorageClass::volumeBindingMode',
        weakZhAliases: ['延迟绑定'],
        strongZhAliases: ['Pod 调度后再绑定'],
        fieldTerms: ['volumeBindingMode', 'WaitForFirstConsumer'],
      }),
    ],
    { resourceStrategy: 'alias-aware' },
  );

  assert.deepEqual(result.matchedAliases, [
    {
      chunkId: 'schema::storage.k8s.io/v1::StorageClass::volumeBindingMode',
      resource: 'StorageClass',
      path: 'volumeBindingMode',
      zhAlias: 'Pod 调度后再绑定',
      strength: 'strong',
    },
  ]);
  assert.equal(result.aliasSelectedResource, 'StorageClass');
  assert.equal(result.resourceSelectionReason, 'cross_resource_strong_alias');
  assert.deepEqual(result.expansionTerms, [
    'volumeBindingMode',
    'WaitForFirstConsumer',
  ]);
});

check('same resource: weak alias 允许 expansion 但不改变 resource', () => {
  const result = expandQueryWithAliases('Deployment 容器镜像怎么写', 'Deployment', [
    alias({ id: 'image' }),
  ]);

  assert.equal(result.aliasSelectedResource, 'Deployment');
  assert.equal(result.resourceSelectionReason, 'same_resource');
  assert.deepEqual(result.expansionTerms, [
    'image',
    'container image',
    'spec.template.spec.containers.image',
  ]);
});

check('wrong resource: weak alias 完全不扩展', () => {
  const result = expandQueryWithAliases(
    'Pod 容器怎么暴露端口号?',
    'Pod',
    [
      alias({
        id: 'endpoint-ports',
        resource: 'Endpoints',
        path: 'subsets.ports',
        chunkId: 'schema::v1::Endpoints::subsets.ports',
        fieldTerms: ['ports', 'subsets.ports'],
        weakZhAliases: ['端口号'],
        strongZhAliases: ['后端地址和端口'],
      }),
    ],
    { resourceStrategy: 'alias-aware' },
  );

  assert.equal(result.expandedQueryText, result.originalQueryText);
  assert.equal(result.aliasSelectedResource, 'Pod');
  assert.equal(result.resourceSelectionReason, 'no_alias_match');
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

check('生成草稿独占新文件且不修改正式 registry', () => {
  assert.notEqual(DEFAULT_ALIAS_DRAFT_DIR, dirname(DEFAULT_ALIASES_PATH));
  const root = mkdtempSync(join(tmpdir(), 'alias-draft-'));
  const registryPath = join(root, 'schema-field-aliases.jsonl');
  const draftDir = join(root, 'drafts');
  const createdAt = new Date('2026-07-17T08:09:10.123Z');
  const draft = alias({
    id: 'image-draft',
    reviewed: false,
    reviewedAt: null,
  });
  writeFileSync(registryPath, 'reviewed registry\n');

  try {
    assert.throws(
      () =>
        writeSchemaFieldAliasDraft([alias({ id: 'reviewed-draft' })], {
          directory: draftDir,
          createdAt,
        }),
      /必须保持 reviewed=false/,
    );
    const draftPath = writeSchemaFieldAliasDraft([draft], {
      directory: draftDir,
      createdAt,
    });

    assert.equal(dirname(draftPath), draftDir);
    assert.deepEqual(
      parseSchemaFieldAliasesJsonl(readFileSync(draftPath, 'utf8')),
      [draft],
    );
    assert.equal(readFileSync(registryPath, 'utf8'), 'reviewed registry\n');
    assert.throws(
      () =>
        writeSchemaFieldAliasDraft([draft], {
          directory: draftDir,
          createdAt,
        }),
      /EEXIST/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('人工审核草稿按 id 合并且保留未覆盖的正式 alias', () => {
  const existing = alias({ id: 'image', fieldTerms: ['old image'] });
  const preserved = alias({ id: 'preserved', path: 'spec.replicas' });
  const reviewedUpdate = alias({
    id: 'image',
    fieldTerms: ['image', 'container image'],
    reviewedAt: '2026-07-17',
  });
  const reviewedAddition = alias({
    id: 'new-alias',
    path: 'spec.template.spec.containers.resources',
    chunkId: 'schema::apps/v1::Deployment::spec.template.spec.containers.resources',
    reviewedAt: '2026-07-17',
  });

  const result = mergeReviewedAliasDraft(
    [existing, preserved],
    [reviewedUpdate, reviewedAddition],
  );

  assert.deepEqual(result.addedIds, ['new-alias']);
  assert.deepEqual(result.updatedIds, ['image']);
  assert.deepEqual(result.unchangedIds, []);
  assert.deepEqual(
    result.aliases.map((item) => item.id),
    ['image', 'preserved', 'new-alias'],
  );
  assert.deepEqual(result.aliases[0], reviewedUpdate);
  assert.deepEqual(result.aliases[1], preserved);
});

check('未审核草稿和既有 alias 身份漂移不能进入正式 registry', () => {
  const existing = alias({ id: 'image' });

  assert.throws(
    () =>
      mergeReviewedAliasDraft(
        [existing],
        [alias({ id: 'image', reviewed: false, reviewedAt: null })],
      ),
    /尚未完成人工审核/,
  );
  assert.throws(
    () =>
      mergeReviewedAliasDraft(
        [existing],
        [alias({ id: 'image', resource: 'Pod', reviewedAt: '2026-07-17' })],
      ),
    /身份与正式 registry 不一致/,
  );
});

console.log(`\n通过 ${passed} 项`);
