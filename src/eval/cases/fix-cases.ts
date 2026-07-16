import type { FixCase } from '../assertions';

export type { DefectType, FixCase } from '../assertions';

export const FIX_CASES: FixCase[] = [
  {
    id: 'fix-type-replicas',
    defectType: 'type_error',
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
    target: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
    preserve: [
      { type: 'equals', path: 'spec.selector.matchLabels.app', value: 'web' },
      { type: 'equals', path: 'spec.template.metadata.labels.app', value: 'web' },
      {
        type: 'matches',
        path: 'spec.template.spec.containers',
        rule: {
          name: 'array_contains_object',
          value: { name: 'nginx', image: 'nginx:1.27' },
        },
      },
    ],
    expectedCorrections: [
      { type: 'equals', path: 'spec.replicas', value: 3 },
    ],
  },
  {
    id: 'fix-enum-imagepullpolicy',
    defectType: 'enum_error',
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
    target: { apiVersion: 'v1', kind: 'Pod', name: 'cache' },
    preserve: [
      {
        type: 'matches',
        path: 'spec.containers',
        rule: {
          name: 'array_contains_object',
          value: { name: 'redis', image: 'redis:7' },
        },
      },
    ],
    expectedCorrections: [
      {
        type: 'matches',
        path: 'spec.containers',
        rule: {
          name: 'array_contains_object',
          value: {
            name: 'redis',
            image: 'redis:7',
            imagePullPolicy: 'IfNotPresent',
          },
        },
      },
    ],
  },
  {
    id: 'fix-missing-provisioner',
    defectType: 'missing_required',
    brokenYaml: `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
`,
    target: {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      name: 'fast',
    },
    preserve: [
      { type: 'equals', path: 'reclaimPolicy', value: 'Retain' },
      {
        type: 'equals',
        path: 'volumeBindingMode',
        value: 'WaitForFirstConsumer',
      },
    ],
    expectedCorrections: [{ type: 'exists', path: 'provisioner' }],
  },
  {
    id: 'fix-wrong-nesting',
    defectType: 'unknown_field',
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
    target: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
    preserve: [
      { type: 'equals', path: 'spec.replicas', value: 2 },
      { type: 'equals', path: 'spec.selector.matchLabels.app', value: 'web' },
      {
        type: 'matches',
        path: 'spec.template.spec.containers',
        rule: {
          name: 'array_contains_object',
          value: { name: 'nginx', image: 'nginx:1.27' },
        },
      },
    ],
    expectedCorrections: [
      {
        type: 'matches',
        path: 'spec.containers',
        rule: { name: 'missing_or_empty' },
      },
      {
        type: 'matches',
        path: 'spec.template.spec.containers',
        rule: {
          name: 'array_contains_object',
          value: { name: 'nginx', image: 'nginx:1.27' },
        },
      },
    ],
  },
  {
    id: 'fix-map-array-value',
    defectType: 'type_error',
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
    target: { apiVersion: 'v1', kind: 'Service', name: 'web' },
    preserve: [
      {
        type: 'matches',
        path: 'spec.ports',
        rule: {
          name: 'array_contains_object',
          value: { port: 80, targetPort: 8080 },
        },
      },
      { type: 'equals', path: 'spec.type', value: 'ClusterIP' },
    ],
    expectedCorrections: [
      { type: 'equals', path: 'spec.selector.app', value: 'web' },
    ],
  },
  {
    id: 'fix-typo-field',
    defectType: 'unknown_field',
    brokenYaml: `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
provisionr: ebs.csi.aws.com
allowVolumeExpansion: true
`,
    target: {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      name: 'gp3',
    },
    preserve: [
      { type: 'equals', path: 'allowVolumeExpansion', value: true },
    ],
    expectedCorrections: [
      {
        type: 'equals',
        path: 'provisioner',
        value: 'ebs.csi.aws.com',
      },
      {
        type: 'matches',
        path: 'provisionr',
        rule: { name: 'missing_or_empty' },
      },
    ],
  },
  {
    id: 'fix-bad-accessmode',
    defectType: 'enum_error',
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
    target: {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      name: 'data',
    },
    preserve: [
      {
        type: 'equals',
        path: 'spec.resources.requests.storage',
        value: '10Gi',
      },
    ],
    expectedCorrections: [
      {
        type: 'equals',
        path: 'spec.accessModes',
        value: ['ReadWriteOnce'],
      },
    ],
  },
  {
    id: 'fix-parse-error',
    defectType: 'parse_error',
    brokenYaml: `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data: {LOG_LEVEL: info, TIMEOUT: "30"
`,
    target: { apiVersion: 'v1', kind: 'ConfigMap', name: 'app-config' },
    preserve: [
      { type: 'equals', path: 'data.LOG_LEVEL', value: 'info' },
      { type: 'equals', path: 'data.TIMEOUT', value: '30' },
    ],
    expectedCorrections: [{ type: 'exists', path: 'data' }],
  },
];
