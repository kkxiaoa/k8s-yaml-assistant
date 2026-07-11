import assert from 'node:assert/strict';
import {
  CONFLICT_RULES,
  SOURCE_TYPES,
  sourceLabel,
  sourcePolicy,
  sourceTrustLevel,
} from './source-policy';

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

console.log('source policy:');

check('覆盖所有当前 sourceType', () => {
  assert.deepEqual([...SOURCE_TYPES], ['schema', 'policy', 'docs', 'example']);
  for (const sourceType of SOURCE_TYPES) {
    const policy = sourcePolicy(sourceType);
    assert.ok(policy.label.length > 0, `${sourceType} label`);
    assert.ok(policy.trustLevel.length > 0, `${sourceType} trustLevel`);
    assert.ok(policy.promptRole.length > 0, `${sourceType} promptRole`);
  }
});

check('schema 保持官方字段事实标签和 trustLevel', () => {
  assert.equal(sourceLabel('schema'), 'K8s schema');
  assert.equal(sourceTrustLevel('schema'), 'k8s-official');
});

check('policy 保持组织策略标签和 trustLevel', () => {
  assert.equal(sourceLabel('policy'), '组织策略');
  assert.equal(sourceTrustLevel('policy'), 'org-policy');
});

check('docs/example 具备 prompt 可区分的标签和 trustLevel', () => {
  assert.equal(sourceLabel('docs'), '官方文档');
  assert.equal(sourceTrustLevel('docs'), 'k8s-docs');
  assert.equal(sourceLabel('example'), '示例');
  assert.equal(sourceTrustLevel('example'), 'example');
});

check('prompt 规则覆盖 schema/policy/docs/example 且保留 policy 红线', () => {
  assert.match(CONFLICT_RULES, /\[schema\]/);
  assert.match(CONFLICT_RULES, /\[policy\]/);
  assert.match(CONFLICT_RULES, /\[docs\]/);
  assert.match(CONFLICT_RULES, /\[example\]/);
  assert.match(CONFLICT_RULES, /不得把 policy 说成 K8s 官方强制/);
});

console.log(`\n通过 ${passed} 项`);
