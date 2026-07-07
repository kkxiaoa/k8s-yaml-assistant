// Stage 6:inferResource(关键词软路由)单测。纯函数,无需网络/key。
// RULES 顺序即优先级,冲突对(ClusterRole* vs Role*、CronJob vs Job、ServiceAccount vs Service、
// *Pod* vs Pod)只靠数组顺序解决——这里把那些顺序依赖钉成断言,防 future 重排/插入 silently 破坏路由。
// 运行: npm test

import assert from 'node:assert/strict';
import { inferResource, type ResourceType } from './router';
import { buildPolicyCorpus } from '../knowledge/policy-corpus';

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

console.log('inferResource:');

// 24 类各一条 canonical 关键词 query → 期望 resource。
const CANONICAL: Array<[string, ResourceType]> = [
  ['Deployment 怎么设置滚动更新', 'Deployment'],
  ['Pod 一直 CrashLoopBackOff 怎么排查', 'Pod'],
  ['Service 的 selector 怎么写', 'Service'],
  ['StatefulSet 和 Deployment 区别', 'StatefulSet'],
  ['DaemonSet 怎么保证每节点一个副本', 'DaemonSet'],
  ['Job 的 backoffLimit 怎么配', 'Job'],
  ['CronJob 并发策略', 'CronJob'],
  ['PersistentVolumeClaim 怎么申请存储', 'PersistentVolumeClaim'],
  ['PersistentVolume 的回收策略', 'PersistentVolume'],
  ['StorageClass 怎么设置默认', 'StorageClass'],
  ['VolumeSnapshotClass 怎么配置', 'VolumeSnapshotClass'],
  ['VolumeAttributesClass 可变属性怎么用', 'VolumeAttributesClass'],
  ['Ingress 怎么配置 TLS', 'Ingress'],
  ['NetworkPolicy 怎么限制出站', 'NetworkPolicy'],
  ['ConfigMap 怎么挂载成文件', 'ConfigMap'],
  ['Secret 怎么加密存储', 'Secret'],
  ['ServiceAccount 的 token 怎么用', 'ServiceAccount'],
  ['Role 怎么定义权限', 'Role'],
  ['RoleBinding 怎么绑定用户', 'RoleBinding'],
  ['ClusterRole 怎么定义集群级权限', 'ClusterRole'],
  ['ClusterRoleBinding 怎么配', 'ClusterRoleBinding'],
  ['HorizontalPodAutoscaler 扩缩容阈值', 'HorizontalPodAutoscaler'],
  ['PodDisruptionBudget 最小可用副本', 'PodDisruptionBudget'],
  ['ResourceQuota 限制命名空间总量', 'ResourceQuota'],
  ['LimitRange 默认 request/limit', 'LimitRange'],
];

check('24 类 canonical query 各自路由正确', () => {
  for (const [query, expected] of CANONICAL) {
    assert.equal(inferResource(query), expected, `query="${query}"`);
  }
});

// 冲突对:更具体/更长的 kind 必须先命中,不能落到会包含它的短 kind。
const CONFLICTS: Array<[string, ResourceType]> = [
  // ClusterRoleBinding 含 rolebinding/role 子串,不能落到 RoleBinding/Role/ClusterRole。
  ['clusterrolebinding 怎么配', 'ClusterRoleBinding'],
  ['集群角色绑定怎么配', 'ClusterRoleBinding'],
  // ClusterRole 含 role 子串,不能落到 Role。
  ['clusterrole 怎么定义', 'ClusterRole'],
  ['集群角色权限', 'ClusterRole'],
  // RoleBinding 含 role 子串,不能落到 Role。
  ['rolebinding 怎么绑定', 'RoleBinding'],
  ['角色绑定怎么写', 'RoleBinding'],
  // CronJob 含 job 子串,不能落到 Job。
  ['cronjob 并发', 'CronJob'],
  ['定时任务怎么配', 'CronJob'],
  // ServiceAccount 含 service 子串,不能落到 Service。
  ['serviceaccount token', 'ServiceAccount'],
  ['服务账户怎么配', 'ServiceAccount'],
  // *Pod* 含 pod 子串,不能落到 Pod。
  ['poddisruptionbudget minAvailable', 'PodDisruptionBudget'],
  ['pdb 怎么配', 'PodDisruptionBudget'],
  ['horizontalpodautoscaler 阈值', 'HorizontalPodAutoscaler'],
  ['hpa 怎么配置', 'HorizontalPodAutoscaler'],
];

check('冲突对:具体 kind 先命中,不被短 kind 抢', () => {
  for (const [query, expected] of CONFLICTS) {
    assert.equal(inferResource(query), expected, `query="${query}"`);
  }
});

// 新增 RBAC/workload 规则插在 storage 规则之后,不得回抢既有 storage 路由。
const STORAGE_REGRESSION: Array<[string, ResourceType]> = [
  ['pvc 怎么扩容', 'PersistentVolumeClaim'],
  ['storageclass 怎么设置 allowVolumeExpansion', 'StorageClass'],
  ['volumesnapshotclass 快照怎么配置', 'VolumeSnapshotClass'],
  ['pv 的 accessModes 有哪些', 'PersistentVolume'],
];

check('storage query 不被新规则抢走', () => {
  for (const [query, expected] of STORAGE_REGRESSION) {
    assert.equal(inferResource(query), expected, `query="${query}"`);
  }
});

check('无关键词 → null(安全退化不过滤)', () => {
  assert.equal(inferResource('今天天气怎么样'), null);
});

// 守卫:policy chunk 的 resource 必须都能被 inferResource 认出(policy resource ⊆ router 识别集)。
// 否则 future policy 用了 RULES 没注册的 resource,boost.ts 靠 chunk.resource === boostResource
// 会 silently 不加权、路由也永不命中它——用 canonical kind 名反查,红在这里而非线上静默失效。
check('policy resource ⊆ router 可识别集', () => {
  const resources = [...new Set(buildPolicyCorpus().map((c) => c.resource))];
  for (const r of resources) {
    // 用 kind 名本身当 query:能路由回同名 resource 即证明 RULES 覆盖了它。
    assert.equal(inferResource(r), r, `policy resource 未被 router 识别: ${r}`);
  }
});

console.log(`\n通过 ${passed} 项`);
