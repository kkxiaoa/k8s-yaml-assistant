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
    3,
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.id),
    [
      'Deployment::spec.template.spec.containers.image',
      'policy.deployment.image.tag.no-latest',
    ],
  );
});

check('Pod privileged 精确路径同时返回 schema 和 policy', () => {
  const chunks = findExactFieldChunks(
    CORPUS,
    'Pod',
    'spec.containers.securityContext.privileged',
    3,
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.id),
    [
      'Pod::spec.containers.securityContext.privileged',
      'policy.pod.security.privileged.forbidden',
    ],
  );
});

check('未知 full path 不因同名 image 叶子而短路', () => {
  const chunks = findExactFieldChunks(
    CORPUS,
    'Deployment',
    'unknown.image',
    3,
  );

  assert.deepEqual(chunks, []);
});

console.log(`\n通过 ${passed} 项`);
