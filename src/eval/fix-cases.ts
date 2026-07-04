// fix 评估用例:故意坏的 YAML,喂给 fixResource 修。评估单位是"修好没 + 修了几轮 +
// 有没有把资源类型改掉 + 有没有保留用户原意图/字段"(§6.3:fix 尽量保留原字段与意图)。

export interface FixEvalCase {
  id: string;
  /** 什么错(便于阅读) */
  defect: string;
  /** 故意坏的 YAML(至少有一条 schema 校验错) */
  brokenYaml: string;
  /** 修复后仍应是这个 kind(不能为了消错而换资源类型) */
  expectedKind: string;
  /** 意图保留:修复后这些 (path,value) 必须仍在(数组段展开) */
  mustPreserve: Array<{ path: string; value: unknown }>;
}

export const FIX_CASES: FixEvalCase[] = [
  {
    id: 'fix-type-replicas',
    defect: 'replicas 填成字符串',
    brokenYaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: "3"
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: nginx
          image: nginx:1.27
`,
    expectedKind: 'Deployment',
    mustPreserve: [
      { path: 'metadata.name', value: 'web' },
      { path: 'spec.template.spec.containers.image', value: 'nginx:1.27' },
    ],
  },
  {
    id: 'fix-enum-imagepullpolicy',
    defect: 'imagePullPolicy 非法枚举 Sometimes',
    brokenYaml: `apiVersion: v1
kind: Pod
metadata:
  name: cache
spec:
  containers:
    - name: redis
      image: redis:7
      imagePullPolicy: Sometimes
`,
    expectedKind: 'Pod',
    mustPreserve: [
      { path: 'metadata.name', value: 'cache' },
      { path: 'spec.containers.image', value: 'redis:7' },
    ],
  },
  {
    id: 'fix-missing-provisioner',
    defect: 'StorageClass 缺 required provisioner',
    brokenYaml: `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
`,
    expectedKind: 'StorageClass',
    mustPreserve: [
      { path: 'metadata.name', value: 'fast' },
      { path: 'reclaimPolicy', value: 'Retain' },
    ],
  },
  {
    id: 'fix-wrong-nesting',
    defect: 'Deployment 把 containers 放在 spec 下(应在 spec.template.spec)',
    brokenYaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  containers:
    - name: nginx
      image: nginx:1.27
`,
    expectedKind: 'Deployment',
    mustPreserve: [
      { path: 'metadata.name', value: 'web' },
      { path: 'spec.template.spec.containers.image', value: 'nginx:1.27' },
    ],
  },
  {
    id: 'fix-map-array-value',
    defect: 'Service selector 的值填成数组',
    brokenYaml: `apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: [web]
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP
`,
    expectedKind: 'Service',
    mustPreserve: [
      { path: 'metadata.name', value: 'web' },
      { path: 'spec.ports.targetPort', value: 8080 },
    ],
  },
  {
    id: 'fix-typo-field',
    defect: 'provisioner 拼成 provisionr(未知字段 + 缺 required)',
    brokenYaml: `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
provisionr: ebs.csi.aws.com
allowVolumeExpansion: true
`,
    expectedKind: 'StorageClass',
    mustPreserve: [
      { path: 'metadata.name', value: 'gp3' },
      { path: 'allowVolumeExpansion', value: true },
    ],
  },
  {
    id: 'fix-bad-accessmode',
    defect: 'PVC accessModes 非法枚举 ReadWrite',
    brokenYaml: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
spec:
  accessModes:
    - ReadWrite
  resources:
    requests:
      storage: 10Gi
`,
    expectedKind: 'PersistentVolumeClaim',
    mustPreserve: [{ path: 'metadata.name', value: 'data' }],
  },
];
