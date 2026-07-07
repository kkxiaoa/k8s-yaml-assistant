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

check('至少 10 条,每条 chunk 主键与元数据完整', () => {
  const chunks = buildPolicyCorpus();
  assert.ok(chunks.length >= 10, '至少 10 条');
  for (const c of chunks) {
    assert.ok(c.id.length > 0, `id 非空: ${JSON.stringify(c)}`);
    assert.ok(c.resource.length > 0, `resource 非空: ${c.id}`);
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
  const c = buildPolicyCorpus().find((x) => x.id === 'policy.container.image.tag.no-latest');
  assert.ok(c, '按 policy.id 作 chunk id');
  assert.equal(c.resource, 'Deployment');
  assert.equal(c.path, 'spec.template.spec.containers.image');
  assert.equal(c.title, '平台规范 · Deployment · spec.template.spec.containers.image');
  assert.match(c.text, /\[平台规范\]/);
  assert.match(c.text, /latest/);
  assert.match(c.text, /级别:forbidden/);
  assert.match(c.text, /组织策略\/平台规范,非 K8s 官方强制/);
});

console.log(`\n通过 ${passed} 项`);
