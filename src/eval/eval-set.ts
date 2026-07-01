// 检索评估标注集。Phase A:chunk id 改为 schema 驱动的 `资源::字段路径`(如 StorageClass::reclaimPolicy)。
// 仍保留大量"易混淆 query"(三种回收策略、两种访问模式、三种驱动、volumeMode vs volumeBindingMode)。

export interface EvalCase {
  question: string;
  /** 应被召回的正确 chunk id(s),对应 schema-corpus 生成的 `${resource}::${path}` */
  expectedChunkIds: string[];
  /** 该问题的目标资源类型,② 元数据过滤按此过滤 */
  resource: string;
}

export const EVAL_SET: EvalCase[] = [
  // 三种"回收策略"互相干扰
  { question: 'StorageClass 的回收策略能填哪些值?默认是什么?', expectedChunkIds: ['StorageClass::reclaimPolicy'], resource: 'StorageClass' },
  { question: 'PV 的回收策略支持哪些取值?', expectedChunkIds: ['PersistentVolume::spec.persistentVolumeReclaimPolicy'], resource: 'PersistentVolume' },

  // 两种"访问模式"互相干扰
  { question: 'PVC 的访问模式有哪些?', expectedChunkIds: ['PersistentVolumeClaim::spec.accessModes'], resource: 'PersistentVolumeClaim' },
  { question: 'PV 怎么声明访问模式?', expectedChunkIds: ['PersistentVolume::spec.accessModes'], resource: 'PersistentVolume' },

  // 驱动字段
  { question: '快照用哪个字段指定 CSI 驱动?', expectedChunkIds: ['VolumeSnapshotClass::driver'], resource: 'VolumeSnapshotClass' },
  { question: 'VolumeAttributesClass 用哪个字段指定驱动?', expectedChunkIds: ['VolumeAttributesClass::driverName'], resource: 'VolumeAttributesClass' },

  // 名字相近的坑
  { question: '怎么把卷设成裸块设备?', expectedChunkIds: ['PersistentVolumeClaim::spec.volumeMode'], resource: 'PersistentVolumeClaim' },
  { question: '怎么让卷延迟到 Pod 调度后再绑定?', expectedChunkIds: ['StorageClass::volumeBindingMode'], resource: 'StorageClass' },
  { question: 'VolumeAttributesClass 改 IOPS 用哪个字段?', expectedChunkIds: ['VolumeAttributesClass::parameters'], resource: 'VolumeAttributesClass' },

  // 常规但有对手
  { question: '怎么允许 PVC 扩容?', expectedChunkIds: ['StorageClass::allowVolumeExpansion'], resource: 'StorageClass' },
  { question: 'PVC 怎么申请存储大小?', expectedChunkIds: ['PersistentVolumeClaim::spec.resources'], resource: 'PersistentVolumeClaim' },
  { question: '怎么把 PVC 绑定到指定的 PV?', expectedChunkIds: ['PersistentVolumeClaim::spec.volumeName'], resource: 'PersistentVolumeClaim' },

  { question: 'StorageClass 必填字段是哪个?', expectedChunkIds: ['StorageClass::provisioner'], resource: 'StorageClass' },
];
