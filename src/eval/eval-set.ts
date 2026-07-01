// 检索评估标注集(人工核心集)。chunk id = schema 驱动的 `${resource}::${path}`。
// 设计原则:覆盖收敛后语料(26 资源,工作负载主导),并大量埋「易混淆硬负例」——
// 同名/近义字段散落在不同资源(restartPolicy、updateStrategy、maxUnavailable、selector、type、replicas…),
// 逼检索区分资源+字段,而不是命中泛化关键词。校验用 `npm run eval:check`(expectedChunkIds 必须真实存在)。

export interface EvalCase {
  question: string;
  /** 应被召回的正确 chunk id(s),对应 schema-corpus 生成的 `${resource}::${path}` */
  expectedChunkIds: string[];
  /** 该问题的目标资源类型,② 元数据过滤 / auto 路由按此对齐 */
  resource: string;
}

export const EVAL_SET: EvalCase[] = [
  // ── Pod:容器与调度 ──────────────────────────────
  { question: 'Pod 里怎么指定容器镜像?', expectedChunkIds: ['Pod::spec.containers.image'], resource: 'Pod' },
  { question: 'Pod 容器怎么设置 CPU/内存上限?', expectedChunkIds: ['Pod::spec.containers.resources.limits'], resource: 'Pod' },
  { question: 'Pod 的存活探针用 HTTP 检查哪个路径?', expectedChunkIds: ['Pod::spec.containers.livenessProbe.httpGet.path'], resource: 'Pod' },
  { question: 'Pod 重启策略能填哪些值?', expectedChunkIds: ['Pod::spec.restartPolicy'], resource: 'Pod' },
  { question: 'Pod 镜像拉取策略怎么配?', expectedChunkIds: ['Pod::spec.containers.imagePullPolicy'], resource: 'Pod' },
  { question: '怎么把 Pod 调度到带特定标签的节点?', expectedChunkIds: ['Pod::spec.nodeSelector'], resource: 'Pod' },
  { question: 'Pod 怎么容忍节点污点?', expectedChunkIds: ['Pod::spec.tolerations'], resource: 'Pod' },
  { question: 'Pod 怎么以非 root 用户运行?', expectedChunkIds: ['Pod::spec.securityContext.runAsNonRoot'], resource: 'Pod' },
  { question: 'Pod 用哪个字段挂载卷来源?', expectedChunkIds: ['Pod::spec.volumes'], resource: 'Pod' },
  { question: 'Pod 怎么指定使用的 ServiceAccount?', expectedChunkIds: ['Pod::spec.serviceAccountName'], resource: 'Pod' },
  { question: 'Pod 容器怎么暴露端口号?', expectedChunkIds: ['Pod::spec.containers.ports.containerPort'], resource: 'Pod' },
  { question: 'Pod 怎么给容器注入环境变量?', expectedChunkIds: ['Pod::spec.containers.env'], resource: 'Pod' },

  // ── Deployment:副本与滚动更新 ───────────────────
  { question: 'Deployment 怎么设置副本数?', expectedChunkIds: ['Deployment::spec.replicas'], resource: 'Deployment' },
  { question: 'Deployment 的更新策略有哪些类型?', expectedChunkIds: ['Deployment::spec.strategy.type'], resource: 'Deployment' },
  { question: 'Deployment 滚动更新时最多几个不可用?', expectedChunkIds: ['Deployment::spec.strategy.rollingUpdate.maxUnavailable'], resource: 'Deployment' },
  { question: 'Deployment 怎么选中它管理的 Pod?', expectedChunkIds: ['Deployment::spec.selector'], resource: 'Deployment' },
  { question: 'Deployment 里容器镜像写在哪个路径?', expectedChunkIds: ['Deployment::spec.template.spec.containers.image'], resource: 'Deployment' },
  { question: 'Deployment 保留多少个历史版本?', expectedChunkIds: ['Deployment::spec.revisionHistoryLimit'], resource: 'Deployment' },

  // ── StatefulSet:与 Deployment 的差异点 ──────────
  { question: 'StatefulSet 用哪个字段关联 headless service?', expectedChunkIds: ['StatefulSet::spec.serviceName'], resource: 'StatefulSet' },
  { question: 'StatefulSet 怎么给每个副本申请独立存储?', expectedChunkIds: ['StatefulSet::spec.volumeClaimTemplates'], resource: 'StatefulSet' },
  { question: 'StatefulSet 的 Pod 是顺序还是并行启动?', expectedChunkIds: ['StatefulSet::spec.podManagementPolicy'], resource: 'StatefulSet' },
  { question: 'StatefulSet 的更新策略字段是哪个?', expectedChunkIds: ['StatefulSet::spec.updateStrategy.type'], resource: 'StatefulSet' },

  // ── DaemonSet ───────────────────────────────────
  { question: 'DaemonSet 的更新策略有哪些类型?', expectedChunkIds: ['DaemonSet::spec.updateStrategy.type'], resource: 'DaemonSet' },

  // ── Job / CronJob ───────────────────────────────
  { question: 'Job 怎么设置需要完成的次数?', expectedChunkIds: ['Job::spec.completions'], resource: 'Job' },
  { question: 'Job 怎么设置并行度?', expectedChunkIds: ['Job::spec.parallelism'], resource: 'Job' },
  { question: 'Job 失败重试次数上限怎么配?', expectedChunkIds: ['Job::spec.backoffLimit'], resource: 'Job' },
  { question: 'Job 完成后多久自动清理?', expectedChunkIds: ['Job::spec.ttlSecondsAfterFinished'], resource: 'Job' },
  { question: 'CronJob 的定时表达式写在哪个字段?', expectedChunkIds: ['CronJob::spec.schedule'], resource: 'CronJob' },
  { question: 'CronJob 并发策略能填哪些值?', expectedChunkIds: ['CronJob::spec.concurrencyPolicy'], resource: 'CronJob' },
  { question: 'CronJob 怎么暂停调度?', expectedChunkIds: ['CronJob::spec.suspend'], resource: 'CronJob' },
  { question: 'CronJob 保留多少条成功历史?', expectedChunkIds: ['CronJob::spec.successfulJobsHistoryLimit'], resource: 'CronJob' },

  // ── Service:类型与端口 ─────────────────────────
  { question: 'Service 有哪些类型?', expectedChunkIds: ['Service::spec.type'], resource: 'Service' },
  { question: 'Service 怎么把端口转发到 Pod 的目标端口?', expectedChunkIds: ['Service::spec.ports.targetPort'], resource: 'Service' },
  { question: 'NodePort 类型怎么指定对外端口?', expectedChunkIds: ['Service::spec.ports.nodePort'], resource: 'Service' },
  { question: 'Service 怎么选中后端 Pod?', expectedChunkIds: ['Service::spec.selector'], resource: 'Service' },
  { question: 'Service 会话保持怎么配?', expectedChunkIds: ['Service::spec.sessionAffinity'], resource: 'Service' },

  // ── Ingress ─────────────────────────────────────
  { question: 'Ingress 路径匹配类型有哪些?', expectedChunkIds: ['Ingress::spec.rules.http.paths.pathType'], resource: 'Ingress' },
  { question: 'Ingress 怎么指定 ingress class?', expectedChunkIds: ['Ingress::spec.ingressClassName'], resource: 'Ingress' },
  { question: 'Ingress 怎么配 TLS 证书?', expectedChunkIds: ['Ingress::spec.tls'], resource: 'Ingress' },

  // ── NetworkPolicy ───────────────────────────────
  { question: 'NetworkPolicy 的策略方向有哪些取值?', expectedChunkIds: ['NetworkPolicy::spec.policyTypes'], resource: 'NetworkPolicy' },
  { question: 'NetworkPolicy 怎么选中要保护的 Pod?', expectedChunkIds: ['NetworkPolicy::spec.podSelector'], resource: 'NetworkPolicy' },

  // ── ConfigMap / Secret(易混淆:data/type/immutable) ──
  { question: 'ConfigMap 的键值数据放在哪个字段?', expectedChunkIds: ['ConfigMap::data'], resource: 'ConfigMap' },
  { question: 'ConfigMap 怎么设为不可变?', expectedChunkIds: ['ConfigMap::immutable'], resource: 'ConfigMap' },
  { question: 'Secret 怎么用明文写入数据?', expectedChunkIds: ['Secret::stringData'], resource: 'Secret' },
  { question: 'Secret 用哪个字段声明类型?', expectedChunkIds: ['Secret::type'], resource: 'Secret' },

  // ── ServiceAccount ──────────────────────────────
  { question: '怎么关闭 ServiceAccount 的 token 自动挂载?', expectedChunkIds: ['ServiceAccount::automountServiceAccountToken'], resource: 'ServiceAccount' },
  { question: 'ServiceAccount 怎么配置拉取私有镜像的凭据?', expectedChunkIds: ['ServiceAccount::imagePullSecrets'], resource: 'ServiceAccount' },

  // ── ResourceQuota / LimitRange ─────────────────
  { question: 'ResourceQuota 怎么设置命名空间的资源硬限制?', expectedChunkIds: ['ResourceQuota::spec.hard'], resource: 'ResourceQuota' },
  { question: 'LimitRange 怎么给容器设默认资源?', expectedChunkIds: ['LimitRange::spec.limits'], resource: 'LimitRange' },

  // ── HPA(autoscaling/v2)────────────────────────
  { question: 'HPA 怎么设置最大副本数?', expectedChunkIds: ['HorizontalPodAutoscaler::spec.maxReplicas'], resource: 'HorizontalPodAutoscaler' },
  { question: 'HPA 用哪个字段指向要伸缩的目标?', expectedChunkIds: ['HorizontalPodAutoscaler::spec.scaleTargetRef'], resource: 'HorizontalPodAutoscaler' },
  { question: 'HPA 基于哪些指标伸缩?', expectedChunkIds: ['HorizontalPodAutoscaler::spec.metrics'], resource: 'HorizontalPodAutoscaler' },

  // ── PodDisruptionBudget(与 rollingUpdate 的 maxUnavailable 易混)──
  { question: 'PodDisruptionBudget 怎么保证最少可用副本?', expectedChunkIds: ['PodDisruptionBudget::spec.minAvailable'], resource: 'PodDisruptionBudget' },
  { question: 'PDB 怎么选中它保护的 Pod?', expectedChunkIds: ['PodDisruptionBudget::spec.selector'], resource: 'PodDisruptionBudget' },

  // ── RBAC(Role/RoleBinding)─────────────────────
  { question: 'Role 用哪个字段声明允许的操作动词?', expectedChunkIds: ['Role::rules'], resource: 'Role' },
  { question: 'RoleBinding 怎么引用一个 Role?', expectedChunkIds: ['RoleBinding::roleRef'], resource: 'RoleBinding' },
  { question: 'RoleBinding 怎么指定被授权的用户或 SA?', expectedChunkIds: ['RoleBinding::subjects'], resource: 'RoleBinding' },
  { question: 'ClusterRole 用哪个字段声明权限规则?', expectedChunkIds: ['ClusterRole::rules'], resource: 'ClusterRole' },
  { question: 'ClusterRoleBinding 怎么引用一个 ClusterRole?', expectedChunkIds: ['ClusterRoleBinding::roleRef'], resource: 'ClusterRoleBinding' },

  // ── Endpoints ───────────────────────────────────
  { question: 'Endpoints 用哪个字段声明后端地址和端口?', expectedChunkIds: ['Endpoints::subsets'], resource: 'Endpoints' },

  // ── 存储(保留原易混淆集)───────────────────────
  { question: 'StorageClass 的回收策略能填哪些值?默认是什么?', expectedChunkIds: ['StorageClass::reclaimPolicy'], resource: 'StorageClass' },
  { question: 'PV 的回收策略支持哪些取值?', expectedChunkIds: ['PersistentVolume::spec.persistentVolumeReclaimPolicy'], resource: 'PersistentVolume' },
  { question: 'PVC 的访问模式有哪些?', expectedChunkIds: ['PersistentVolumeClaim::spec.accessModes'], resource: 'PersistentVolumeClaim' },
  { question: 'PV 怎么声明访问模式?', expectedChunkIds: ['PersistentVolume::spec.accessModes'], resource: 'PersistentVolume' },
  { question: '快照用哪个字段指定 CSI 驱动?', expectedChunkIds: ['VolumeSnapshotClass::driver'], resource: 'VolumeSnapshotClass' },
  { question: 'VolumeAttributesClass 用哪个字段指定驱动?', expectedChunkIds: ['VolumeAttributesClass::driverName'], resource: 'VolumeAttributesClass' },
  { question: '怎么把卷设成裸块设备?', expectedChunkIds: ['PersistentVolumeClaim::spec.volumeMode'], resource: 'PersistentVolumeClaim' },
  { question: '怎么让卷延迟到 Pod 调度后再绑定?', expectedChunkIds: ['StorageClass::volumeBindingMode'], resource: 'StorageClass' },
  { question: 'VolumeAttributesClass 改 IOPS 用哪个字段?', expectedChunkIds: ['VolumeAttributesClass::parameters'], resource: 'VolumeAttributesClass' },
  { question: '怎么允许 PVC 扩容?', expectedChunkIds: ['StorageClass::allowVolumeExpansion'], resource: 'StorageClass' },
  { question: 'PVC 怎么申请存储大小?', expectedChunkIds: ['PersistentVolumeClaim::spec.resources'], resource: 'PersistentVolumeClaim' },
  { question: 'StorageClass 必填字段是哪个?', expectedChunkIds: ['StorageClass::provisioner'], resource: 'StorageClass' },
];
