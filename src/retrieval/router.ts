// 查询路由:根据问题里的关键词,推断它问的是哪种资源(用于 ② 元数据过滤)。
// 关键词命中 → 返回资源类型;都不命中 → 返回 null(安全退化:不过滤,走全量检索)。
//
// 已知局限(会被 eval 测出来):当问题"表面提到的资源" ≠ "答案所在资源"时会误判。
//   例:"怎么允许 PVC 扩容?" 表面是 PVC,但 allowVolumeExpansion 其实是 StorageClass 的字段。
//   关键词路由会误路由到 PVC → 把正确 chunk 过滤掉。这正是要靠 eval 量化、再决定怎么缓解的点。

// 软加权幅度:命中路由资源的 chunk,余弦相似度上加这么多分(不删除其它资源)。
// 这是个旋钮:太大 → 接近硬过滤(误路由会把正确答案挤掉);太小 → 路由几乎不起作用。
// 用 npm run eval 调:让 ③ auto 尽量接近 ② oracle,同时不低于 ① 无过滤。
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
  // 但只喂 +0.04/+0.05 软 boost(非硬过滤),误路由不删候选,影响低,故容忍。
  { resource: 'Deployment', patterns: [/deployment/i, /部署/, /\bdeploy\b/i] },
  { resource: 'Service', patterns: [/\bservice\b/i, /服务/] },
  { resource: 'Pod', patterns: [/\bpod\b/i, /容器组/] },
];

/** 推断查询的目标资源;不确定时返回 null(不过滤)。 */
export function inferResource(query: string): ResourceType | null {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(query))) return rule.resource;
  }
  return null;
}
