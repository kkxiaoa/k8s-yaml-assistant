import type { GenerationCaseContract } from '../assertions';
import type { EvalCaseGovernance } from './governance';

export type GenerationEvalCase = GenerationCaseContract;

const GENERATION_DEVELOPMENT = {
  task: 'generation',
  origin: 'human',
  role: 'development',
} as const satisfies EvalCaseGovernance;

const GENERATION_HOLDOUT = {
  task: 'generation',
  origin: 'human',
  role: 'holdout',
} as const satisfies EvalCaseGovernance;

export const GENERATION_CASES: GenerationEvalCase[] = [
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'deploy-basic',
    requirement: '名为 web 的 Deployment,3 副本,镜像 nginx:1.27,容器端口 80',
    expectedResources: [
      {
        ref: 'deployment',
        identity: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
        assertions: [
          { type: 'equals', path: 'spec.replicas', value: 3 },
          {
            type: 'matches',
            path: 'spec.template.spec.containers',
            rule: {
              name: 'array_contains_object',
              value: {
                image: 'nginx:1.27',
                ports: [{ containerPort: 80 }],
              },
            },
          },
        ],
      },
    ],
    relations: [
      {
        type: 'workload_selector_matches_template_labels',
        workloadRef: 'deployment',
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'sts-basic',
    requirement:
      '名为 db 的 StatefulSet,关联 headless service db,3 副本,镜像 postgres:16,每副本 10Gi 存储',
    expectedResources: [
      {
        ref: 'statefulset',
        identity: { apiVersion: 'apps/v1', kind: 'StatefulSet', name: 'db' },
        assertions: [
          { type: 'equals', path: 'spec.serviceName', value: 'db' },
          { type: 'equals', path: 'spec.replicas', value: 3 },
          {
            type: 'matches',
            path: 'spec.template.spec.containers',
            rule: {
              name: 'array_contains_object',
              value: { image: 'postgres:16' },
            },
          },
          {
            type: 'matches',
            path: 'spec.volumeClaimTemplates',
            rule: {
              name: 'array_contains_object',
              value: {
                spec: { resources: { requests: { storage: '10Gi' } } },
              },
            },
          },
        ],
      },
    ],
    relations: [
      {
        type: 'workload_selector_matches_template_labels',
        workloadRef: 'statefulset',
      },
    ],
    rationale: [
      '要求未明确必须同时输出 Service 文档，因此这里只验证 serviceName；headless Service 关系由 multi-sts-headless 覆盖。',
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'svc-clusterip',
    requirement: '名为 web 的 ClusterIP Service,选择 app=web,端口 80 转发到 8080',
    expectedResources: [
      {
        ref: 'service',
        identity: { apiVersion: 'v1', kind: 'Service', name: 'web' },
        assertions: [
          { type: 'equals', path: 'spec.type', value: 'ClusterIP' },
          { type: 'equals', path: 'spec.selector', value: { app: 'web' } },
          {
            type: 'matches',
            path: 'spec.ports',
            rule: {
              name: 'array_contains_object',
              value: { port: 80, targetPort: 8080 },
            },
          },
        ],
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'configmap-basic',
    requirement: '名为 app-config 的 ConfigMap,包含 LOG_LEVEL=info、TIMEOUT=30',
    expectedResources: [
      {
        ref: 'configmap',
        identity: { apiVersion: 'v1', kind: 'ConfigMap', name: 'app-config' },
        assertions: [
          { type: 'equals', path: 'data.LOG_LEVEL', value: 'info' },
          { type: 'equals', path: 'data.TIMEOUT', value: '30' },
        ],
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'secret-basic',
    requirement: '名为 db-secret 的 Opaque Secret,stringData 里 password=s3cr3t',
    expectedResources: [
      {
        ref: 'secret',
        identity: { apiVersion: 'v1', kind: 'Secret', name: 'db-secret' },
        assertions: [
          { type: 'equals', path: 'type', value: 'Opaque' },
          {
            type: 'equals',
            path: 'stringData.password',
            value: 's3cr3t',
          },
        ],
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'pvc-basic',
    requirement: '名为 data 的 PVC,访问模式 ReadWriteOnce,申请 10Gi',
    expectedResources: [
      {
        ref: 'pvc',
        identity: {
          apiVersion: 'v1',
          kind: 'PersistentVolumeClaim',
          name: 'data',
        },
        assertions: [
          {
            type: 'contains',
            path: 'spec.accessModes',
            value: 'ReadWriteOnce',
          },
          {
            type: 'equals',
            path: 'spec.resources.requests.storage',
            value: '10Gi',
          },
        ],
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'job-basic',
    requirement: '名为 migrate 的 Job,镜像 busybox 执行迁移,完成 1 次,失败重试 3 次',
    expectedResources: [
      {
        ref: 'job',
        identity: { apiVersion: 'batch/v1', kind: 'Job', name: 'migrate' },
        assertions: [
          { type: 'equals', path: 'spec.completions', value: 1 },
          { type: 'equals', path: 'spec.backoffLimit', value: 3 },
          {
            type: 'matches',
            path: 'spec.template.spec.containers',
            rule: {
              name: 'array_contains_object',
              value: { image: 'busybox' },
            },
          },
          { type: 'exists', path: 'spec.template.spec.restartPolicy' },
        ],
      },
    ],
    rationale: ['“执行迁移”没有给出稳定的命令或参数文本，因此不猜测具体 command。'],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'cronjob-basic',
    requirement: '每天 0 点执行的 CronJob,名为 report,镜像 busybox 打印 hello',
    expectedResources: [
      {
        ref: 'cronjob',
        identity: { apiVersion: 'batch/v1', kind: 'CronJob', name: 'report' },
        assertions: [
          { type: 'equals', path: 'spec.schedule', value: '0 0 * * *' },
          {
            type: 'matches',
            path: 'spec.jobTemplate.spec.template.spec.containers',
            rule: {
              name: 'array_contains_object',
              value: { image: 'busybox' },
            },
          },
        ],
      },
    ],
    rationale: [
      '打印 hello 可由 command、args 或 shell 表达式实现，没有唯一稳定的字段表示。',
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'hpa-basic',
    requirement:
      '对名为 web 的 Deployment 做 HPA,副本 2 到 10,CPU 利用率目标 80%',
    expectedResources: [
      {
        ref: 'hpa',
        identity: { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler' },
        assertions: [
          {
            type: 'equals',
            path: 'spec.scaleTargetRef',
            value: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
          },
          { type: 'equals', path: 'spec.minReplicas', value: 2 },
          { type: 'equals', path: 'spec.maxReplicas', value: 10 },
          {
            type: 'matches',
            path: 'spec.metrics',
            rule: {
              name: 'array_contains_object',
              value: {
                type: 'Resource',
                resource: {
                  name: 'cpu',
                  target: { type: 'Utilization', averageUtilization: 80 },
                },
              },
            },
          },
        ],
      },
    ],
    rationale: ['要求没有指定 HPA 自身的 metadata.name。'],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'ingress-basic',
    requirement:
      '名为 web 的 Ingress,host example.com,Prefix 路径 / 转发到 service web 的 80 端口',
    expectedResources: [
      {
        ref: 'ingress',
        identity: {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'Ingress',
          name: 'web',
        },
        assertions: [
          {
            type: 'matches',
            path: 'spec.rules',
            rule: {
              name: 'array_contains_object',
              value: {
                host: 'example.com',
                http: {
                  paths: [
                    {
                      path: '/',
                      pathType: 'Prefix',
                      backend: {
                        service: { name: 'web', port: { number: 80 } },
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'sa-basic',
    requirement: '名为 ci-runner 的 ServiceAccount,关闭 token 自动挂载',
    expectedResources: [
      {
        ref: 'serviceaccount',
        identity: { apiVersion: 'v1', kind: 'ServiceAccount', name: 'ci-runner' },
        assertions: [
          {
            type: 'equals',
            path: 'automountServiceAccountToken',
            value: false,
          },
        ],
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'netpol-basic',
    requirement:
      '名为 deny-ingress 的 NetworkPolicy,选中 app=web 的 Pod,默认拒绝所有入站',
    expectedResources: [
      {
        ref: 'networkpolicy',
        identity: {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'NetworkPolicy',
          name: 'deny-ingress',
        },
        assertions: [
          {
            type: 'equals',
            path: 'spec.podSelector.matchLabels',
            value: { app: 'web' },
          },
          { type: 'contains', path: 'spec.policyTypes', value: 'Ingress' },
          {
            type: 'matches',
            path: 'spec.ingress',
            rule: { name: 'missing_or_empty' },
          },
        ],
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'pdb-basic',
    requirement:
      '名为 web-pdb 的 PodDisruptionBudget,选中 app=web,至少保留 2 个可用',
    expectedResources: [
      {
        ref: 'pdb',
        identity: {
          apiVersion: 'policy/v1',
          kind: 'PodDisruptionBudget',
          name: 'web-pdb',
        },
        assertions: [
          { type: 'equals', path: 'spec.minAvailable', value: 2 },
          {
            type: 'equals',
            path: 'spec.selector.matchLabels',
            value: { app: 'web' },
          },
        ],
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'storageclass-basic',
    requirement:
      '名为 fast-ssd 的 StorageClass,provisioner ebs.csi.aws.com,回收策略 Retain,延迟绑定,允许扩容',
    expectedResources: [
      {
        ref: 'storageclass',
        identity: {
          apiVersion: 'storage.k8s.io/v1',
          kind: 'StorageClass',
          name: 'fast-ssd',
        },
        assertions: [
          { type: 'equals', path: 'provisioner', value: 'ebs.csi.aws.com' },
          { type: 'equals', path: 'reclaimPolicy', value: 'Retain' },
          {
            type: 'equals',
            path: 'volumeBindingMode',
            value: 'WaitForFirstConsumer',
          },
          { type: 'equals', path: 'allowVolumeExpansion', value: true },
        ],
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'role-basic',
    requirement:
      '名为 pod-reader 的 Role,允许对 pods 执行 get、list、watch',
    expectedResources: [
      {
        ref: 'role',
        identity: {
          apiVersion: 'rbac.authorization.k8s.io/v1',
          kind: 'Role',
          name: 'pod-reader',
        },
        assertions: [
          {
            type: 'matches',
            path: 'rules',
            rule: {
              name: 'array_contains_object',
              value: {
                apiGroups: [''],
                resources: ['pods'],
                verbs: ['get', 'list', 'watch'],
              },
            },
          },
        ],
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'multi-deploy-svc',
    requirement:
      '名为 web 的 Deployment(3 副本,镜像 nginx:1.27,容器端口 80,标签 app=web),' +
      '再配一个 ClusterIP Service(名 web,选择 app=web,端口 80 转发到容器端口 80)',
    expectedResources: [
      {
        ref: 'deployment',
        identity: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
        assertions: [
          { type: 'equals', path: 'spec.replicas', value: 3 },
          {
            type: 'equals',
            path: 'spec.template.metadata.labels.app',
            value: 'web',
          },
          {
            type: 'matches',
            path: 'spec.template.spec.containers',
            rule: {
              name: 'array_contains_object',
              value: {
                image: 'nginx:1.27',
                ports: [{ containerPort: 80 }],
              },
            },
          },
        ],
      },
      {
        ref: 'service',
        identity: { apiVersion: 'v1', kind: 'Service', name: 'web' },
        assertions: [
          { type: 'equals', path: 'spec.type', value: 'ClusterIP' },
          { type: 'equals', path: 'spec.selector', value: { app: 'web' } },
          {
            type: 'matches',
            path: 'spec.ports',
            rule: {
              name: 'array_contains_object',
              value: { port: 80, targetPort: 80 },
            },
          },
        ],
      },
    ],
    relations: [
      {
        type: 'workload_selector_matches_template_labels',
        workloadRef: 'deployment',
      },
      {
        type: 'service_selector_matches_workload_labels',
        serviceRef: 'service',
        workloadRef: 'deployment',
      },
      {
        type: 'service_target_port_matches_workload_container_port',
        serviceRef: 'service',
        workloadRef: 'deployment',
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'multi-deploy-svc-ingress',
    requirement:
      '一套 web 应用:Deployment(2 副本,镜像 myapp:1.0,容器端口 8080,标签 app=myapp),' +
      'ClusterIP Service(选择 app=myapp,端口 80 转 8080),' +
      'Ingress(host myapp.example.com,Prefix / 转发到该 Service 的 80 端口)',
    expectedResources: [
      {
        ref: 'deployment',
        identity: { apiVersion: 'apps/v1', kind: 'Deployment' },
        assertions: [
          { type: 'equals', path: 'spec.replicas', value: 2 },
          {
            type: 'equals',
            path: 'spec.template.metadata.labels.app',
            value: 'myapp',
          },
          {
            type: 'matches',
            path: 'spec.template.spec.containers',
            rule: {
              name: 'array_contains_object',
              value: {
                image: 'myapp:1.0',
                ports: [{ containerPort: 8080 }],
              },
            },
          },
        ],
      },
      {
        ref: 'service',
        identity: { apiVersion: 'v1', kind: 'Service' },
        assertions: [
          { type: 'equals', path: 'spec.type', value: 'ClusterIP' },
          { type: 'equals', path: 'spec.selector', value: { app: 'myapp' } },
          {
            type: 'matches',
            path: 'spec.ports',
            rule: {
              name: 'array_contains_object',
              value: { port: 80, targetPort: 8080 },
            },
          },
        ],
      },
      {
        ref: 'ingress',
        identity: { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress' },
        assertions: [
          {
            type: 'matches',
            path: 'spec.rules',
            rule: {
              name: 'array_contains_object',
              value: {
                host: 'myapp.example.com',
                http: {
                  paths: [
                    {
                      path: '/',
                      pathType: 'Prefix',
                      backend: { service: { port: { number: 80 } } },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    ],
    relations: [
      {
        type: 'workload_selector_matches_template_labels',
        workloadRef: 'deployment',
      },
      {
        type: 'service_selector_matches_workload_labels',
        serviceRef: 'service',
        workloadRef: 'deployment',
      },
      {
        type: 'service_target_port_matches_workload_container_port',
        serviceRef: 'service',
        workloadRef: 'deployment',
      },
      {
        type: 'ingress_backend_matches_service',
        ingressRef: 'ingress',
        serviceRef: 'service',
      },
    ],
    rationale: ['要求未明确 Deployment、Service 和 Ingress 各自的 metadata.name。'],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'multi-api-deploy-svc',
    requirement:
      '名为 api 的 Deployment(2 副本,镜像 registry/api:1.2,容器端口 9000,标签 app=api、tier=backend),' +
      '配 ClusterIP Service api 选择 app=api,端口 8080 转发到 9000',
    expectedResources: [
      {
        ref: 'deployment',
        identity: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api' },
        assertions: [
          { type: 'equals', path: 'spec.replicas', value: 2 },
          {
            type: 'equals',
            path: 'spec.template.metadata.labels',
            value: { app: 'api', tier: 'backend' },
          },
          {
            type: 'matches',
            path: 'spec.template.spec.containers',
            rule: {
              name: 'array_contains_object',
              value: {
                image: 'registry/api:1.2',
                ports: [{ containerPort: 9000 }],
              },
            },
          },
        ],
      },
      {
        ref: 'service',
        identity: { apiVersion: 'v1', kind: 'Service', name: 'api' },
        assertions: [
          { type: 'equals', path: 'spec.type', value: 'ClusterIP' },
          { type: 'equals', path: 'spec.selector', value: { app: 'api' } },
          {
            type: 'matches',
            path: 'spec.ports',
            rule: {
              name: 'array_contains_object',
              value: { port: 8080, targetPort: 9000 },
            },
          },
        ],
      },
    ],
    relations: [
      {
        type: 'workload_selector_matches_template_labels',
        workloadRef: 'deployment',
      },
      {
        type: 'service_selector_matches_workload_labels',
        serviceRef: 'service',
        workloadRef: 'deployment',
      },
      {
        type: 'service_target_port_matches_workload_container_port',
        serviceRef: 'service',
        workloadRef: 'deployment',
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'multi-sts-headless',
    requirement:
      '名为 redis 的 StatefulSet(3 副本,镜像 redis:7,容器端口 6379,标签 app=redis,serviceName 为 redis),' +
      '再配一个 headless Service redis(clusterIP: None,选择 app=redis,端口 6379)',
    expectedResources: [
      {
        ref: 'statefulset',
        identity: {
          apiVersion: 'apps/v1',
          kind: 'StatefulSet',
          name: 'redis',
        },
        assertions: [
          { type: 'equals', path: 'spec.replicas', value: 3 },
          { type: 'equals', path: 'spec.serviceName', value: 'redis' },
          {
            type: 'equals',
            path: 'spec.template.metadata.labels.app',
            value: 'redis',
          },
          {
            type: 'matches',
            path: 'spec.template.spec.containers',
            rule: {
              name: 'array_contains_object',
              value: {
                image: 'redis:7',
                ports: [{ containerPort: 6379 }],
              },
            },
          },
        ],
      },
      {
        ref: 'service',
        identity: { apiVersion: 'v1', kind: 'Service', name: 'redis' },
        assertions: [
          { type: 'equals', path: 'spec.clusterIP', value: 'None' },
          { type: 'equals', path: 'spec.selector', value: { app: 'redis' } },
          {
            type: 'matches',
            path: 'spec.ports',
            rule: {
              name: 'array_contains_object',
              value: { port: 6379 },
            },
          },
        ],
      },
    ],
    relations: [
      {
        type: 'workload_selector_matches_template_labels',
        workloadRef: 'statefulset',
      },
      {
        type: 'service_selector_matches_workload_labels',
        serviceRef: 'service',
        workloadRef: 'statefulset',
      },
      {
        type: 'service_target_port_matches_workload_container_port',
        serviceRef: 'service',
        workloadRef: 'statefulset',
      },
      {
        type: 'statefulset_service_name_matches_headless_service',
        statefulSetRef: 'statefulset',
        serviceRef: 'service',
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'multi-app-configmap',
    requirement:
      '名为 web 的 Deployment(镜像 nginx,标签 app=web)通过 envFrom 引用名为 web-config 的 ConfigMap,' +
      '并生成该 ConfigMap(含 LOG_LEVEL=info)',
    expectedResources: [
      {
        ref: 'deployment',
        identity: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
        assertions: [
          {
            type: 'equals',
            path: 'spec.template.metadata.labels.app',
            value: 'web',
          },
          {
            type: 'matches',
            path: 'spec.template.spec.containers',
            rule: {
              name: 'array_contains_object',
              value: {
                image: 'nginx',
                envFrom: [{ configMapRef: { name: 'web-config' } }],
              },
            },
          },
        ],
      },
      {
        ref: 'configmap',
        identity: { apiVersion: 'v1', kind: 'ConfigMap', name: 'web-config' },
        assertions: [
          { type: 'equals', path: 'data.LOG_LEVEL', value: 'info' },
        ],
      },
    ],
    relations: [
      {
        type: 'workload_selector_matches_template_labels',
        workloadRef: 'deployment',
      },
      {
        type: 'deployment_config_map_ref_matches',
        deploymentRef: 'deployment',
        configMapRef: 'configmap',
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'multi-hpa-deploy',
    requirement:
      '名为 web 的 Deployment(2 副本,镜像 nginx:1.27,容器端口 80),' +
      '再配针对它的 HPA(副本 2 到 10,CPU 利用率 80%)',
    expectedResources: [
      {
        ref: 'deployment',
        identity: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
        assertions: [
          { type: 'equals', path: 'spec.replicas', value: 2 },
          {
            type: 'matches',
            path: 'spec.template.spec.containers',
            rule: {
              name: 'array_contains_object',
              value: {
                image: 'nginx:1.27',
                ports: [{ containerPort: 80 }],
              },
            },
          },
        ],
      },
      {
        ref: 'hpa',
        identity: { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler' },
        assertions: [
          { type: 'equals', path: 'spec.minReplicas', value: 2 },
          { type: 'equals', path: 'spec.maxReplicas', value: 10 },
          {
            type: 'matches',
            path: 'spec.metrics',
            rule: {
              name: 'array_contains_object',
              value: {
                type: 'Resource',
                resource: {
                  name: 'cpu',
                  target: { type: 'Utilization', averageUtilization: 80 },
                },
              },
            },
          },
        ],
      },
    ],
    relations: [
      {
        type: 'workload_selector_matches_template_labels',
        workloadRef: 'deployment',
      },
      {
        type: 'hpa_target_matches_workload',
        hpaRef: 'hpa',
        workloadRef: 'deployment',
      },
    ],
    rationale: ['要求没有指定 HPA 自身的 metadata.name。'],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'hard-pod-multi-container',
    requirement:
      '名为 sidecar-pod 的 Pod,两个容器:app(镜像 myapp:1.0,端口 8080)和 log-agent(镜像 fluentd:1.16);restartPolicy 设为 Never',
    expectedResources: [
      {
        ref: 'pod',
        identity: { apiVersion: 'v1', kind: 'Pod', name: 'sidecar-pod' },
        assertions: [
          {
            type: 'matches',
            path: 'spec.containers',
            rule: { name: 'array_length_equals', value: 2 },
          },
          {
            type: 'matches',
            path: 'spec.containers',
            rule: {
              name: 'array_contains_object',
              value: {
                name: 'app',
                image: 'myapp:1.0',
                ports: [{ containerPort: 8080 }],
              },
            },
          },
          {
            type: 'matches',
            path: 'spec.containers',
            rule: {
              name: 'array_contains_object',
              value: { name: 'log-agent', image: 'fluentd:1.16' },
            },
          },
          { type: 'equals', path: 'spec.restartPolicy', value: 'Never' },
        ],
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'hard-deploy-probes-resources',
    requirement:
      '名为 api 的 Deployment,镜像 api:2.0,容器端口 8080;存活探针 HTTP GET /healthz 端口 8080,就绪探针 TCP 8080;资源 limits cpu 500m 内存 256Mi、requests cpu 100m 内存 128Mi',
    expectedResources: [
      {
        ref: 'deployment',
        identity: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api' },
        assertions: [
          {
            type: 'matches',
            path: 'spec.template.spec.containers',
            rule: {
              name: 'array_contains_object',
              value: {
                image: 'api:2.0',
                ports: [{ containerPort: 8080 }],
                livenessProbe: {
                  httpGet: { path: '/healthz', port: 8080 },
                },
                readinessProbe: { tcpSocket: { port: 8080 } },
                resources: {
                  limits: { cpu: '500m', memory: '256Mi' },
                  requests: { cpu: '100m', memory: '128Mi' },
                },
              },
            },
          },
        ],
      },
    ],
    relations: [
      {
        type: 'workload_selector_matches_template_labels',
        workloadRef: 'deployment',
      },
    ],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'hard-cronjob-full',
    requirement:
      '名为 cleanup 的 CronJob,每 5 分钟执行;concurrencyPolicy 为 Forbid,保留 3 条成功历史、1 条失败历史;镜像 busybox 执行清理,restartPolicy 为 OnFailure',
    expectedResources: [
      {
        ref: 'cronjob',
        identity: { apiVersion: 'batch/v1', kind: 'CronJob', name: 'cleanup' },
        assertions: [
          { type: 'equals', path: 'spec.schedule', value: '*/5 * * * *' },
          { type: 'equals', path: 'spec.concurrencyPolicy', value: 'Forbid' },
          {
            type: 'equals',
            path: 'spec.successfulJobsHistoryLimit',
            value: 3,
          },
          {
            type: 'equals',
            path: 'spec.failedJobsHistoryLimit',
            value: 1,
          },
          {
            type: 'matches',
            path: 'spec.jobTemplate.spec.template.spec.containers',
            rule: {
              name: 'array_contains_object',
              value: { image: 'busybox' },
            },
          },
          {
            type: 'equals',
            path: 'spec.jobTemplate.spec.template.spec.restartPolicy',
            value: 'OnFailure',
          },
        ],
      },
    ],
    rationale: ['“执行清理”没有给出稳定的命令或参数文本，因此不猜测具体 command。'],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'hard-hpa-behavior',
    requirement:
      '对名为 web 的 Deployment 做 HPA(autoscaling/v2),副本 2 到 20,基于 CPU 70% 和内存 80% 两个指标;缩容稳定窗口设为 300 秒',
    expectedResources: [
      {
        ref: 'hpa',
        identity: { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler' },
        assertions: [
          {
            type: 'equals',
            path: 'spec.scaleTargetRef',
            value: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
          },
          { type: 'equals', path: 'spec.minReplicas', value: 2 },
          { type: 'equals', path: 'spec.maxReplicas', value: 20 },
          {
            type: 'matches',
            path: 'spec.metrics',
            rule: {
              name: 'array_contains_object',
              value: {
                type: 'Resource',
                resource: {
                  name: 'cpu',
                  target: { type: 'Utilization', averageUtilization: 70 },
                },
              },
            },
          },
          {
            type: 'matches',
            path: 'spec.metrics',
            rule: {
              name: 'array_contains_object',
              value: {
                type: 'Resource',
                resource: {
                  name: 'memory',
                  target: { type: 'Utilization', averageUtilization: 80 },
                },
              },
            },
          },
          {
            type: 'equals',
            path: 'spec.behavior.scaleDown.stabilizationWindowSeconds',
            value: 300,
          },
        ],
      },
    ],
    rationale: ['要求没有指定 HPA 自身的 metadata.name。'],
  },
  {
    governance: GENERATION_DEVELOPMENT,
    id: 'hard-networkpolicy-rules',
    requirement:
      '名为 web-netpol 的 NetworkPolicy,选中 app=web 的 Pod;允许来自 app=frontend 的 Pod 访问 8080 入站;允许出站到 UDP 53(DNS)',
    expectedResources: [
      {
        ref: 'networkpolicy',
        identity: {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'NetworkPolicy',
          name: 'web-netpol',
        },
        assertions: [
          {
            type: 'equals',
            path: 'spec.podSelector.matchLabels',
            value: { app: 'web' },
          },
          { type: 'contains', path: 'spec.policyTypes', value: 'Ingress' },
          { type: 'contains', path: 'spec.policyTypes', value: 'Egress' },
          {
            type: 'matches',
            path: 'spec.ingress',
            rule: {
              name: 'array_contains_object',
              value: {
                from: [{ podSelector: { matchLabels: { app: 'frontend' } } }],
                ports: [{ port: 8080 }],
              },
            },
          },
          {
            type: 'matches',
            path: 'spec.egress',
            rule: {
              name: 'array_contains_object',
              value: { ports: [{ protocol: 'UDP', port: 53 }] },
            },
          },
        ],
      },
    ],
  },
  {
    governance: GENERATION_HOLDOUT,
    id: 'daemonset-holdout',
    requirement:
      '生成名为 node-agent 的 DaemonSet,容器名为 node-agent,镜像 registry.example.com/ops/node-agent:1.0,selector 和 Pod 模板标签均为 app=node-agent',
    expectedResources: [
      {
        ref: 'daemonset',
        identity: {
          apiVersion: 'apps/v1',
          kind: 'DaemonSet',
          name: 'node-agent',
        },
        assertions: [
          {
            type: 'equals',
            path: 'spec.selector.matchLabels.app',
            value: 'node-agent',
          },
          {
            type: 'equals',
            path: 'spec.template.metadata.labels.app',
            value: 'node-agent',
          },
          {
            type: 'matches',
            path: 'spec.template.spec.containers',
            rule: {
              name: 'array_contains_object',
              value: {
                name: 'node-agent',
                image: 'registry.example.com/ops/node-agent:1.0',
              },
            },
          },
        ],
      },
    ],
    relations: [
      {
        type: 'workload_selector_matches_template_labels',
        workloadRef: 'daemonset',
      },
    ],
  },
];
