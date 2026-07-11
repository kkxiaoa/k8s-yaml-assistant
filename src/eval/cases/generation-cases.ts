// 生成评估用例。与 retrieval case 分开:评估单位是 parse / schema 校验 /
// kind 匹配 / 必备路径覆盖 / 一致性,而不是"命中哪个 chunk"。
// 单资源为主;多资源一致性用例(consistencyChecks)由 4b 补充。

export type ConsistencyCheck =
  | 'selector_label_match' // Deployment.spec.selector 与 template.labels 一致
  | 'service_target_port_match' // Service.targetPort 命中 Pod containerPort
  | 'ingress_service_match'; // Ingress backend service 名存在于同批 Service

export interface GenerationEvalCase {
  id: string;
  requirement: string;
  /** 生成结果应包含的 kind(全部必须出现) */
  expectedKinds: string[];
  /** 应存在的字段路径(数组段自动对元素展开,如 spec.template.spec.containers.image) */
  mustHavePaths: string[];
  /** 跨资源一致性检查(4b) */
  consistencyChecks?: ConsistencyCheck[];
}

export const GENERATION_CASES: GenerationEvalCase[] = [
  {
    id: 'deploy-basic',
    requirement: '名为 web 的 Deployment,3 副本,镜像 nginx:1.27,容器端口 80',
    expectedKinds: ['Deployment'],
    mustHavePaths: [
      'metadata.name',
      'spec.replicas',
      'spec.selector',
      'spec.template.spec.containers.image',
      'spec.template.spec.containers.ports.containerPort',
    ],
  },
  {
    id: 'sts-basic',
    requirement:
      '名为 db 的 StatefulSet,关联 headless service db,3 副本,镜像 postgres:16,每副本 10Gi 存储',
    expectedKinds: ['StatefulSet'],
    mustHavePaths: [
      'spec.serviceName',
      'spec.replicas',
      'spec.volumeClaimTemplates',
      'spec.template.spec.containers.image',
    ],
  },
  {
    id: 'svc-clusterip',
    requirement: '名为 web 的 ClusterIP Service,选择 app=web,端口 80 转发到 8080',
    expectedKinds: ['Service'],
    mustHavePaths: [
      'spec.type',
      'spec.selector',
      'spec.ports.port',
      'spec.ports.targetPort',
    ],
  },
  {
    id: 'configmap-basic',
    requirement: '名为 app-config 的 ConfigMap,包含 LOG_LEVEL=info、TIMEOUT=30',
    expectedKinds: ['ConfigMap'],
    mustHavePaths: ['metadata.name', 'data'],
  },
  {
    id: 'secret-basic',
    requirement: '名为 db-secret 的 Opaque Secret,stringData 里 password=s3cr3t',
    expectedKinds: ['Secret'],
    mustHavePaths: ['metadata.name', 'type', 'stringData'],
  },
  {
    id: 'pvc-basic',
    requirement: '名为 data 的 PVC,访问模式 ReadWriteOnce,申请 10Gi',
    expectedKinds: ['PersistentVolumeClaim'],
    mustHavePaths: ['spec.accessModes', 'spec.resources.requests'],
  },
  {
    id: 'job-basic',
    requirement: '名为 migrate 的 Job,镜像 busybox 执行迁移,完成 1 次,失败重试 3 次',
    expectedKinds: ['Job'],
    mustHavePaths: [
      'spec.backoffLimit',
      'spec.template.spec.containers.image',
      'spec.template.spec.restartPolicy',
    ],
  },
  {
    id: 'cronjob-basic',
    requirement: '每天 0 点执行的 CronJob,名为 report,镜像 busybox 打印 hello',
    expectedKinds: ['CronJob'],
    mustHavePaths: [
      'spec.schedule',
      'spec.jobTemplate.spec.template.spec.containers.image',
    ],
  },
  {
    id: 'hpa-basic',
    requirement:
      '对名为 web 的 Deployment 做 HPA,副本 2 到 10,CPU 利用率目标 80%',
    expectedKinds: ['HorizontalPodAutoscaler'],
    mustHavePaths: [
      'spec.scaleTargetRef',
      'spec.minReplicas',
      'spec.maxReplicas',
      'spec.metrics',
    ],
  },
  {
    id: 'ingress-basic',
    requirement:
      '名为 web 的 Ingress,host example.com,Prefix 路径 / 转发到 service web 的 80 端口',
    expectedKinds: ['Ingress'],
    mustHavePaths: ['spec.rules.host', 'spec.rules.http.paths.pathType'],
  },
  {
    id: 'sa-basic',
    requirement: '名为 ci-runner 的 ServiceAccount,关闭 token 自动挂载',
    expectedKinds: ['ServiceAccount'],
    mustHavePaths: ['metadata.name', 'automountServiceAccountToken'],
  },
  {
    id: 'netpol-basic',
    requirement:
      '名为 deny-ingress 的 NetworkPolicy,选中 app=web 的 Pod,默认拒绝所有入站',
    expectedKinds: ['NetworkPolicy'],
    mustHavePaths: ['spec.podSelector', 'spec.policyTypes'],
  },
  {
    id: 'pdb-basic',
    requirement:
      '名为 web-pdb 的 PodDisruptionBudget,选中 app=web,至少保留 2 个可用',
    expectedKinds: ['PodDisruptionBudget'],
    mustHavePaths: ['spec.minAvailable', 'spec.selector'],
  },
  {
    id: 'storageclass-basic',
    requirement:
      '名为 fast-ssd 的 StorageClass,provisioner ebs.csi.aws.com,回收策略 Retain,延迟绑定,允许扩容',
    expectedKinds: ['StorageClass'],
    mustHavePaths: [
      'provisioner',
      'reclaimPolicy',
      'volumeBindingMode',
      'allowVolumeExpansion',
    ],
  },
  {
    id: 'role-basic',
    requirement:
      '名为 pod-reader 的 Role,允许对 pods 执行 get、list、watch',
    expectedKinds: ['Role'],
    mustHavePaths: ['rules', 'rules.verbs', 'rules.resources'],
  },

  // ── 多资源(§6.3 一致性;consistencyChecks 度量由 4b 计算)──────────────
  {
    id: 'multi-deploy-svc',
    requirement:
      '名为 web 的 Deployment(3 副本,镜像 nginx:1.27,容器端口 80,标签 app=web),' +
      '再配一个 ClusterIP Service(名 web,选择 app=web,端口 80 转发到容器端口 80)',
    expectedKinds: ['Deployment', 'Service'],
    mustHavePaths: [
      'spec.selector',
      'spec.template.spec.containers.ports.containerPort',
      'spec.ports.targetPort',
    ],
    consistencyChecks: ['selector_label_match', 'service_target_port_match'],
  },
  {
    id: 'multi-deploy-svc-ingress',
    requirement:
      '一套 web 应用:Deployment(2 副本,镜像 myapp:1.0,容器端口 8080,标签 app=myapp),' +
      'ClusterIP Service(选择 app=myapp,端口 80 转 8080),' +
      'Ingress(host myapp.example.com,Prefix / 转发到该 Service 的 80 端口)',
    expectedKinds: ['Deployment', 'Service', 'Ingress'],
    mustHavePaths: [
      'spec.template.spec.containers.ports.containerPort',
      'spec.ports.targetPort',
      'spec.rules.http.paths.backend.service.name',
    ],
    consistencyChecks: [
      'selector_label_match',
      'service_target_port_match',
      'ingress_service_match',
    ],
  },
  {
    id: 'multi-api-deploy-svc',
    requirement:
      '名为 api 的 Deployment(2 副本,镜像 registry/api:1.2,容器端口 9000,标签 app=api、tier=backend),' +
      '配 ClusterIP Service api 选择 app=api,端口 8080 转发到 9000',
    expectedKinds: ['Deployment', 'Service'],
    mustHavePaths: [
      'spec.selector',
      'spec.template.spec.containers.ports.containerPort',
      'spec.ports.targetPort',
    ],
    consistencyChecks: ['selector_label_match', 'service_target_port_match'],
  },
  {
    id: 'multi-sts-headless',
    requirement:
      '名为 redis 的 StatefulSet(3 副本,镜像 redis:7,容器端口 6379,标签 app=redis,serviceName 为 redis),' +
      '再配一个 headless Service redis(clusterIP: None,选择 app=redis,端口 6379)',
    expectedKinds: ['StatefulSet', 'Service'],
    mustHavePaths: [
      'spec.serviceName',
      'spec.template.spec.containers.ports.containerPort',
      'spec.ports.port',
    ],
    consistencyChecks: ['selector_label_match', 'service_target_port_match'],
  },
  {
    id: 'multi-app-configmap',
    requirement:
      '名为 web 的 Deployment(镜像 nginx,标签 app=web)通过 envFrom 引用名为 web-config 的 ConfigMap,' +
      '并生成该 ConfigMap(含 LOG_LEVEL=info)',
    expectedKinds: ['Deployment', 'ConfigMap'],
    mustHavePaths: ['spec.template.spec.containers.image', 'data'],
  },
  {
    id: 'multi-hpa-deploy',
    requirement:
      '名为 web 的 Deployment(2 副本,镜像 nginx:1.27,容器端口 80),' +
      '再配针对它的 HPA(副本 2 到 10,CPU 利用率 80%)',
    expectedKinds: ['Deployment', 'HorizontalPodAutoscaler'],
    mustHavePaths: ['spec.maxReplicas', 'spec.scaleTargetRef', 'spec.replicas'],
  },

  // ── 难例:深字段/枚举/多容器/探针,考验内容正确性与自检修复 ──────────
  {
    id: 'hard-pod-multi-container',
    requirement:
      '名为 sidecar-pod 的 Pod,两个容器:app(镜像 myapp:1.0,端口 8080)和 log-agent(镜像 fluentd:1.16);restartPolicy 设为 Never',
    expectedKinds: ['Pod'],
    mustHavePaths: [
      'spec.containers.image',
      'spec.containers.ports.containerPort',
      'spec.restartPolicy',
    ],
  },
  {
    id: 'hard-deploy-probes-resources',
    requirement:
      '名为 api 的 Deployment,镜像 api:2.0,容器端口 8080;存活探针 HTTP GET /healthz 端口 8080,就绪探针 TCP 8080;资源 limits cpu 500m 内存 256Mi、requests cpu 100m 内存 128Mi',
    expectedKinds: ['Deployment'],
    mustHavePaths: [
      'spec.template.spec.containers.livenessProbe.httpGet.path',
      'spec.template.spec.containers.readinessProbe.tcpSocket',
      'spec.template.spec.containers.resources.limits',
      'spec.template.spec.containers.resources.requests',
    ],
  },
  {
    id: 'hard-cronjob-full',
    requirement:
      '名为 cleanup 的 CronJob,每 5 分钟执行;concurrencyPolicy 为 Forbid,保留 3 条成功历史、1 条失败历史;镜像 busybox 执行清理,restartPolicy 为 OnFailure',
    expectedKinds: ['CronJob'],
    mustHavePaths: [
      'spec.schedule',
      'spec.concurrencyPolicy',
      'spec.successfulJobsHistoryLimit',
      'spec.jobTemplate.spec.template.spec.restartPolicy',
    ],
  },
  {
    id: 'hard-hpa-behavior',
    requirement:
      '对名为 web 的 Deployment 做 HPA(autoscaling/v2),副本 2 到 20,基于 CPU 70% 和内存 80% 两个指标;缩容稳定窗口设为 300 秒',
    expectedKinds: ['HorizontalPodAutoscaler'],
    mustHavePaths: [
      'spec.metrics',
      'spec.behavior.scaleDown.stabilizationWindowSeconds',
    ],
  },
  {
    id: 'hard-networkpolicy-rules',
    requirement:
      '名为 web-netpol 的 NetworkPolicy,选中 app=web 的 Pod;允许来自 app=frontend 的 Pod 访问 8080 入站;允许出站到 UDP 53(DNS)',
    expectedKinds: ['NetworkPolicy'],
    mustHavePaths: [
      'spec.podSelector',
      'spec.policyTypes',
      'spec.ingress',
      'spec.egress',
    ],
  },
];
