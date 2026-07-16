// 按问题关键词推断目标资源,作为全量 dense retrieval 的软加权提示。
// 问题中提到的资源可能不是答案字段所属资源,因此路由不得删除候选 chunk。

// 软加权幅度:命中路由资源的 chunk,余弦相似度上加这么多分(不删除其它资源)。
// 过大会放大误路由的排名影响,过小则无法提供有效提示。
export const RESOURCE_BOOST = 0.05;

// policy chunk 与路由资源匹配时的加权(见 ./boost.ts:policyBoost)。
export const POLICY_RELATED_BOOST = 0.04;

export type ResourceType =
  | 'Deployment'
  | 'Pod'
  | 'Service'
  | 'StorageClass'
  | 'PersistentVolume'
  | 'PersistentVolumeClaim'
  | 'VolumeSnapshotClass'
  | 'VolumeAttributesClass'
  | 'StatefulSet'
  | 'DaemonSet'
  | 'Job'
  | 'CronJob'
  | 'Ingress'
  | 'NetworkPolicy'
  | 'ConfigMap'
  | 'Secret'
  | 'ServiceAccount'
  | 'Role'
  | 'RoleBinding'
  | 'ClusterRole'
  | 'ClusterRoleBinding'
  | 'HorizontalPodAutoscaler'
  | 'PodDisruptionBudget'
  | 'ResourceQuota'
  | 'LimitRange';

// 顺序即优先级:更具体的资源放前面,避免被宽泛词误吞。
// Deployment/Service/Pod 追加在 storage 规则之后,避免抢占更具体的 storage 关键词。
const RULES: Array<{ resource: ResourceType; patterns: RegExp[] }> = [
  { resource: 'VolumeSnapshotClass', patterns: [/volumesnapshotclass/i, /快照/, /snapshot/i] },
  { resource: 'VolumeAttributesClass', patterns: [/volumeattributesclass/i, /可变属性/, /\bvac\b/i] },
  { resource: 'PersistentVolumeClaim', patterns: [/persistentvolumeclaim/i, /\bpvc\b/i] },
  { resource: 'PersistentVolume', patterns: [/persistentvolume(?!claim)/i, /\bpv\b/i] },
  { resource: 'StorageClass', patterns: [/storageclass/i, /\bsc\b/i, /存储类/] },
  // RBAC:线性扫描先匹配先返回,Cluster* 排在同名非 Cluster 前缀词之前即可保证优先命中
  // ——"clusterrolebinding" 会先撞见本规则,不会漏到后面的 RoleBinding/Role。
  // (英文侧 /\brole\b/ 靠词界本就不会误吞 clusterrole;真正靠顺序拦截的是中文 /角色/ 的 substring 命中。)
  { resource: 'ClusterRoleBinding', patterns: [/clusterrolebinding/i, /集群角色绑定/] },
  { resource: 'ClusterRole', patterns: [/clusterrole/i, /集群角色/] },
  { resource: 'RoleBinding', patterns: [/rolebinding/i, /角色绑定/] },
  { resource: 'Role', patterns: [/\brole\b/i, /角色/] },
  { resource: 'ServiceAccount', patterns: [/serviceaccount/i, /\bsa\b/i, /服务账[户号]/] },
  // CronJob 排在 Job 之前,同理靠顺序拦截,不需要额外的负向断言。
  { resource: 'CronJob', patterns: [/cronjob/i, /定时任务/] },
  { resource: 'Job', patterns: [/\bjob\b/i, /任务/] },
  { resource: 'StatefulSet', patterns: [/statefulset/i, /有状态/] },
  { resource: 'DaemonSet', patterns: [/daemonset/i, /守护进程集?/] },
  { resource: 'Ingress', patterns: [/ingress/i, /入口/] },
  { resource: 'NetworkPolicy', patterns: [/networkpolicy/i, /网络策略/] },
  { resource: 'ConfigMap', patterns: [/configmap/i, /配置项|配置字典/] },
  { resource: 'Secret', patterns: [/\bsecret\b/i, /密钥|凭据/] },
  // PodDisruptionBudget / HorizontalPodAutoscaler 含 "pod" 子串,须排在 Pod 规则前,
  // 避免被 /\bpod\b/ 提前吞掉(即使 \b 词界通常不匹配,仍按具体在前的原则稳妥处理)。
  { resource: 'PodDisruptionBudget', patterns: [/poddisruptionbudget/i, /\bpdb\b/i, /中断预算/] },
  { resource: 'HorizontalPodAutoscaler', patterns: [/horizontalpodautoscaler/i, /\bhpa\b/i, /水平自动扩缩容/] },
  { resource: 'ResourceQuota', patterns: [/resourcequota/i, /资源配额/] },
  { resource: 'LimitRange', patterns: [/limitrange/i, /限制范围/] },
  // 中文泛词(部署/服务/任务/角色/密钥/入口/配置项/限制范围)比邻居更宽,
  // 可能被"部署方式""云服务""入口大厅"等误触发;
  // 宽泛中文词可能误触发,因此只作为软 boost,不删除其他候选。
  { resource: 'Deployment', patterns: [/deployment/i, /部署/, /\bdeploy\b/i] },
  { resource: 'Service', patterns: [/\bservice\b/i, /服务/] },
  { resource: 'Pod', patterns: [/\bpod\b/i, /容器组/] },
];

/** 推断查询的目标资源;不确定时返回 null,不提供资源加权提示。 */
export function inferResource(query: string): ResourceType | null {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(query))) return rule.resource;
  }
  return null;
}
