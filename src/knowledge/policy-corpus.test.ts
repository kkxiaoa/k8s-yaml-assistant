// Stage 6:buildPolicyCorpus(policies.json → policy chunk)单测。纯函数,无需网络/key。
// 运行: npm test

import assert from 'node:assert/strict';
import { buildPolicyCorpus } from './policy-corpus';

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

console.log('buildPolicyCorpus:');

check('至少 42 条,每条 chunk 主键与元数据完整', () => {
  const chunks = buildPolicyCorpus();
  assert.ok(chunks.length >= 42, '至少 42 条');
  for (const c of chunks) {
    assert.ok(c.id.length > 0, `id 非空: ${JSON.stringify(c)}`);
    assert.ok(c.resource?.length, `resource 非空: ${c.id}`);
    assert.deepEqual(c.resources, [c.resource], `resources 稳定: ${c.id}`);
    assert.ok(c.appliesTo && !Array.isArray(c.appliesTo), `appliesTo 为对象: ${c.id}`);
    assert.equal(c.appliesTo.resource, c.resource, `appliesTo.resource 稳定: ${c.id}`);
    assert.ok(c.title.length > 0, `title 非空: ${c.id}`);
    assert.ok(c.text.length > 0, `text 非空: ${c.id}`);
    assert.equal(c.sourceType, 'policy', `sourceType=policy: ${c.id}`);
    assert.equal(c.trustLevel, 'org-policy', `trustLevel=org-policy: ${c.id}`);
  }
});

check('chunk id 唯一(主键无重复)', () => {
  const ids = buildPolicyCorpus().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'id 应互不重复');
});

check('id/title/元数据稳定(image no-latest 样本)', () => {
  const c = buildPolicyCorpus().find((x) => x.id === 'policy.deployment.image.tag.no-latest');
  assert.ok(c, '按 policy.id 作 chunk id');
  assert.equal(c.resource, 'Deployment');
  assert.equal(c.path, 'spec.template.spec.containers.image');
  assert.deepEqual(c.resources, ['Deployment']);
  assert.deepEqual(c.paths, ['spec.template.spec.containers.image']);
  assert.deepEqual(c.appliesTo, {
    resource: 'Deployment',
    field: 'spec.template.spec.containers.image',
  });
  assert.equal(c.title, '平台规范 · Deployment · spec.template.spec.containers.image');
  assert.match(c.text, /\[平台规范\]/);
  assert.match(c.text, /latest/);
  assert.match(c.text, /级别:forbidden/);
  assert.match(c.text, /组织策略\/平台规范,非 K8s 官方强制/);
});

// 多域抽查:确认 Stage 6 扩容后新域(storage/network/rbac)的 chunk 字段与文本片段稳定,
// 不只验证单一(deployment)样本。
check('storage 域样本(PVC 必须指定 storageClassName)', () => {
  const c = buildPolicyCorpus().find((x) => x.id === 'policy.pvc.storageClassName.required');
  assert.ok(c, '按 policy.id 作 chunk id');
  assert.equal(c.resource, 'PersistentVolumeClaim');
  assert.equal(c.path, 'spec.storageClassName');
  assert.equal(c.title, '平台规范 · PersistentVolumeClaim · spec.storageClassName');
  assert.equal(c.sourceType, 'policy');
  assert.equal(c.trustLevel, 'org-policy');
  assert.match(c.text, /storageClassName/);
  assert.match(c.text, /级别:required/);
});

check('network 域样本(Service 禁止 NodePort)', () => {
  const c = buildPolicyCorpus().find((x) => x.id === 'policy.service.type.nodeport.forbidden');
  assert.ok(c, '按 policy.id 作 chunk id');
  assert.equal(c.resource, 'Service');
  assert.equal(c.path, 'spec.type');
  assert.equal(c.title, '平台规范 · Service · spec.type');
  assert.equal(c.sourceType, 'policy');
  assert.equal(c.trustLevel, 'org-policy');
  assert.match(c.text, /NodePort/);
  assert.match(c.text, /级别:forbidden/);
});

check('rbac 域样本(ClusterRoleBinding 禁止授予 cluster-admin)', () => {
  const c = buildPolicyCorpus().find(
    (x) => x.id === 'policy.clusterrolebinding.no-cluster-admin.forbidden',
  );
  assert.ok(c, '按 policy.id 作 chunk id');
  assert.equal(c.resource, 'ClusterRoleBinding');
  assert.equal(c.path, 'roleRef');
  assert.equal(c.title, '平台规范 · ClusterRoleBinding · roleRef');
  assert.equal(c.sourceType, 'policy');
  assert.equal(c.trustLevel, 'org-policy');
  assert.match(c.text, /cluster-admin/);
  assert.match(c.text, /级别:forbidden/);
});

console.log(`\n通过 ${passed} 项`);
