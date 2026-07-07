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
  | 'VolumeAttributesClass';

// 顺序即优先级:更具体的资源放前面,避免被宽泛词误吞。
// Deployment/Service/Pod 追加在 storage 规则之后,避免抢占更具体的 storage 关键词。
const RULES: Array<{ resource: ResourceType; patterns: RegExp[] }> = [
  { resource: 'VolumeSnapshotClass', patterns: [/volumesnapshotclass/i, /快照/, /snapshot/i] },
  { resource: 'VolumeAttributesClass', patterns: [/volumeattributesclass/i, /可变属性/, /\bvac\b/i] },
  { resource: 'PersistentVolumeClaim', patterns: [/persistentvolumeclaim/i, /\bpvc\b/i] },
  { resource: 'PersistentVolume', patterns: [/persistentvolume(?!claim)/i, /\bpv\b/i] },
  { resource: 'StorageClass', patterns: [/storageclass/i, /\bsc\b/i, /存储类/] },
  // 中文泛词(部署/服务)比 storage 邻居(快照/存储类)更宽,可能被"部署方式""云服务"误触发;
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
