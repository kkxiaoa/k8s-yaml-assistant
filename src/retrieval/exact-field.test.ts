import assert from 'node:assert/strict';
import { CORPUS } from '../knowledge/corpus';
import { findExactFieldChunks } from './exact-field';

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

console.log('exact-field:');

check('Deployment image 精确路径同时返回 schema 和 policy', () => {
  const chunks = findExactFieldChunks(
    CORPUS,
    'Deployment',
    'spec.template.spec.containers.image',
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.id),
    [
      'schema::apps/v1::Deployment::spec.template.spec.containers.image',
      'policy.deployment.image.tag.no-latest',
    ],
  );
});

check('Pod privileged 精确路径同时返回 schema 和 policy', () => {
  const chunks = findExactFieldChunks(
    CORPUS,
    'Pod',
    'spec.containers.securityContext.privileged',
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.id),
    [
      'schema::v1::Pod::spec.containers.securityContext.privileged',
      'policy.pod.security.privileged.forbidden',
    ],
  );
});

check('未知 full path 不因同名 image 叶子而短路', () => {
  const chunks = findExactFieldChunks(
    CORPUS,
    'Deployment',
    'unknown.image',
  );

  assert.deepEqual(chunks, []);
});

check('exact-field 返回全部候选，由上层统一 selection/k 截断', () => {
  const target = {
    kind: 'Deployment',
    path: 'spec.replicas',
  };
  const chunks = ['first', 'second', 'third'].map((id) => ({
    id: `policy.${id}`,
    title: id,
    text: id,
    sourceType: 'policy' as const,
    provenance: { authority: 'organization' as const },
    targets: [target],
  }));

  assert.equal(
    findExactFieldChunks(chunks, 'Deployment', 'spec.replicas').length,
    3,
  );
});

check('apiVersion hint 排除同 Kind 的其他 schema 版本但保留通用 policy', () => {
  const chunks = [
    {
      id: 'schema::apps/v1::Deployment::spec.replicas',
      title: 'v1 replicas',
      text: 'v1 replicas',
      sourceType: 'schema' as const,
      provenance: { authority: 'cluster_api' as const },
      targets: [
        { apiVersion: 'apps/v1', kind: 'Deployment', path: 'spec.replicas' },
      ],
    },
    {
      id: 'schema::apps/v2::Deployment::spec.replicas',
      title: 'v2 replicas',
      text: 'v2 replicas',
      sourceType: 'schema' as const,
      provenance: { authority: 'cluster_api' as const },
      targets: [
        { apiVersion: 'apps/v2', kind: 'Deployment', path: 'spec.replicas' },
      ],
    },
    {
      id: 'policy.deployment.replicas',
      title: 'replicas policy',
      text: 'replicas policy',
      sourceType: 'policy' as const,
      provenance: { authority: 'organization' as const },
      targets: [{ kind: 'Deployment', path: 'spec.replicas' }],
    },
  ];

  assert.deepEqual(
    findExactFieldChunks(
      chunks,
      'Deployment',
      'spec.replicas',
      'apps/v1',
    ).map((chunk) => chunk.id),
    [
      'schema::apps/v1::Deployment::spec.replicas',
      'policy.deployment.replicas',
    ],
  );
});

console.log(`\n通过 ${passed} 项`);
