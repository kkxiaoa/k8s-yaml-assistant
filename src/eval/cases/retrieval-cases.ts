import { z } from 'zod';

const NonBlankStringSchema = z.string().trim().min(1);

export const SemanticRetrievalCaseSchema = z
  .strictObject({
    id: NonBlankStringSchema,
    question: NonBlankStringSchema,
    expectedChunkIds: z.array(NonBlankStringSchema).min(1),
    target: z.strictObject({
      kind: NonBlankStringSchema,
      apiVersion: NonBlankStringSchema.optional(),
    }),
    source: z.enum(['human', 'schema_generated', 'bad_case']),
  })
  .superRefine((evalCase, context) => {
    const seen = new Set<string>();
    for (const [index, chunkId] of evalCase.expectedChunkIds.entries()) {
      if (seen.has(chunkId)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate expected chunk id: ${chunkId}`,
          path: ['expectedChunkIds', index],
        });
      }
      seen.add(chunkId);
    }
  });

export type SemanticRetrievalCase = z.infer<
  typeof SemanticRetrievalCaseSchema
>;

export function decodeSemanticRetrievalCases(
  value: unknown,
  options: { knownChunkIds?: ReadonlySet<string> } = {},
): SemanticRetrievalCase[] {
  return z
    .array(SemanticRetrievalCaseSchema)
    .superRefine((cases, context) => {
      const seen = new Set<string>();
      for (const [caseIndex, evalCase] of cases.entries()) {
        if (seen.has(evalCase.id)) {
          context.addIssue({
            code: 'custom',
            message: `duplicate semantic retrieval case id: ${evalCase.id}`,
            path: [caseIndex, 'id'],
          });
        }
        seen.add(evalCase.id);

        if (options.knownChunkIds) {
          for (const [idIndex, chunkId] of evalCase.expectedChunkIds.entries()) {
            if (!options.knownChunkIds.has(chunkId)) {
              context.addIssue({
                code: 'custom',
                message: `unknown expected chunk id: ${chunkId}`,
                path: [caseIndex, 'expectedChunkIds', idIndex],
              });
            }
          }
        }
      }
    })
    .parse(value);
}

const H = 'human' as const;

export const RETRIEVAL_CASES = decodeSemanticRetrievalCases([
  // ── Pod:容器与调度 ──────────────────────────────
  {
    id: 'pod-image',
    source: H,
    target: { kind: 'Pod' },
    question: 'Pod 里怎么指定容器镜像?',
    expectedChunkIds: ['schema::v1::Pod::spec.containers.image'],
  },
  {
    id: 'pod-resources-limits',
    source: H,
    target: { kind: 'Pod' },
    question: 'Pod 容器怎么设置 CPU/内存上限?',
    expectedChunkIds: ['schema::v1::Pod::spec.containers.resources.limits'],
  },
  {
    id: 'pod-liveness-httpget',
    source: H,
    target: { kind: 'Pod' },
    question: 'Pod 存活探针 HTTP 检查用哪个字段指定访问路径?',
    expectedChunkIds: ['schema::v1::Pod::spec.containers.livenessProbe.httpGet.path'],
  },
  {
    id: 'pod-restartpolicy',
    source: H,
    target: { kind: 'Pod' },
    question: 'Pod 重启策略能填哪些值?',
    expectedChunkIds: ['schema::v1::Pod::spec.restartPolicy'],
  },
  {
    id: 'pod-imagepullpolicy',
    source: H,
    target: { kind: 'Pod' },
    question: 'Pod 镜像拉取策略怎么配?',
    expectedChunkIds: ['schema::v1::Pod::spec.containers.imagePullPolicy'],
  },
  {
    id: 'pod-nodeselector',
    source: H,
    target: { kind: 'Pod' },
    question: '怎么把 Pod 调度到带特定标签的节点?',
    expectedChunkIds: ['schema::v1::Pod::spec.nodeSelector'],
  },
  {
    id: 'pod-tolerations',
    source: H,
    target: { kind: 'Pod' },
    question: 'Pod 怎么容忍节点污点?',
    expectedChunkIds: ['schema::v1::Pod::spec.tolerations'],
  },
  {
    id: 'pod-runasnonroot',
    source: H,
    target: { kind: 'Pod' },
    question: 'Pod 怎么以非 root 用户运行?',
    expectedChunkIds: ['schema::v1::Pod::spec.securityContext.runAsNonRoot'],
  },
  {
    id: 'pod-volumes',
    source: H,
    target: { kind: 'Pod' },
    question: 'Pod 用哪个字段挂载卷来源?',
    expectedChunkIds: ['schema::v1::Pod::spec.volumes'],
  },
  {
    id: 'pod-serviceaccountname',
    source: H,
    target: { kind: 'Pod' },
    question: 'Pod 怎么指定使用的 ServiceAccount?',
    expectedChunkIds: ['schema::v1::Pod::spec.serviceAccountName'],
  },
  {
    id: 'pod-containerport',
    source: H,
    target: { kind: 'Pod' },
    question: 'Pod 容器怎么暴露端口号?',
    expectedChunkIds: ['schema::v1::Pod::spec.containers.ports.containerPort'],
  },
  {
    id: 'pod-env',
    source: H,
    target: { kind: 'Pod' },
    question: 'Pod 怎么给容器注入环境变量?',
    expectedChunkIds: ['schema::v1::Pod::spec.containers.env'],
  },

  // ── Deployment:副本与滚动更新 ───────────────────
  {
    id: 'deploy-replicas',
    source: H,
    target: { kind: 'Deployment' },
    question: 'Deployment 怎么设置副本数?',
    expectedChunkIds: ['schema::apps/v1::Deployment::spec.replicas'],
  },
  {
    id: 'deploy-strategy-type',
    source: H,
    target: { kind: 'Deployment' },
    question: 'Deployment 的更新策略有哪些类型?',
    expectedChunkIds: ['schema::apps/v1::Deployment::spec.strategy.type'],
  },
  {
    id: 'deploy-maxunavailable',
    source: H,
    target: { kind: 'Deployment' },
    question: 'Deployment 滚动更新时最多几个不可用?',
    expectedChunkIds: [
      'schema::apps/v1::Deployment::spec.strategy.rollingUpdate.maxUnavailable',
    ],
  },
  {
    id: 'deploy-selector',
    source: H,
    target: { kind: 'Deployment' },
    question: 'Deployment 怎么选中它管理的 Pod?',
    expectedChunkIds: ['schema::apps/v1::Deployment::spec.selector'],
  },
  {
    id: 'deploy-container-image',
    source: H,
    target: { kind: 'Deployment' },
    question: 'Deployment 里容器镜像写在哪个路径?',
    expectedChunkIds: ['schema::apps/v1::Deployment::spec.template.spec.containers.image'],
  },
  {
    id: 'deploy-revisionhistory',
    source: H,
    target: { kind: 'Deployment' },
    question: 'Deployment 保留多少个历史版本?',
    expectedChunkIds: ['schema::apps/v1::Deployment::spec.revisionHistoryLimit'],
  },

  // ── StatefulSet:与 Deployment 的差异点 ──────────
  {
    id: 'sts-servicename',
    source: H,
    target: { kind: 'StatefulSet' },
    question: 'StatefulSet 用哪个字段指定管理它的 service?',
    expectedChunkIds: ['schema::apps/v1::StatefulSet::spec.serviceName'],
  },
  {
    id: 'sts-volumeclaimtemplates',
    source: H,
    target: { kind: 'StatefulSet' },
    question: 'StatefulSet 怎么给每个副本申请独立存储?',
    expectedChunkIds: ['schema::apps/v1::StatefulSet::spec.volumeClaimTemplates'],
  },
  {
    id: 'sts-podmanagementpolicy',
    source: H,
    target: { kind: 'StatefulSet' },
    question: 'StatefulSet 的 Pod 是顺序还是并行启动?',
    expectedChunkIds: ['schema::apps/v1::StatefulSet::spec.podManagementPolicy'],
  },
  {
    id: 'sts-updatestrategy',
    source: H,
    target: { kind: 'StatefulSet' },
    question: 'StatefulSet 的更新策略字段是哪个?',
    expectedChunkIds: ['schema::apps/v1::StatefulSet::spec.updateStrategy.type'],
  },

  // ── DaemonSet ───────────────────────────────────
  {
    id: 'ds-updatestrategy',
    source: H,
    target: { kind: 'DaemonSet' },
    question: 'DaemonSet 的更新策略有哪些类型?',
    expectedChunkIds: ['schema::apps/v1::DaemonSet::spec.updateStrategy.type'],
  },

  // ── Job / CronJob ───────────────────────────────
  {
    id: 'job-completions',
    source: H,
    target: { kind: 'Job' },
    question: 'Job 怎么设置需要完成的次数?',
    expectedChunkIds: ['schema::batch/v1::Job::spec.completions'],
  },
  {
    id: 'job-parallelism',
    source: H,
    target: { kind: 'Job' },
    question: 'Job 怎么设置并行度?',
    expectedChunkIds: ['schema::batch/v1::Job::spec.parallelism'],
  },
  {
    id: 'job-backofflimit',
    source: H,
    target: { kind: 'Job' },
    question: 'Job 失败重试次数上限怎么配?',
    expectedChunkIds: ['schema::batch/v1::Job::spec.backoffLimit'],
  },
  {
    id: 'job-ttl',
    source: H,
    target: { kind: 'Job' },
    question: 'Job 完成后多久自动清理?',
    expectedChunkIds: ['schema::batch/v1::Job::spec.ttlSecondsAfterFinished'],
  },
  {
    id: 'cronjob-schedule',
    source: H,
    target: { kind: 'CronJob' },
    question: 'CronJob 的定时表达式写在哪个字段?',
    expectedChunkIds: ['schema::batch/v1::CronJob::spec.schedule'],
  },
  {
    id: 'cronjob-concurrencypolicy',
    source: H,
    target: { kind: 'CronJob' },
    question: 'CronJob 并发策略能填哪些值?',
    expectedChunkIds: ['schema::batch/v1::CronJob::spec.concurrencyPolicy'],
  },
  {
    id: 'cronjob-suspend',
    source: H,
    target: { kind: 'CronJob' },
    question: 'CronJob 怎么暂停调度?',
    expectedChunkIds: ['schema::batch/v1::CronJob::spec.suspend'],
  },
  {
    id: 'cronjob-successfulhistory',
    source: H,
    target: { kind: 'CronJob' },
    question: 'CronJob 保留多少条成功历史?',
    expectedChunkIds: ['schema::batch/v1::CronJob::spec.successfulJobsHistoryLimit'],
  },

  // ── Service:类型与端口 ─────────────────────────
  {
    id: 'svc-type',
    source: H,
    target: { kind: 'Service' },
    question: 'Service 有哪些类型?',
    expectedChunkIds: ['schema::v1::Service::spec.type'],
  },
  {
    id: 'svc-targetport',
    source: H,
    target: { kind: 'Service' },
    question: 'Service 怎么把端口转发到 Pod 的目标端口?',
    expectedChunkIds: ['schema::v1::Service::spec.ports.targetPort'],
  },
  {
    id: 'svc-nodeport',
    source: H,
    target: { kind: 'Service' },
    question: 'NodePort 类型怎么指定对外端口?',
    expectedChunkIds: ['schema::v1::Service::spec.ports.nodePort'],
  },
  {
    id: 'svc-selector',
    source: H,
    target: { kind: 'Service' },
    question: 'Service 怎么选中后端 Pod?',
    expectedChunkIds: ['schema::v1::Service::spec.selector'],
  },
  {
    id: 'svc-sessionaffinity',
    source: H,
    target: { kind: 'Service' },
    question: 'Service 会话保持怎么配?',
    expectedChunkIds: ['schema::v1::Service::spec.sessionAffinity'],
  },

  // ── Ingress ─────────────────────────────────────
  {
    id: 'ing-pathtype',
    source: H,
    target: { kind: 'Ingress' },
    question: 'Ingress 路径匹配类型有哪些?',
    expectedChunkIds: ['schema::networking.k8s.io/v1::Ingress::spec.rules.http.paths.pathType'],
  },
  {
    id: 'ing-classname',
    source: H,
    target: { kind: 'Ingress' },
    question: 'Ingress 怎么指定 ingress class?',
    expectedChunkIds: ['schema::networking.k8s.io/v1::Ingress::spec.ingressClassName'],
  },
  {
    id: 'ing-tls',
    source: H,
    target: { kind: 'Ingress' },
    question: 'Ingress 怎么配 TLS 证书?',
    expectedChunkIds: ['schema::networking.k8s.io/v1::Ingress::spec.tls'],
  },

  // ── NetworkPolicy ───────────────────────────────
  {
    id: 'netpol-policytypes',
    source: H,
    target: { kind: 'NetworkPolicy' },
    question: 'NetworkPolicy 的策略方向有哪些取值?',
    expectedChunkIds: ['schema::networking.k8s.io/v1::NetworkPolicy::spec.policyTypes'],
  },
  {
    id: 'netpol-podselector',
    source: H,
    target: { kind: 'NetworkPolicy' },
    question: 'NetworkPolicy 怎么选中要保护的 Pod?',
    expectedChunkIds: ['schema::networking.k8s.io/v1::NetworkPolicy::spec.podSelector'],
  },

  // ── ConfigMap / Secret(易混淆:data/type/immutable) ──
  {
    id: 'cm-data',
    source: H,
    target: { kind: 'ConfigMap' },
    question: 'ConfigMap 的键值数据放在哪个字段?',
    expectedChunkIds: ['schema::v1::ConfigMap::data'],
  },
  {
    id: 'cm-immutable',
    source: H,
    target: { kind: 'ConfigMap' },
    question: 'ConfigMap 怎么设为不可变?',
    expectedChunkIds: ['schema::v1::ConfigMap::immutable'],
  },
  {
    id: 'secret-stringdata',
    source: H,
    target: { kind: 'Secret' },
    question: 'Secret 怎么用明文写入数据?',
    expectedChunkIds: ['schema::v1::Secret::stringData'],
  },
  {
    id: 'secret-type',
    source: H,
    target: { kind: 'Secret' },
    question: 'Secret 用哪个字段声明类型?',
    expectedChunkIds: ['schema::v1::Secret::type'],
  },

  // ── ServiceAccount ──────────────────────────────
  {
    id: 'sa-automount',
    source: H,
    target: { kind: 'ServiceAccount' },
    question: '怎么关闭 ServiceAccount 的 token 自动挂载?',
    expectedChunkIds: ['schema::v1::ServiceAccount::automountServiceAccountToken'],
  },
  {
    id: 'sa-imagepullsecrets',
    source: H,
    target: { kind: 'ServiceAccount' },
    question: 'ServiceAccount 怎么配置拉取私有镜像的凭据?',
    expectedChunkIds: ['schema::v1::ServiceAccount::imagePullSecrets'],
  },

  // ── ResourceQuota / LimitRange ─────────────────
  {
    id: 'quota-hard',
    source: H,
    target: { kind: 'ResourceQuota' },
    question: 'ResourceQuota 怎么设置命名空间的资源硬限制?',
    expectedChunkIds: ['schema::v1::ResourceQuota::spec.hard'],
  },
  {
    id: 'limitrange-limits',
    source: H,
    target: { kind: 'LimitRange' },
    question: 'LimitRange 怎么给容器设默认资源?',
    expectedChunkIds: [
      'schema::v1::LimitRange::spec.limits.default',
      'schema::v1::LimitRange::spec.limits.defaultRequest',
    ],
  },

  // ── HPA(autoscaling/v2)────────────────────────
  {
    id: 'hpa-maxreplicas',
    source: H,
    target: { kind: 'HorizontalPodAutoscaler' },
    question: 'HPA 怎么设置最大副本数?',
    expectedChunkIds: ['schema::autoscaling/v2::HorizontalPodAutoscaler::spec.maxReplicas'],
  },
  {
    id: 'hpa-scaletargetref',
    source: H,
    target: { kind: 'HorizontalPodAutoscaler' },
    question: 'HPA 用哪个字段指向要伸缩的目标?',
    expectedChunkIds: ['schema::autoscaling/v2::HorizontalPodAutoscaler::spec.scaleTargetRef'],
  },
  {
    id: 'hpa-metrics',
    source: H,
    target: { kind: 'HorizontalPodAutoscaler' },
    question: 'HPA 基于哪些指标伸缩?',
    expectedChunkIds: ['schema::autoscaling/v2::HorizontalPodAutoscaler::spec.metrics'],
  },

  // ── PodDisruptionBudget(与 rollingUpdate 的 maxUnavailable 易混)──
  {
    id: 'pdb-minavailable',
    source: H,
    target: { kind: 'PodDisruptionBudget' },
    question: 'PodDisruptionBudget 怎么保证最少可用副本?',
    expectedChunkIds: ['schema::policy/v1::PodDisruptionBudget::spec.minAvailable'],
  },
  {
    id: 'pdb-selector',
    source: H,
    target: { kind: 'PodDisruptionBudget' },
    question: 'PDB 怎么选中它保护的 Pod?',
    expectedChunkIds: ['schema::policy/v1::PodDisruptionBudget::spec.selector'],
  },

  // ── RBAC(Role/RoleBinding/ClusterRole)─────────
  {
    id: 'role-rules',
    source: H,
    target: { kind: 'Role' },
    question: 'Role 用哪个字段声明允许的操作动词?',
    expectedChunkIds: ['schema::rbac.authorization.k8s.io/v1::Role::rules.verbs'],
  },
  {
    id: 'rolebinding-roleref',
    source: H,
    target: { kind: 'RoleBinding' },
    question: 'RoleBinding 怎么引用一个 Role?',
    expectedChunkIds: ['schema::rbac.authorization.k8s.io/v1::RoleBinding::roleRef'],
  },
  {
    id: 'rolebinding-subjects',
    source: H,
    target: { kind: 'RoleBinding' },
    question: 'RoleBinding 怎么指定被授权的用户或 SA?',
    expectedChunkIds: ['schema::rbac.authorization.k8s.io/v1::RoleBinding::subjects'],
  },
  {
    id: 'clusterrole-rules',
    source: H,
    target: { kind: 'ClusterRole' },
    question: 'ClusterRole 用哪个字段声明权限规则?',
    expectedChunkIds: ['schema::rbac.authorization.k8s.io/v1::ClusterRole::rules'],
  },
  {
    id: 'crb-roleref',
    source: H,
    target: { kind: 'ClusterRoleBinding' },
    question: 'ClusterRoleBinding 怎么引用一个 ClusterRole?',
    expectedChunkIds: ['schema::rbac.authorization.k8s.io/v1::ClusterRoleBinding::roleRef'],
  },

  // ── Endpoints ───────────────────────────────────
  {
    id: 'endpoints-subsets',
    source: H,
    target: { kind: 'Endpoints' },
    question: 'Endpoints 用哪个字段声明后端地址和端口?',
    expectedChunkIds: [
      'schema::v1::Endpoints::subsets.addresses',
      'schema::v1::Endpoints::subsets.ports',
    ],
  },

  // ── 存储(易混淆集)──────────────────────────────
  {
    id: 'sc-reclaimpolicy',
    source: H,
    target: { kind: 'StorageClass' },
    question: 'StorageClass 的回收策略能填哪些值?默认是什么?',
    expectedChunkIds: ['schema::storage.k8s.io/v1::StorageClass::reclaimPolicy'],
  },
  {
    id: 'pv-reclaimpolicy',
    source: H,
    target: { kind: 'PersistentVolume' },
    question: 'PV 的回收策略支持哪些取值?',
    expectedChunkIds: ['schema::v1::PersistentVolume::spec.persistentVolumeReclaimPolicy'],
  },
  {
    id: 'pvc-accessmodes',
    source: H,
    target: { kind: 'PersistentVolumeClaim' },
    question: 'PVC 的访问模式有哪些?',
    expectedChunkIds: ['schema::v1::PersistentVolumeClaim::spec.accessModes'],
  },
  {
    id: 'pv-accessmodes',
    source: H,
    target: { kind: 'PersistentVolume' },
    question: 'PV 怎么声明访问模式?',
    expectedChunkIds: ['schema::v1::PersistentVolume::spec.accessModes'],
  },
  {
    id: 'vsc-driver',
    source: H,
    target: { kind: 'VolumeSnapshotClass' },
    question: 'VolumeSnapshotClass 用哪个字段指定存储驱动?',
    expectedChunkIds: ['schema::snapshot.storage.k8s.io/v1::VolumeSnapshotClass::driver'],
  },
  {
    id: 'vac-drivername',
    source: H,
    target: { kind: 'VolumeAttributesClass' },
    question: 'VolumeAttributesClass 用哪个字段指定驱动?',
    expectedChunkIds: ['schema::storage.k8s.io/v1beta1::VolumeAttributesClass::driverName'],
  },
  {
    id: 'pvc-volumemode',
    source: H,
    target: { kind: 'PersistentVolumeClaim' },
    question: '怎么把卷设成裸块设备?',
    expectedChunkIds: ['schema::v1::PersistentVolumeClaim::spec.volumeMode'],
  },
  {
    id: 'sc-volumebindingmode',
    source: H,
    target: { kind: 'StorageClass' },
    question: '怎么让卷延迟到 Pod 调度后再绑定?',
    expectedChunkIds: ['schema::storage.k8s.io/v1::StorageClass::volumeBindingMode'],
  },
  {
    id: 'vac-parameters',
    source: H,
    target: { kind: 'VolumeAttributesClass' },
    question: 'VolumeAttributesClass 改 IOPS 用哪个字段?',
    expectedChunkIds: ['schema::storage.k8s.io/v1beta1::VolumeAttributesClass::parameters'],
  },
  {
    id: 'sc-allowexpansion',
    source: H,
    target: { kind: 'StorageClass' },
    question: '怎么允许 PVC 扩容?',
    expectedChunkIds: ['schema::storage.k8s.io/v1::StorageClass::allowVolumeExpansion'],
  },
  {
    id: 'pvc-resources',
    source: H,
    target: { kind: 'PersistentVolumeClaim' },
    question: 'PVC 怎么申请存储大小?',
    expectedChunkIds: ['schema::v1::PersistentVolumeClaim::spec.resources.requests'],
  },
  {
    id: 'sc-provisioner',
    source: H,
    target: { kind: 'StorageClass' },
    question: 'StorageClass 必填字段是哪个?',
    expectedChunkIds: ['schema::storage.k8s.io/v1::StorageClass::provisioner'],
  },

  // ── Stage 6:平台 policy 用例(纯 policy 问询 + schema/policy 冲突)──
  {
    id: 'policy-deploy-limits',
    source: H,
    target: { kind: 'Deployment' },
    question: '平台对 Deployment 的资源限制有什么规范?',
    expectedChunkIds: ['policy.deployment.resources.limits.required'],
  },
  {
    id: 'policy-pod-privileged',
    source: H,
    target: { kind: 'Pod' },
    question: '平台允许运行特权(privileged)容器吗?',
    expectedChunkIds: ['policy.pod.security.privileged.forbidden'],
  },
  {
    id: 'policy-sc-reclaim',
    source: H,
    target: { kind: 'StorageClass' },
    question: '平台对 StorageClass 的回收策略有什么建议?',
    expectedChunkIds: ['policy.storageclass.reclaimPolicy.retain.recommended'],
  },
  {
    id: 'policy-secret-plaintext',
    source: H,
    target: { kind: 'Secret' },
    question: '平台允许在 Secret 里明文存 data 吗?',
    expectedChunkIds: ['policy.secret.no-plaintext-data.discouraged'],
  },
  {
    id: 'policy-crb-admin',
    source: H,
    target: { kind: 'ClusterRoleBinding' },
    question: '平台允许给应用工作负载绑定 cluster-admin 吗?',
    expectedChunkIds: ['policy.clusterrolebinding.no-cluster-admin.forbidden'],
  },
  {
    id: 'policy-ingress-tls',
    source: H,
    target: { kind: 'Ingress' },
    question: '平台对 Ingress 的 TLS 有什么要求?',
    expectedChunkIds: ['policy.ingress.tls.required'],
  },
  {
    id: 'policy-conflict-latest',
    source: H,
    target: { kind: 'Deployment' },
    question: '生产环境我能用 nginx:latest 吗?',
    expectedChunkIds: ['policy.deployment.image.tag.no-latest'],
  },
  {
    id: 'policy-conflict-nodeport',
    source: H,
    target: { kind: 'Service' },
    question: '我的 Service 能设 type: NodePort 吗?',
    expectedChunkIds: ['policy.service.type.nodeport.forbidden'],
  },
  {
    id: 'policy-conflict-privileged',
    source: H,
    target: { kind: 'Pod' },
    question: '我能给容器开 privileged: true 吗?',
    expectedChunkIds: ['policy.pod.security.privileged.forbidden'],
  },
]);
