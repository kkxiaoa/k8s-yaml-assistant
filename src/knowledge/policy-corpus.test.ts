import assert from 'node:assert/strict';
import { buildPolicyCorpus } from './policy-corpus';

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

console.log('buildPolicyCorpus:');

check('每条 policy 使用稳定业务 ID 与 canonical metadata', () => {
  const chunks = buildPolicyCorpus();
  assert.ok(chunks.length >= 42, '至少 42 条');
  assert.equal(new Set(chunks.map((chunk) => chunk.id)).size, chunks.length);

  for (const chunk of chunks) {
    assert.ok(chunk.id.startsWith('policy.'), chunk.id);
    assert.equal(chunk.sourceType, 'policy', chunk.id);
    assert.equal(chunk.provenance.authority, 'organization', chunk.id);
    assert.ok(chunk.targets.length > 0, chunk.id);
    assert.equal('resource' in chunk, false, chunk.id);
    assert.equal('path' in chunk, false, chunk.id);
    assert.equal('appliesTo' in chunk, false, chunk.id);
    assert.equal('trustLevel' in chunk, false, chunk.id);
  }
});

check('字段级 policy 从输入 appliesTo 生成一个 canonical target', () => {
  const chunk = buildPolicyCorpus().find(
    (candidate) =>
      candidate.id === 'policy.deployment.image.tag.no-latest',
  );
  assert.ok(chunk);
  assert.deepEqual(chunk.targets, [
    {
      kind: 'Deployment',
      path: 'spec.template.spec.containers.image',
    },
  ]);
  assert.equal(
    chunk.title,
    '平台规范 · Deployment · spec.template.spec.containers.image',
  );
  assert.match(chunk.text, /组织策略\/平台规范,非 K8s 官方强制/);
});

check('资源级 policy 不伪造空 path', () => {
  const chunk = buildPolicyCorpus().find(
    (candidate) =>
      candidate.id === 'policy.networkpolicy.default-deny.recommended',
  );
  assert.ok(chunk);
  const target = chunk.targets[0]!;
  assert.equal(target.kind, 'NetworkPolicy');
  assert.equal(
    Object.hasOwn(target, 'path') ? target.path : undefined,
    undefined,
  );
});

check('storage/network/rbac 样本保持领域文本和 target', () => {
  const cases = [
    ['policy.pvc.storageClassName.required', 'PersistentVolumeClaim', 'spec.storageClassName'],
    ['policy.service.type.nodeport.forbidden', 'Service', 'spec.type'],
    ['policy.clusterrolebinding.no-cluster-admin.forbidden', 'ClusterRoleBinding', 'roleRef'],
  ] as const;

  const chunks = buildPolicyCorpus();
  for (const [id, kind, path] of cases) {
    const chunk = chunks.find((candidate) => candidate.id === id);
    assert.ok(chunk, id);
    assert.deepEqual(chunk.targets, [{ kind, path }], id);
    assert.match(chunk.text, /级别:(?:required|forbidden)/, id);
  }
});

console.log(`\n通过 ${passed} 项`);
