import { z } from "zod";
import {
  governanceSchemaForCaseFamily,
  type EvalCaseGovernance,
} from "./governance";
import {
  RequiredEvidenceGroupsSchema,
  exactEvidenceGroups,
} from "./evidence-groups";

const NonBlankStringSchema = z.string().trim().min(1);

export const ExpectedChunkIdsSchema = z
  .array(NonBlankStringSchema)
  .min(1)
  .superRefine((chunkIds, context) => {
    const seen = new Set<string>();
    for (const [index, chunkId] of chunkIds.entries()) {
      if (seen.has(chunkId)) {
        context.addIssue({
          code: "custom",
          message: `duplicate expected chunk id: ${chunkId}`,
          path: [index],
        });
      }
      seen.add(chunkId);
    }
  });

export const SemanticRetrievalCaseSchema = z.strictObject({
  id: NonBlankStringSchema,
  question: NonBlankStringSchema,
  expectedEvidenceGroups: RequiredEvidenceGroupsSchema,
  target: z.strictObject({
    kind: NonBlankStringSchema,
    apiVersion: NonBlankStringSchema.optional(),
  }),
  governance: governanceSchemaForCaseFamily("retrieval"),
});

export type SemanticRetrievalCase = z.infer<typeof SemanticRetrievalCaseSchema>;

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
            code: "custom",
            message: `duplicate semantic retrieval case id: ${evalCase.id}`,
            path: [caseIndex, "id"],
          });
        }
        seen.add(evalCase.id);

        if (options.knownChunkIds) {
          for (const [groupIndex, group] of
            evalCase.expectedEvidenceGroups.entries()) {
            for (const [idIndex, chunkId] of group.anyOfChunkIds.entries()) {
              if (!options.knownChunkIds.has(chunkId)) {
                context.addIssue({
                  code: "custom",
                  message: `unknown expected chunk id: ${chunkId}`,
                  path: [
                    caseIndex,
                    "expectedEvidenceGroups",
                    groupIndex,
                    "anyOfChunkIds",
                    idIndex,
                  ],
                });
              }
            }
          }
        }
      }
    })
    .parse(value);
}

const FIELD_DEVELOPMENT = {
  task: "field_explanation",
  origin: "human",
  role: "development",
} as const satisfies EvalCaseGovernance;

const FIELD_REGRESSION = {
  ...FIELD_DEVELOPMENT,
  role: "regression",
} as const satisfies EvalCaseGovernance;

const FIELD_HOLDOUT = {
  ...FIELD_DEVELOPMENT,
  role: "holdout",
} as const satisfies EvalCaseGovernance;

const POLICY_DEVELOPMENT = {
  ...FIELD_DEVELOPMENT,
  task: "policy_explanation",
} as const satisfies EvalCaseGovernance;

const POLICY_REGRESSION = {
  ...POLICY_DEVELOPMENT,
  role: "regression",
} as const satisfies EvalCaseGovernance;

export const RETRIEVAL_CASES = decodeSemanticRetrievalCases([
  // ── Pod:容器与调度 ──────────────────────────────
  {
    id: "pod-image",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Pod" },
    question: "Pod 里怎么指定容器镜像?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Pod::spec.containers.image"]),
  },
  {
    id: "pod-resources-limits",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Pod" },
    question: "Pod 容器怎么设置 CPU/内存上限?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Pod::spec.containers.resources.limits"]),
  },
  {
    id: "pod-liveness-httpget",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Pod" },
    question: "Pod 存活探针 HTTP 检查用哪个字段指定访问路径?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::v1::Pod::spec.containers.livenessProbe.httpGet.path",
    ]),
  },
  {
    id: "pod-restartpolicy",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Pod" },
    question: "Pod 重启策略能填哪些值?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Pod::spec.restartPolicy"]),
  },
  {
    id: "pod-imagepullpolicy",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Pod" },
    question: "Pod 镜像拉取策略怎么配?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::v1::Pod::spec.containers.imagePullPolicy",
      "docs::kubernetes::images::image-pull-policy",
      "example::kubernetes::pod-image-pull-policy",
    ]),
  },
  {
    id: "pod-nodeselector",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Pod" },
    question: "怎么把 Pod 调度到带特定标签的节点?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Pod::spec.nodeSelector"]),
  },
  {
    id: "pod-tolerations",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Pod" },
    question: "Pod 怎么容忍节点污点?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Pod::spec.tolerations"]),
  },
  {
    id: "pod-runasnonroot",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Pod" },
    question: "Pod 怎么以非 root 用户运行?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Pod::spec.securityContext.runAsNonRoot"]),
  },
  {
    id: "pod-volumes",
    governance: FIELD_REGRESSION,
    target: { kind: "Pod" },
    question: "Pod 用哪个字段挂载卷来源?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Pod::spec.volumes"]),
  },
  {
    id: "cross-pod-volume-sources",
    governance: FIELD_REGRESSION,
    target: { kind: "Pod" },
    question: "Pod 怎么分别引用 PVC、ConfigMap 和 Secret 作为卷?",
    expectedEvidenceGroups: [
      {
        anyOfChunkIds: [
          "schema::v1::Pod::spec.volumes.persistentVolumeClaim",
          "docs::kubernetes::volumes::persistent-volume-claim",
        ],
      },
      {
        anyOfChunkIds: [
          "schema::v1::Pod::spec.volumes.configMap",
          "docs::kubernetes::volumes::config-map",
        ],
      },
      {
        anyOfChunkIds: [
          "schema::v1::Pod::spec.volumes.secret",
          "docs::kubernetes::volumes::secret",
        ],
      },
    ],
  },
  {
    id: "pod-serviceaccountname",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Pod" },
    question: "Pod 怎么指定使用的 ServiceAccount?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Pod::spec.serviceAccountName"]),
  },
  {
    id: "pod-containerport",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Pod" },
    question: "Pod 容器怎么暴露端口号?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Pod::spec.containers.ports.containerPort"]),
  },
  {
    id: "pod-env",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Pod" },
    question: "Pod 怎么给容器注入环境变量?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Pod::spec.containers.env"]),
  },

  // ── Deployment:副本与滚动更新 ───────────────────
  {
    id: "deploy-replicas",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Deployment" },
    question: "Deployment 怎么设置副本数?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::apps/v1::Deployment::spec.replicas"]),
  },
  {
    id: "deploy-strategy-type",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Deployment" },
    question: "Deployment 的更新策略有哪些类型?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::apps/v1::Deployment::spec.strategy.type"]),
  },
  {
    id: "deploy-maxunavailable",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Deployment" },
    question: "Deployment 滚动更新时最多几个不可用?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::apps/v1::Deployment::spec.strategy.rollingUpdate.maxUnavailable",
    ]),
  },
  {
    id: "deploy-selector",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Deployment" },
    question: "Deployment 怎么选中它管理的 Pod?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::apps/v1::Deployment::spec.selector",
      "docs::kubernetes::deployment::selector",
      "example::kubernetes::deployment-selector",
    ]),
  },
  {
    id: "deploy-container-image",
    governance: FIELD_REGRESSION,
    target: { kind: "Deployment" },
    question: "Deployment 里容器镜像写在哪个路径?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::apps/v1::Deployment::spec.template.spec.containers.image",
    ]),
  },
  {
    id: "deploy-revisionhistory",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Deployment" },
    question: "Deployment 保留多少个历史版本?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::apps/v1::Deployment::spec.revisionHistoryLimit",
    ]),
  },

  // ── StatefulSet:与 Deployment 的差异点 ──────────
  {
    id: "sts-servicename",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "StatefulSet" },
    question: "StatefulSet 用哪个字段指定管理它的 service?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::apps/v1::StatefulSet::spec.serviceName"]),
  },
  {
    id: "sts-volumeclaimtemplates",
    governance: FIELD_REGRESSION,
    target: { kind: "StatefulSet" },
    question: "StatefulSet 怎么给每个副本申请独立存储?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::apps/v1::StatefulSet::spec.volumeClaimTemplates",
    ]),
  },
  {
    id: "sts-podmanagementpolicy",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "StatefulSet" },
    question: "StatefulSet 的 Pod 是顺序还是并行启动?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::apps/v1::StatefulSet::spec.podManagementPolicy",
    ]),
  },
  {
    id: "sts-updatestrategy",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "StatefulSet" },
    question: "StatefulSet 的更新策略字段是哪个?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::apps/v1::StatefulSet::spec.updateStrategy.type",
    ]),
  },

  // ── DaemonSet ───────────────────────────────────
  {
    id: "ds-updatestrategy",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "DaemonSet" },
    question: "DaemonSet 的更新策略有哪些类型?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::apps/v1::DaemonSet::spec.updateStrategy.type"]),
  },

  // ── Job / CronJob ───────────────────────────────
  {
    id: "job-completions",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Job" },
    question: "Job 怎么设置需要完成的次数?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::batch/v1::Job::spec.completions"]),
  },
  {
    id: "job-parallelism",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Job" },
    question: "Job 怎么设置并行度?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::batch/v1::Job::spec.parallelism"]),
  },
  {
    id: "job-backofflimit",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Job" },
    question: "Job 失败重试次数上限怎么配?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::batch/v1::Job::spec.backoffLimit"]),
  },
  {
    id: "job-ttl",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Job" },
    question: "Job 完成后多久自动清理?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::batch/v1::Job::spec.ttlSecondsAfterFinished"]),
  },
  {
    id: "cronjob-schedule",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "CronJob" },
    question: "CronJob 的定时表达式写在哪个字段?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::batch/v1::CronJob::spec.schedule"]),
  },
  {
    id: "cronjob-concurrencypolicy",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "CronJob" },
    question: "CronJob 并发策略能填哪些值?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::batch/v1::CronJob::spec.concurrencyPolicy"]),
  },
  {
    id: "cronjob-suspend",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "CronJob" },
    question: "CronJob 怎么暂停调度?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::batch/v1::CronJob::spec.suspend"]),
  },
  {
    id: "cronjob-successfulhistory",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "CronJob" },
    question: "CronJob 保留多少条成功历史?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::batch/v1::CronJob::spec.successfulJobsHistoryLimit",
    ]),
  },

  // ── Service:类型与端口 ─────────────────────────
  {
    id: "svc-type",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Service" },
    question: "Service 有哪些类型?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Service::spec.type"]),
  },
  {
    id: "svc-targetport",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Service" },
    question: "Service 怎么把端口转发到 Pod 的目标端口?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Service::spec.ports.targetPort"]),
  },
  {
    id: "svc-nodeport",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Service" },
    question: "NodePort 类型怎么指定对外端口?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Service::spec.ports.nodePort"]),
  },
  {
    id: "svc-selector",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Service" },
    question: "Service 怎么选中后端 Pod?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Service::spec.selector"]),
  },
  {
    id: "svc-sessionaffinity",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Service" },
    question: "Service 会话保持怎么配?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Service::spec.sessionAffinity"]),
  },

  // ── Ingress ─────────────────────────────────────
  {
    id: "ing-pathtype",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Ingress" },
    question: "Ingress 路径匹配类型有哪些?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::networking.k8s.io/v1::Ingress::spec.rules.http.paths.pathType",
    ]),
  },
  {
    id: "ing-classname",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Ingress" },
    question: "Ingress 怎么指定 ingress class?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::networking.k8s.io/v1::Ingress::spec.ingressClassName",
    ]),
  },
  {
    id: "ing-tls",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Ingress" },
    question: "Ingress 怎么配 TLS 证书?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::networking.k8s.io/v1::Ingress::spec.tls"]),
  },
  {
    id: "cross-ingress-service-secret",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Ingress" },
    question: "Ingress 怎么把请求转发到 Service，并用 Secret 终止 TLS?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::networking.k8s.io/v1::Ingress::spec.rules.http.paths.backend.service",
      "schema::networking.k8s.io/v1::Ingress::spec.tls.secretName",
    ]),
  },

  // ── NetworkPolicy ───────────────────────────────
  {
    id: "netpol-policytypes",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "NetworkPolicy" },
    question: "NetworkPolicy 的策略方向有哪些取值?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::networking.k8s.io/v1::NetworkPolicy::spec.policyTypes",
    ]),
  },
  {
    id: "netpol-podselector",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "NetworkPolicy" },
    question: "NetworkPolicy 怎么选中要保护的 Pod?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::networking.k8s.io/v1::NetworkPolicy::spec.podSelector",
    ]),
  },

  // ── ConfigMap / Secret(易混淆:data/type/immutable) ──
  {
    id: "cm-data",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "ConfigMap" },
    question: "ConfigMap 的键值数据放在哪个字段?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::ConfigMap::data"]),
  },
  {
    id: "cm-immutable",
    governance: FIELD_REGRESSION,
    target: { kind: "ConfigMap" },
    question: "ConfigMap 怎么设为不可变?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::v1::ConfigMap::immutable",
      "docs::kubernetes::configmap::configmap-immutable",
      "example::kubernetes::configmap-immutable",
    ]),
  },
  {
    id: "secret-stringdata",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Secret" },
    question: "Secret 怎么用明文写入数据?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Secret::stringData"]),
  },
  {
    id: "secret-type",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Secret" },
    question: "Secret 用哪个字段声明类型?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::Secret::type"]),
  },

  // ── ServiceAccount ──────────────────────────────
  {
    id: "sa-automount",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "ServiceAccount" },
    question: "怎么关闭 ServiceAccount 的 token 自动挂载?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::v1::ServiceAccount::automountServiceAccountToken",
    ]),
  },
  {
    id: "sa-imagepullsecrets",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "ServiceAccount" },
    question: "ServiceAccount 怎么配置拉取私有镜像的凭据?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::ServiceAccount::imagePullSecrets"]),
  },

  // ── ResourceQuota / LimitRange ─────────────────
  {
    id: "quota-hard",
    governance: FIELD_REGRESSION,
    target: { kind: "ResourceQuota" },
    question: "ResourceQuota 怎么设置命名空间的资源硬限制?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::v1::ResourceQuota::spec.hard",
      "docs::kubernetes::resource-quotas::compute-resource-quota",
      "example::kubernetes::resource-quota-mem-cpu",
    ]),
  },
  {
    id: "limitrange-limits",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "LimitRange" },
    question: "LimitRange 怎么给容器设默认资源?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::v1::LimitRange::spec.limits.default",
      "schema::v1::LimitRange::spec.limits.defaultRequest",
    ]),
  },

  // ── HPA(autoscaling/v2)────────────────────────
  {
    id: "hpa-maxreplicas",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "HorizontalPodAutoscaler" },
    question: "HPA 怎么设置最大副本数?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::autoscaling/v2::HorizontalPodAutoscaler::spec.maxReplicas",
    ]),
  },
  {
    id: "hpa-scaletargetref",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "HorizontalPodAutoscaler" },
    question: "HPA 用哪个字段指向要伸缩的目标?",
    expectedEvidenceGroups: [
      {
        anyOfChunkIds: [
          "schema::autoscaling/v2::HorizontalPodAutoscaler::spec.scaleTargetRef",
          "docs::kubernetes::horizontal-pod-autoscale::scale-target",
        ],
      },
    ],
  },
  {
    id: "cross-hpa-deployment",
    governance: FIELD_REGRESSION,
    target: { kind: "HorizontalPodAutoscaler" },
    question: "HPA 怎么指定需要伸缩的 Deployment?",
    expectedEvidenceGroups: [
      {
        anyOfChunkIds: [
          "schema::autoscaling/v2::HorizontalPodAutoscaler::spec.scaleTargetRef",
          "docs::kubernetes::horizontal-pod-autoscale::scale-target",
        ],
      },
    ],
  },
  {
    id: "hpa-metrics",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "HorizontalPodAutoscaler" },
    question: "HPA 基于哪些指标伸缩?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::autoscaling/v2::HorizontalPodAutoscaler::spec.metrics",
    ]),
  },

  // ── PodDisruptionBudget(与 rollingUpdate 的 maxUnavailable 易混)──
  {
    id: "pdb-minavailable",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "PodDisruptionBudget" },
    question: "PodDisruptionBudget 怎么保证最少可用副本?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::policy/v1::PodDisruptionBudget::spec.minAvailable",
    ]),
  },
  {
    id: "pdb-selector",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "PodDisruptionBudget" },
    question: "PDB 怎么选中它保护的 Pod?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::policy/v1::PodDisruptionBudget::spec.selector"]),
  },

  // ── RBAC(Role/RoleBinding/ClusterRole)─────────
  {
    id: "role-rules",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "Role" },
    question: "Role 用哪个字段声明允许的操作动词?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::rbac.authorization.k8s.io/v1::Role::rules.verbs",
    ]),
  },
  {
    id: "rolebinding-roleref",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "RoleBinding" },
    question: "RoleBinding 怎么引用一个 Role?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::rbac.authorization.k8s.io/v1::RoleBinding::roleRef",
    ]),
  },
  {
    id: "rolebinding-subjects",
    governance: FIELD_REGRESSION,
    target: { kind: "RoleBinding" },
    question: "RoleBinding 怎么指定被授权的用户或 SA?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::rbac.authorization.k8s.io/v1::RoleBinding::subjects",
    ]),
  },
  {
    id: "cross-rolebinding-role-subject",
    governance: FIELD_REGRESSION,
    target: { kind: "RoleBinding" },
    question: "RoleBinding 怎么把 ServiceAccount 绑定到 Role 或 ClusterRole?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::rbac.authorization.k8s.io/v1::RoleBinding::roleRef",
      "schema::rbac.authorization.k8s.io/v1::RoleBinding::subjects.kind",
    ]),
  },
  {
    id: "clusterrole-rules",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "ClusterRole" },
    question: "ClusterRole 用哪个字段声明权限规则?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::rbac.authorization.k8s.io/v1::ClusterRole::rules",
    ]),
  },
  {
    id: "crb-roleref",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "ClusterRoleBinding" },
    question: "ClusterRoleBinding 怎么引用一个 ClusterRole?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::rbac.authorization.k8s.io/v1::ClusterRoleBinding::roleRef",
    ]),
  },

  // ── Endpoints ───────────────────────────────────
  {
    id: "endpoints-subsets",
    governance: FIELD_REGRESSION,
    target: { kind: "Endpoints" },
    question: "Endpoints 用哪个字段声明后端地址和端口?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::v1::Endpoints::subsets.addresses",
      "schema::v1::Endpoints::subsets.ports",
    ]),
  },

  // ── 存储(易混淆集)──────────────────────────────
  {
    id: "sc-reclaimpolicy",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "StorageClass" },
    question: "StorageClass 的回收策略能填哪些值?默认是什么?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::storage.k8s.io/v1::StorageClass::reclaimPolicy",
    ]),
  },
  {
    id: "pv-reclaimpolicy",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "PersistentVolume" },
    question: "PV 的回收策略支持哪些取值?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::v1::PersistentVolume::spec.persistentVolumeReclaimPolicy",
    ]),
  },
  {
    id: "pvc-accessmodes",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "PersistentVolumeClaim" },
    question: "PVC 的访问模式有哪些?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::PersistentVolumeClaim::spec.accessModes"]),
  },
  {
    id: "pv-accessmodes",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "PersistentVolume" },
    question: "PV 怎么声明访问模式?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::PersistentVolume::spec.accessModes"]),
  },
  {
    id: "vsc-driver",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "VolumeSnapshotClass" },
    question: "VolumeSnapshotClass 用哪个字段指定存储驱动?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::snapshot.storage.k8s.io/v1::VolumeSnapshotClass::driver",
    ]),
  },
  {
    id: "vac-drivername",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "VolumeAttributesClass" },
    question: "VolumeAttributesClass 用哪个字段指定驱动?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::storage.k8s.io/v1beta1::VolumeAttributesClass::driverName",
    ]),
  },
  {
    id: "pvc-volumemode",
    governance: FIELD_REGRESSION,
    target: { kind: "PersistentVolumeClaim" },
    question: "怎么把卷设成裸块设备?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::v1::PersistentVolumeClaim::spec.volumeMode"]),
  },
  {
    id: "sc-volumebindingmode",
    governance: FIELD_REGRESSION,
    target: { kind: "StorageClass" },
    question: "怎么让卷延迟到 Pod 调度后再绑定?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::storage.k8s.io/v1::StorageClass::volumeBindingMode",
      "docs::kubernetes::storage-classes::volume-binding-mode",
      "example::kubernetes::storageclass-low-latency",
    ]),
  },
  {
    id: "vac-parameters",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "VolumeAttributesClass" },
    question: "VolumeAttributesClass 改 IOPS 用哪个字段?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::storage.k8s.io/v1beta1::VolumeAttributesClass::parameters",
    ]),
  },
  {
    id: "sc-allowexpansion",
    governance: FIELD_REGRESSION,
    target: { kind: "StorageClass" },
    question: "怎么允许 PVC 扩容?",
    expectedEvidenceGroups: [
      {
        anyOfChunkIds: [
          "schema::storage.k8s.io/v1::StorageClass::allowVolumeExpansion",
          "docs::kubernetes::storage-classes::volume-expansion",
        ],
      },
      {
        anyOfChunkIds: [
          "example::kubernetes::storageclass-low-latency",
        ],
      },
    ],
  },
  {
    id: "cross-pvc-storageclass-expansion",
    governance: FIELD_REGRESSION,
    target: { kind: "PersistentVolumeClaim" },
    question: "需要配置哪些资源字段才能支持 PVC 扩容？",
    expectedEvidenceGroups: [
      {
        anyOfChunkIds: [
          "schema::v1::PersistentVolumeClaim::spec.resources.requests",
          "docs::kubernetes::storage-classes::volume-expansion",
        ],
      },
      {
        anyOfChunkIds: [
          "schema::storage.k8s.io/v1::StorageClass::allowVolumeExpansion",
          "docs::kubernetes::storage-classes::volume-expansion",
        ],
      },
    ],
  },
  {
    id: "pvc-resources",
    governance: FIELD_REGRESSION,
    target: { kind: "PersistentVolumeClaim" },
    question: "PVC 怎么申请存储大小?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::v1::PersistentVolumeClaim::spec.resources.requests",
    ]),
  },
  {
    id: "sc-provisioner",
    governance: FIELD_DEVELOPMENT,
    target: { kind: "StorageClass" },
    question: "StorageClass 必填字段是哪个?",
    expectedEvidenceGroups: exactEvidenceGroups(["schema::storage.k8s.io/v1::StorageClass::provisioner"]),
  },

  // ── Cluster CRD ─────────────────────────────────
  {
    id: "gateway-httproute-backend-weight",
    governance: FIELD_DEVELOPMENT,
    target: {
      kind: "HTTPRoute",
      apiVersion: "gateway.networking.k8s.io/v1",
    },
    question: "Gateway API 的 HTTPRoute 怎么按权重分流?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::gateway.networking.k8s.io/v1::HTTPRoute::spec.rules.backendRefs.weight",
    ]),
  },
  {
    id: "certificate-issuer-ref",
    governance: FIELD_HOLDOUT,
    target: {
      kind: "Certificate",
      apiVersion: "cert-manager.io/v1",
    },
    question: "cert-manager 的 Certificate 怎么指定签发者 issuer?",
    expectedEvidenceGroups: exactEvidenceGroups([
      "schema::cert-manager.io/v1::Certificate::spec.issuerRef",
    ]),
  },

  // ── Stage 6:平台 policy 用例(纯 policy 问询 + schema/policy 冲突)──
  {
    id: "policy-deploy-limits",
    governance: POLICY_DEVELOPMENT,
    target: { kind: "Deployment" },
    question: "平台对 Deployment 的资源限制有什么规范?",
    expectedEvidenceGroups: exactEvidenceGroups(["policy.deployment.resources.limits.required"]),
  },
  {
    id: "policy-pod-privileged",
    governance: POLICY_DEVELOPMENT,
    target: { kind: "Pod" },
    question: "平台允许运行特权(privileged)容器吗?",
    expectedEvidenceGroups: exactEvidenceGroups(["policy.pod.security.privileged.forbidden"]),
  },
  {
    id: "policy-sc-reclaim",
    governance: POLICY_DEVELOPMENT,
    target: { kind: "StorageClass" },
    question: "平台对 StorageClass 的回收策略有什么建议?",
    expectedEvidenceGroups: exactEvidenceGroups(["policy.storageclass.reclaimPolicy.retain.recommended"]),
  },
  {
    id: "policy-secret-plaintext",
    governance: POLICY_DEVELOPMENT,
    target: { kind: "Secret" },
    question: "平台允许在 Secret 里明文存 data 吗?",
    expectedEvidenceGroups: exactEvidenceGroups(["policy.secret.no-plaintext-data.discouraged"]),
  },
  {
    id: "policy-crb-admin",
    governance: POLICY_DEVELOPMENT,
    target: { kind: "ClusterRoleBinding" },
    question: "平台允许给应用工作负载绑定 cluster-admin 吗?",
    expectedEvidenceGroups: exactEvidenceGroups(["policy.clusterrolebinding.no-cluster-admin.forbidden"]),
  },
  {
    id: "policy-ingress-tls",
    governance: POLICY_DEVELOPMENT,
    target: { kind: "Ingress" },
    question: "平台对 Ingress 的 TLS 有什么要求?",
    expectedEvidenceGroups: exactEvidenceGroups(["policy.ingress.tls.required"]),
  },
  {
    id: "policy-conflict-latest",
    governance: POLICY_REGRESSION,
    target: { kind: "Deployment" },
    question: "生产环境我能用 nginx:latest 吗?",
    expectedEvidenceGroups: exactEvidenceGroups(["policy.deployment.image.tag.no-latest"]),
  },
  {
    id: "policy-conflict-nodeport",
    governance: POLICY_DEVELOPMENT,
    target: { kind: "Service" },
    question: "我的 Service 能设 type: NodePort 吗?",
    expectedEvidenceGroups: exactEvidenceGroups(["policy.service.type.nodeport.forbidden"]),
  },
  {
    id: "policy-conflict-privileged",
    governance: POLICY_REGRESSION,
    target: { kind: "Pod" },
    question: "我能给容器开 privileged: true 吗?",
    expectedEvidenceGroups: exactEvidenceGroups(["policy.pod.security.privileged.forbidden"]),
  },
]);
