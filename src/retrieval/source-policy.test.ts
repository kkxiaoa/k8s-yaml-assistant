import assert from 'node:assert/strict';
import {
  CONFLICT_RULES,
  SOURCE_TYPES,
  sourceAuthorityLabel,
  sourceLabel,
  sourcePolicy,
} from './source-policy';

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

console.log('source policy:');

check('每种 sourceType 只维护 label、事实域和 prompt role', () => {
  assert.deepEqual([...SOURCE_TYPES], ['schema', 'policy', 'docs', 'example']);
  for (const sourceType of SOURCE_TYPES) {
    const policy = sourcePolicy(sourceType);
    assert.deepEqual(
      Object.keys(policy).sort(),
      ['factDomain', 'label', 'promptRole'],
      sourceType,
    );
    assert.ok(policy.label.length > 0, `${sourceType} label`);
    assert.ok(policy.factDomain.length > 0, `${sourceType} factDomain`);
    assert.ok(policy.promptRole.length > 0, `${sourceType} promptRole`);
  }
});

check('source label 与 authority label 分开表达', () => {
  assert.equal(sourceLabel('schema'), 'Schema');
  assert.equal(sourceLabel('policy'), 'Policy');
  assert.equal(sourceAuthorityLabel('kubernetes_official'), 'Kubernetes 官方');
  assert.equal(sourceAuthorityLabel('cluster_api'), '当前集群 API');
  assert.equal(sourceAuthorityLabel('extension_provider'), '扩展提供方');
  assert.equal(sourceAuthorityLabel('organization'), '组织');
  assert.equal(sourceAuthorityLabel('curated'), '人工精选');
});

check('prompt 规则以一条边界覆盖 authority 与 schema/policy 冲突', () => {
  assert.match(CONFLICT_RULES, /当前集群 API/);
  assert.match(CONFLICT_RULES, /扩展提供方/);
  assert.match(CONFLICT_RULES, /不得.*Kubernetes 官方/);
  assert.match(CONFLICT_RULES, /每层结论都要有对应来源/);
  assert.match(CONFLICT_RULES, /未检索到组织规范/);
  assert.match(CONFLICT_RULES, /组织策略\/平台规范/);
  assert.doesNotMatch(CONFLICT_RULES, /nginx:latest/);
});

console.log(`\n通过 ${passed} 项`);
