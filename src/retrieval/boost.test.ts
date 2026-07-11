// Stage 6:policyBoost 单测。纯函数,无需网络/key。
// 运行: npm test

import assert from 'node:assert/strict';
import type { Chunk } from '../knowledge/corpus';
import { policyBoost } from './boost';
import { POLICY_RELATED_BOOST } from './router';

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

const policyChunk: Chunk = {
  id: 'policy.deployment.spec.replicas.example',
  resource: 'Deployment',
  path: 'spec.replicas',
  title: '平台规范 · Deployment · spec.replicas',
  text: '[平台规范] 示例规则。级别:required。适用:prod。理由:测试用。(组织策略/平台规范,非 K8s 官方强制)',
  sourceType: 'policy',
};

// 资源级 policy(buildPolicyCorpus 在 appliesTo.field 缺失时 emit path='')。
const resourceLevelPolicyChunk: Chunk = {
  id: 'policy.pod.security.privileged.forbidden',
  resource: 'Pod',
  path: '',
  title: '平台规范 · Pod · (资源级)',
  text: '[平台规范] 禁止特权容器。(组织策略/平台规范,非 K8s 官方强制)',
  sourceType: 'policy',
};

const appliesToOnlyPolicyChunk: Chunk = {
  id: 'policy.deployment.image.tag.no-latest',
  title: '平台规范 · Deployment · spec.template.spec.containers.image',
  text: '[平台规范] 禁止 latest tag。(组织策略/平台规范,非 K8s 官方强制)',
  sourceType: 'policy',
  appliesTo: {
    resource: 'Deployment',
    field: 'spec.template.spec.containers.image',
  },
};

const schemaChunk: Chunk = {
  id: 'schema.deployment.spec.replicas',
  resource: 'Deployment',
  path: 'spec.replicas',
  title: 'Deployment · spec.replicas',
  text: 'spec.replicas: integer',
  sourceType: 'schema',
};

console.log('policyBoost:');

check('policy + resource 匹配 → 加权(无需 path)', () => {
  assert.equal(policyBoost(policyChunk, 'Deployment', undefined), POLICY_RELATED_BOOST);
});

check('policy + resource 匹配 + path 匹配 → 叠加增强', () => {
  // boostPath 约定已归一化(小写),故传小写。
  const boosted = policyBoost(policyChunk, 'Deployment', 'spec.replicas');
  assert.ok(boosted > POLICY_RELATED_BOOST);
});

check('policy 可从 appliesTo 推导 resource/path 加权', () => {
  const boosted = policyBoost(
    appliesToOnlyPolicyChunk,
    'Deployment',
    'spec.template.spec.containers.image',
  );
  assert.ok(boosted > POLICY_RELATED_BOOST);
});

check('policy + resource 不匹配 → 0', () => {
  assert.equal(policyBoost(policyChunk, 'Service', undefined), 0);
});

check('schema chunk → 0', () => {
  assert.equal(policyBoost(schemaChunk, 'Deployment', undefined), 0);
});

check('无 boostResource → 0', () => {
  assert.equal(policyBoost(policyChunk, undefined, undefined), 0);
});

check('资源级 policy(path 空)+ 非空 boostPath → 只加基础 boost', () => {
  // 空 path 对任何非空 boostPath 的 endsWith 为 false → 不叠加 bonus,安全退化。
  assert.equal(
    policyBoost(resourceLevelPolicyChunk, 'Pod', 'spec.hostnetwork'),
    POLICY_RELATED_BOOST,
  );
});

console.log(`\n通过 ${passed} 项`);
