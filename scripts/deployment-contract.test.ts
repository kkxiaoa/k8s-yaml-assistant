import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { loadAll } from 'js-yaml';
import { z } from 'zod';
import {
  DEEPSEEK_ANSWER_MODEL,
  VOYAGE_RERANK_MODEL,
} from '../src/server/runtime-config';
import { RELEASE_INDEX_EMBEDDING_MODEL } from '../src/release/manifest';

const root = process.cwd();
const k3sDir = join(root, 'deploy', 'k3s');
const adapterDir = join(root, 'deploy', 'adapter');
const kubernetesDir = join(root, 'deploy', 'k8s');
const bootstrapDir = join(kubernetesDir, 'bootstrap');
const applicationDir = join(kubernetesDir, 'app');
const readmePath = join(k3sDir, 'README.md');
const configPath = join(k3sDir, 'config.yaml');
const admissionConfigPath = join(k3sDir, 'admission-config.yaml');
const kubernetesReadmePath = join(kubernetesDir, 'README.md');
const deploymentTemplatePath = join(
  applicationDir,
  'deployment-template.yaml',
);
const productionNamespace = 'k8s-yaml-assistant-prod';
const applicationName = 'k8s-yaml-assistant';
const observationClaimName = 'k8s-yaml-assistant-observation';
const imageMarker = '__K8S_YAML_ASSISTANT_IMAGE__';
const applicationImage = 'ghcr.io/kkxiaoa/k8s-yaml-assistant';
const deepSeekSecretName = 'deepseek-runtime';
const voyageSecretName = 'voyage-runtime';
const imagePullSecretName = 'ghcr-pull';
const bootstrapManifestPaths = [
  'namespace.yaml',
  'service-account.yaml',
  'config-map.yaml',
  'service.yaml',
  'observation-pvc.yaml',
  'network-policy.yaml',
].map((name) => join(bootstrapDir, name));
const expectedRuntimeConfig = {
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
  DEEPSEEK_ANSWER_MODEL,
  VOYAGE_EMBEDDING_URL: 'https://api.voyageai.com/v1/embeddings',
  VOYAGE_RERANK_URL: 'https://api.voyageai.com/v1/rerank',
  VOYAGE_EMBEDDING_MODEL: RELEASE_INDEX_EMBEDDING_MODEL,
  VOYAGE_RERANK_MODEL,
  INDEX_DIR: '/app/data/index',
  ENABLE_QUERY_EXPANSION: 'true',
  ACCESS_MODE: 'private',
  NODE_ENV: 'production',
  PORT: '3000',
  HOSTNAME: '0.0.0.0',
  SERVING_OBSERVATION_MODE: 'local',
  SERVING_OBSERVATION_SAMPLE_RATE: '1',
  SERVING_OBSERVATION_MAX_FILE_BYTES: '16777216',
  SERVING_OBSERVATION_MAX_TOTAL_BYTES: '268435456',
  SERVING_OBSERVATION_RETENTION_DAYS: '7',
  SERVING_OBSERVATION_MAX_INPUT_BYTES: '131072',
  SERVING_OBSERVATION_MAX_TEXT_BYTES: '8192',
} as const;
const applicationMetadata = {
  name: applicationName,
  namespace: productionNamespace,
} as const;
const expectedNamespaceResource = {
  apiVersion: 'v1',
  kind: 'Namespace',
  metadata: {
    name: productionNamespace,
    labels: {
      'pod-security.kubernetes.io/enforce': 'restricted',
      'pod-security.kubernetes.io/enforce-version': 'v1.36',
      'pod-security.kubernetes.io/audit': 'restricted',
      'pod-security.kubernetes.io/audit-version': 'v1.36',
      'pod-security.kubernetes.io/warn': 'restricted',
      'pod-security.kubernetes.io/warn-version': 'v1.36',
    },
  },
} as const;
const expectedServiceAccountResource = {
  apiVersion: 'v1',
  kind: 'ServiceAccount',
  metadata: applicationMetadata,
  automountServiceAccountToken: false,
} as const;
const expectedConfigMapResource = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: applicationMetadata,
  data: expectedRuntimeConfig,
} as const;
const expectedServiceResource = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: applicationMetadata,
  spec: {
    type: 'ClusterIP',
    selector: {
      'app.kubernetes.io/name': applicationName,
    },
    ports: [
      {
        name: 'http',
        protocol: 'TCP',
        port: 80,
        targetPort: 'http',
        appProtocol: 'http',
      },
    ],
  },
} as const;
const expectedObservationClaimResource = {
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  metadata: {
    name: observationClaimName,
    namespace: productionNamespace,
  },
  spec: {
    accessModes: ['ReadWriteOnce'],
    volumeMode: 'Filesystem',
    storageClassName: 'local-path',
    resources: {
      requests: {
        storage: '1Gi',
      },
    },
  },
} as const;
const expectedNetworkPolicyResource = {
  apiVersion: 'networking.k8s.io/v1',
  kind: 'NetworkPolicy',
  metadata: applicationMetadata,
  spec: {
    podSelector: {
      matchLabels: {
        'app.kubernetes.io/name': applicationName,
      },
    },
    policyTypes: ['Ingress', 'Egress'],
    ingress: [
      {
        from: [
          {
            namespaceSelector: {
              matchLabels: {
                'kubernetes.io/metadata.name': 'kube-system',
              },
            },
            podSelector: {
              matchLabels: {
                'app.kubernetes.io/name': 'traefik',
              },
            },
          },
        ],
        ports: [
          {
            protocol: 'TCP',
            port: 3000,
          },
        ],
      },
    ],
    egress: [
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: {
                'kubernetes.io/metadata.name': 'kube-system',
              },
            },
            podSelector: {
              matchLabels: {
                'k8s-app': 'kube-dns',
              },
            },
          },
        ],
        ports: [
          {
            protocol: 'UDP',
            port: 53,
          },
          {
            protocol: 'TCP',
            port: 53,
          },
        ],
      },
      {
        to: [
          {
            ipBlock: {
              cidr: '0.0.0.0/0',
              except: [
                '10.0.0.0/8',
                '100.64.0.0/10',
                '127.0.0.0/8',
                '169.254.0.0/16',
                '172.16.0.0/12',
                '192.168.0.0/16',
              ],
            },
          },
        ],
        ports: [
          {
            protocol: 'TCP',
            port: 443,
          },
        ],
      },
    ],
  },
} as const;
const expectedBootstrapResources = [
  expectedNamespaceResource,
  expectedServiceAccountResource,
  expectedConfigMapResource,
  expectedServiceResource,
  expectedObservationClaimResource,
  expectedNetworkPolicyResource,
] as const;
const expectedDeploymentResource = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: applicationMetadata,
  spec: {
    replicas: 1,
    revisionHistoryLimit: 3,
    minReadySeconds: 10,
    progressDeadlineSeconds: 600,
    strategy: {
      type: 'RollingUpdate',
      rollingUpdate: {
        maxSurge: 0,
        maxUnavailable: 1,
      },
    },
    selector: {
      matchLabels: {
        'app.kubernetes.io/name': applicationName,
      },
    },
    template: {
      metadata: {
        labels: {
          'app.kubernetes.io/name': applicationName,
        },
      },
      spec: {
        serviceAccountName: applicationName,
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        terminationGracePeriodSeconds: 60,
        imagePullSecrets: [
          {
            name: imagePullSecretName,
          },
        ],
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 10001,
          runAsGroup: 10001,
          fsGroup: 10001,
          fsGroupChangePolicy: 'OnRootMismatch',
          seccompProfile: {
            type: 'RuntimeDefault',
          },
        },
        containers: [
          {
            name: 'app',
            image: imageMarker,
            imagePullPolicy: 'IfNotPresent',
            ports: [
              {
                name: 'http',
                containerPort: 3000,
                protocol: 'TCP',
              },
            ],
            envFrom: [
              {
                configMapRef: {
                  name: applicationName,
                },
              },
            ],
            env: [
              {
                name: 'DEEPSEEK_API_KEY',
                valueFrom: {
                  secretKeyRef: {
                    name: deepSeekSecretName,
                    key: 'api-key',
                  },
                },
              },
              {
                name: 'VOYAGE_API_KEY',
                valueFrom: {
                  secretKeyRef: {
                    name: voyageSecretName,
                    key: 'api-key',
                  },
                },
              },
            ],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: {
                drop: ['ALL'],
              },
            },
            resources: {
              requests: {
                cpu: '500m',
                memory: '768Mi',
                'ephemeral-storage': '256Mi',
              },
              limits: {
                cpu: '2',
                memory: '2Gi',
                'ephemeral-storage': '1Gi',
              },
            },
            startupProbe: {
              httpGet: {
                path: '/api/health/ready',
                port: 'http',
                scheme: 'HTTP',
              },
              periodSeconds: 5,
              timeoutSeconds: 2,
              failureThreshold: 60,
              successThreshold: 1,
            },
            readinessProbe: {
              httpGet: {
                path: '/api/health/ready',
                port: 'http',
                scheme: 'HTTP',
              },
              periodSeconds: 10,
              timeoutSeconds: 2,
              failureThreshold: 3,
              successThreshold: 1,
            },
            livenessProbe: {
              httpGet: {
                path: '/api/health/live',
                port: 'http',
                scheme: 'HTTP',
              },
              periodSeconds: 30,
              timeoutSeconds: 2,
              failureThreshold: 3,
              successThreshold: 1,
            },
            volumeMounts: [
              {
                name: 'observations',
                mountPath: '/app/data/observability',
              },
              {
                name: 'tmp',
                mountPath: '/tmp',
              },
            ],
          },
        ],
        volumes: [
          {
            name: 'observations',
            persistentVolumeClaim: {
              claimName: observationClaimName,
            },
          },
          {
            name: 'tmp',
            emptyDir: {
              sizeLimit: '64Mi',
            },
          },
        ],
      },
    },
  },
} as const;
const adapterPath = join(adapterDir, 'k8s_yaml_assistant_deploy.py');
const trustedRootPath = join(adapterDir, 'sigstore-trusted-root.json');
const sudoersPath = join(
  adapterDir,
  'k8s-yaml-assistant-deploy.sudoers',
);
const runnerHardeningPath = join(
  adapterDir,
  'actions-runner-hardening.conf',
);
const runnerTmpfilesPath = join(
  adapterDir,
  'k8s-yaml-assistant-deployer.tmpfiles.conf',
);

const trustedRootSha256 =
  '6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66';
const trustedRootSize = 6_787;
const installedTrustedRootPath =
  '/etc/k8s-yaml-assistant-deployer/sigstore-trusted-root.json';
const adapterCommand = '/usr/local/sbin/k8s-yaml-assistant-deploy';
const runnerAccount = 'gha-k8s-yaml-prod';

const expectedSudoersLines = [
  `Defaults:${runnerAccount} env_reset, !setenv`,
  `${runnerAccount} ALL=(root) NOPASSWD: ${adapterCommand} ""`,
] as const;

const expectedRunnerHardeningLines = [
  '[Service]',
  `User=${runnerAccount}`,
  `Group=${runnerAccount}`,
  'UMask=0077',
  'ProtectSystem=strict',
  'ProtectHome=true',
  'PrivateTmp=true',
  'PrivateDevices=true',
  'ProtectKernelTunables=true',
  'ProtectKernelModules=true',
  'ProtectControlGroups=true',
  'ProtectClock=true',
  'ProtectHostname=true',
  'LockPersonality=true',
  'RestrictRealtime=true',
  'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
  'IPAddressDeny=169.254.0.0/16',
  'ReadWritePaths=/var/lib/k8s-yaml-assistant-deployer /run/k8s-yaml-assistant-deployer',
  'TemporaryFileSystem=/opt/actions-runner-k8s-yaml-prod/_work:rw,nosuid,nodev,noexec,size=128M,mode=0700,uid=996,gid=988',
  'TemporaryFileSystem=/opt/actions-runner-k8s-yaml-prod/_diag:rw,nosuid,nodev,noexec,size=32M,mode=0700,uid=996,gid=988',
  'NoNewPrivileges=false',
  'MemoryMax=1G',
  'CPUQuota=200%',
  'TasksMax=256',
] as const;

const expectedRunnerTmpfilesLines = [
  'd /run/k8s-yaml-assistant-deployer 0700 root root -',
] as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const HttpsUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.username === '' && url.password === '';
});
const CidrV4Slash32Schema = z
  .string()
  .regex(/^(?:\d{1,3}\.){3}\d{1,3}\/32$/)
  .refine((value) =>
    value
      .slice(0, -3)
      .split('.')
      .every((part) => Number(part) >= 0 && Number(part) <= 255),
  );

const ArtifactSchema = z
  .object({
    fileName: z.string().min(1),
    sourceUrl: HttpsUrlSchema,
    sha256: Sha256Schema,
  })
  .strict();

const BackupEvidenceObjectSchema = z
  .object({
    objectKey: z
      .string()
      .min(1)
      .refine((value) => !value.startsWith('/') && !value.includes('..')),
    sizeBytes: z.number().int().positive(),
    sha256: Sha256Schema,
  })
  .strict();

const ImplementationEvidenceSchema = z
  .object({
    host: z
      .object({
        operatingSystem: z.literal('ubuntu-24.04.4'),
        kernel: z.literal('6.8.0-136-generic'),
        pendingPackageUpdates: z.literal(0),
      })
      .strict(),
    cluster: z
      .object({
        version: z.literal('v1.36.2+k3s1'),
        nodeReady: z.literal(true),
        nonHealthyPods: z.literal(0),
        apiReady: z.literal(true),
        secretsEncryption: z.literal(true),
        kubeconfigMode: z.literal('0600'),
        podSecurityAdmission: z.literal('restricted-v1.36-dry-run-passed'),
        applicationNamespacesCreated: z.literal(false),
      })
      .strict(),
    network: z
      .object({
        publicTcpPortsVerifiedClosed: z.tuple([
          z.literal(80),
          z.literal(443),
          z.literal(6443),
          z.literal(10250),
          z.literal(30991),
          z.literal(32164),
        ]),
        publicUdp8472Verification: z.literal('security-group-rule'),
      })
      .strict(),
    ssh: z
      .object({
        passwordAuthentication: z.literal(false),
        permitRootLoginEffective: z.literal('without-password'),
        independentKeyLoginVerified: z.literal(true),
        passwordOnlyLoginRejected: z.literal(true),
      })
      .strict(),
    backup: z
      .object({
        backupId: z.string().regex(
          /^\d{8}T\d{6}Z-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
        ),
        obsutilVersion: z.literal('5.8.3'),
        database: BackupEvidenceObjectSchema,
        serverToken: BackupEvidenceObjectSchema,
        manifest: BackupEvidenceObjectSchema,
        servicePauseSeconds: z.number().int().nonnegative(),
        recoverySeconds: z.number().int().nonnegative(),
        writerReadDeniedCount: z.literal(3),
        administratorReadVerified: z.literal(true),
        persistentAccessKey: z.literal(false),
        temporaryFilesRemoved: z.literal(true),
      })
      .strict(),
  })
  .strict();

const ChangePackageSchema = z
  .object({
    status: z.literal('任务 4 已实施；等待审核'),
    purpose: z.string().min(1),
    auditedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    implementedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    release: z
      .object({
        version: z.string().regex(/^v\d+\.\d+\.\d+\+k3s\d+$/),
        kubernetesVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
        architecture: z.literal('amd64'),
        releaseUrl: HttpsUrlSchema,
        checksumManifestUrl: HttpsUrlSchema,
        artifacts: z
          .object({
            installer: ArtifactSchema,
            binary: ArtifactSchema,
            airgapImages: ArtifactSchema,
          })
          .strict(),
      })
      .strict(),
    topology: z
      .object({
        serverCount: z.literal(1),
        datastore: z.literal('sqlite'),
        highAvailability: z.literal(false),
      })
      .strict(),
    hostAudit: z
      .object({
        operatingSystem: z.literal('ubuntu-24.04'),
        architecture: z.literal('amd64'),
        approvedSshSourceCidr: CidrV4Slash32Schema,
        ufw: z.literal('inactive'),
        dockerHubRegistryReachable: z.literal(false),
      })
      .strict(),
    network: z
      .object({
        podCidr: z.literal('10.42.0.0/16'),
        serviceCidr: z.literal('10.43.0.0/16'),
        publicApi6443: z.literal(false),
        publicFlannel8472: z.literal(false),
        publicKubelet10250: z.literal(false),
        publicHttp80: z.literal(false),
        publicHttps443: z.literal(false),
      })
      .strict(),
    sshHardening: z
      .object({
        passwordAuthentication: z.literal(false),
        permitRootLogin: z.literal('prohibit-password'),
      })
      .strict(),
    backup: z
      .object({
        target: z
          .object({
            provider: z.literal('huawei-obs'),
            region: z.literal('cn-north-4'),
            endpoint: z.literal('https://obs.cn-north-4.myhuaweicloud.com'),
            bucket: z.literal(
              'kkx-k8s-yaml-assistant-prod-backup-cn4-20260720',
            ),
            access: z.literal('private'),
            storageClass: z.literal('standard'),
            redundancy: z.literal('multi-az'),
            serverSideEncryption: z.literal('SSE-OBS'),
            versioning: z.literal(true),
            worm: z.literal(false),
          })
          .strict(),
        writerIdentity: z
          .object({
            type: z.literal('ecs-agency'),
            agencyName: z.literal('k3s-prod-obs-backup'),
            policyName: z.literal('k3s-prod-obs-backup-writer'),
            credentialSource: z.literal('instance-metadata'),
            persistentAccessKey: z.literal(false),
            canRead: z.literal(false),
            canDelete: z.literal(false),
          })
          .strict(),
        uploader: z
          .object({
            name: z.literal('obsutil'),
            version: z.literal('5.8.3'),
            artifact: ArtifactSchema,
          })
          .strict(),
        database: z
          .object({
            path: z.literal('/var/lib/rancher/k3s/server/db'),
            backupSet: z.string().min(1),
            objectPrefix: z.literal('k3s-sqlite-database/'),
            encrypted: z.literal(true),
            offNode: z.literal(true),
            containsServerToken: z.literal(false),
          })
          .strict(),
        serverToken: z
          .object({
            path: z.literal('/var/lib/rancher/k3s/server/token'),
            backupSet: z.string().min(1),
            objectPrefix: z.literal('k3s-server-token/'),
            encrypted: z.literal(true),
            offNode: z.literal(true),
            containsDatabase: z.literal(false),
          })
          .strict(),
        manifest: z
          .object({
            objectPrefix: z.literal('manifests/'),
            containsSecrets: z.literal(false),
          })
          .strict(),
        restoreRequiresBoth: z.literal(true),
      })
      .strict(),
    implementationEvidence: ImplementationEvidenceSchema,
  })
  .strict();

const K3sConfigSchema = z
  .object({
    'write-kubeconfig-mode': z.literal('0600'),
    'secrets-encryption': z.literal(true),
    'disable-network-policy': z.literal(false),
    'flannel-backend': z.literal('vxlan'),
    'cluster-cidr': z.literal('10.42.0.0/16'),
    'service-cidr': z.literal('10.43.0.0/16'),
    'kube-apiserver-arg': z.tuple([
      z.literal(
        'admission-control-config-file=/etc/rancher/k3s/admission-config.yaml',
      ),
    ]),
  })
  .strict();

const AdmissionConfigSchema = z
  .object({
    apiVersion: z.literal('apiserver.config.k8s.io/v1'),
    kind: z.literal('AdmissionConfiguration'),
    plugins: z.tuple([
      z
        .object({
          name: z.literal('PodSecurity'),
          configuration: z
            .object({
              apiVersion: z.literal(
                'pod-security.admission.config.k8s.io/v1',
              ),
              kind: z.literal('PodSecurityConfiguration'),
              defaults: z
                .object({
                  enforce: z.literal('restricted'),
                  'enforce-version': z.string().regex(/^v\d+\.\d+$/),
                  audit: z.literal('restricted'),
                  'audit-version': z.string().regex(/^v\d+\.\d+$/),
                  warn: z.literal('restricted'),
                  'warn-version': z.string().regex(/^v\d+\.\d+$/),
                })
                .strict(),
              exemptions: z
                .object({
                  usernames: z.tuple([]),
                  runtimeClasses: z.tuple([]),
                  namespaces: z.tuple([z.literal('kube-system')]),
                })
                .strict(),
            })
            .strict(),
        })
        .strict(),
    ]),
  })
  .strict();

type ChangePackage = z.infer<typeof ChangePackageSchema>;

function parseSingleYaml(text: string, label: string): unknown {
  const documents: unknown[] = [];
  loadAll(text, (document) => documents.push(document));
  assert.equal(documents.length, 1, `${label} must contain exactly one YAML document`);
  return documents[0];
}

function parseReadmeFrontMatter(text: string): unknown {
  assert.ok(text.startsWith('---\n'), 'README.md must start with YAML front matter');
  const end = text.indexOf('\n---\n', 4);
  assert.notEqual(end, -1, 'README.md front matter must have a closing delimiter');
  return parseSingleYaml(text.slice(4, end), 'README.md front matter');
}

function assertNoPlaceholder(value: unknown, path = 'root'): void {
  if (typeof value === 'string') {
    assert.doesNotMatch(
      value,
      /(?:change[_-]?me|replace[_-]?me|placeholder|todo|<[^>\n]+>)/i,
      `${path} contains a placeholder`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPlaceholder(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) =>
      assertNoPlaceholder(item, `${path}.${key}`),
    );
  }
}

type YamlRecord = Record<string, unknown>;

function yamlRecord(value: unknown, label: string): YamlRecord {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as YamlRecord;
}

function yamlArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function nestedRecord(
  parent: YamlRecord,
  key: string,
  label: string,
): YamlRecord {
  return yamlRecord(parent[key], `${label}.${key}`);
}

function resourceMetadata(resource: YamlRecord, label: string): YamlRecord {
  return nestedRecord(resource, 'metadata', label);
}

function readKubernetesResource(path: string): {
  source: string;
  resource: YamlRecord;
} {
  const source = readFileSync(path, 'utf8');
  return {
    source,
    resource: yamlRecord(parseSingleYaml(source, path), path),
  };
}

function validateNamespace(resource: YamlRecord): void {
  assert.deepEqual(resource, expectedNamespaceResource);
}

function validateServiceAccount(resource: YamlRecord): void {
  assert.deepEqual(resource, expectedServiceAccountResource);
}

function validateConfigMap(resource: YamlRecord): void {
  assert.deepEqual(resource, expectedConfigMapResource);
}

function validateService(resource: YamlRecord): void {
  assert.deepEqual(resource, expectedServiceResource);
}

function validateObservationClaim(resource: YamlRecord): void {
  assert.deepEqual(resource, expectedObservationClaimResource);
}

function validateNetworkPolicy(resource: YamlRecord): void {
  assert.deepEqual(resource, expectedNetworkPolicyResource);
}

function validateDeploymentTemplate(
  source: string,
  resource: YamlRecord,
): void {
  assert.equal(source.split(imageMarker).length - 1, 1);
  assert.deepEqual(resource, expectedDeploymentResource);

  const rendered = source.replace(
    imageMarker,
    `${applicationImage}@sha256:${'a'.repeat(64)}`,
  );
  const renderedDeployment = yamlRecord(
    parseSingleYaml(rendered, 'rendered deployment template'),
    'rendered deployment template',
  );
  const renderedSpec = nestedRecord(
    renderedDeployment,
    'spec',
    'rendered Deployment',
  );
  const renderedTemplate = nestedRecord(
    renderedSpec,
    'template',
    'rendered Deployment.spec',
  );
  const renderedPodSpec = nestedRecord(
    renderedTemplate,
    'spec',
    'rendered Deployment.template',
  );
  const renderedContainer = yamlRecord(
    yamlArray(
      renderedPodSpec.containers,
      'rendered Deployment.containers',
    )[0],
    'rendered Deployment.container',
  );
  assert.match(
    String(renderedContainer.image),
    /^ghcr\.io\/kkxiaoa\/k8s-yaml-assistant@sha256:[a-f0-9]{64}$/u,
  );
}

function validateBootstrapResources(resources: readonly YamlRecord[]): void {
  assert.deepEqual(resources, expectedBootstrapResources);
}

function validateKubernetesReadme(source: string): void {
  assert.ok(
    source.startsWith(
      '状态：Task 4（任务 4）已完成实施和 review（审核）；Task 5（任务 5）的生产 runner（运行器）已完成安装、注册和真实 systemd hardening（系统服务加固）验证，当前在线空闲并等待 review（审核）。\n' +
        '用途：定义生产 Kubernetes（容器编排系统）固定非敏感资源、应用模板及其审核和回退边界。\n',
    ),
  );
  for (const required of [
    '仓库只固定引用且不保存 Secret（密钥）值',
    '集群没有应用 Deployment/Pod/Ingress（工作负载 / 容器组 / 入口）',
    'deepseek-runtime',
    'voyage-runtime',
    'ghcr-pull',
    '`api-key`',
    '`kubernetes.io/dockerconfigjson`',
    '同一节点故障域',
    'bootstrap（引导配置）',
    '应用版本',
    '入口资源',
    '标准 NetworkPolicy（网络策略）不能按域名建立可靠 allowlist（允许名单）',
    '--server-side --dry-run=server',
    '--field-manager=k8s-yaml-assistant-bootstrap',
    '上一份已审核的 bootstrap（引导配置）',
  ]) {
    assert.ok(source.includes(required), `Kubernetes README missing: ${required}`);
  }
  assert.doesNotMatch(source, /\bkubectl\s+delete\b/u);
  assert.doesNotMatch(source, /--force-conflicts\b/u);
  assert.doesNotMatch(
    source,
    /NetworkPolicy（网络策略）(?:已经|可以|能够|负责).*域名.*allowlist/u,
  );
  validateNoCredentialMaterial(source);
}

function validateChangePackage(value: unknown): ChangePackage {
  const parsed = ChangePackageSchema.parse(value);
  assertNoPlaceholder(parsed);

  const versionMatch = /^v(\d+)\.(\d+)\.(\d+)\+k3s\d+$/.exec(
    parsed.release.version,
  );
  assert.ok(versionMatch);
  const kubernetesVersion = `v${versionMatch[1]}.${versionMatch[2]}.${versionMatch[3]}`;
  assert.equal(parsed.release.kubernetesVersion, kubernetesVersion);
  assert.equal(parsed.release.architecture, parsed.hostAudit.architecture);

  const encodedVersion = encodeURIComponent(parsed.release.version);
  assert.equal(
    parsed.release.releaseUrl,
    `https://github.com/k3s-io/k3s/releases/tag/${encodedVersion}`,
  );
  assert.equal(
    parsed.release.checksumManifestUrl,
    `https://github.com/k3s-io/k3s/releases/download/${encodedVersion}/sha256sum-amd64.txt`,
  );

  const artifacts = parsed.release.artifacts;
  assert.equal(artifacts.installer.fileName, 'install.sh');
  assert.equal(
    artifacts.installer.sourceUrl,
    `https://raw.githubusercontent.com/k3s-io/k3s/${parsed.release.version}/install.sh`,
  );
  assert.equal(artifacts.binary.fileName, 'k3s');
  assert.equal(
    artifacts.binary.sourceUrl,
    `https://github.com/k3s-io/k3s/releases/download/${encodedVersion}/k3s`,
  );
  assert.equal(artifacts.airgapImages.fileName, 'k3s-airgap-images-amd64.tar.zst');
  assert.equal(
    artifacts.airgapImages.sourceUrl,
    `https://github.com/k3s-io/k3s/releases/download/${encodedVersion}/k3s-airgap-images-amd64.tar.zst`,
  );

  assert.notEqual(
    parsed.backup.database.backupSet,
    parsed.backup.serverToken.backupSet,
    'database and server token must use distinct backup sets',
  );
  assert.notEqual(
    parsed.backup.database.objectPrefix,
    parsed.backup.serverToken.objectPrefix,
    'database and server token must use distinct object prefixes',
  );
  assert.equal(
    parsed.backup.uploader.artifact.fileName,
    'obsutil_linux_amd64.tar.gz',
  );
  assert.equal(
    parsed.backup.uploader.artifact.sourceUrl,
    'https://obs-community.obs.cn-north-1.myhuaweicloud.com/obsutil/current/obsutil_linux_amd64.tar.gz',
  );
  assert.equal(
    parsed.backup.uploader.artifact.sha256,
    '1a90e8861d4ce7f8829ae4392850bfb7d56a3e02e7cdd1f951135b7ae68ff9dd',
  );

  const evidence = parsed.implementationEvidence;
  assert.equal(evidence.cluster.version, parsed.release.version);
  assert.equal(evidence.backup.obsutilVersion, parsed.backup.uploader.version);
  assert.ok(
    evidence.backup.database.objectKey.startsWith(
      parsed.backup.database.objectPrefix,
    ),
  );
  assert.ok(
    evidence.backup.serverToken.objectKey.startsWith(
      parsed.backup.serverToken.objectPrefix,
    ),
  );
  assert.ok(
    evidence.backup.manifest.objectKey.startsWith(
      parsed.backup.manifest.objectPrefix,
    ),
  );
  for (const object of [
    evidence.backup.database,
    evidence.backup.serverToken,
    evidence.backup.manifest,
  ]) {
    assert.ok(object.objectKey.includes(evidence.backup.backupId));
  }
  assert.notEqual(
    evidence.backup.database.objectKey,
    evidence.backup.serverToken.objectKey,
  );
  return parsed;
}

function validateK3sConfig(value: unknown): void {
  assertNoPlaceholder(value);
  K3sConfigSchema.parse(value);
}

function validateAdmissionConfig(
  value: unknown,
  changePackage: ChangePackage,
): void {
  assertNoPlaceholder(value);
  const parsed = AdmissionConfigSchema.parse(value);
  const versionMatch = /^v(\d+)\.(\d+)\./.exec(
    changePackage.release.kubernetesVersion,
  );
  assert.ok(versionMatch);
  const policyVersion = `v${versionMatch[1]}.${versionMatch[2]}`;
  const defaults = parsed.plugins[0].configuration.defaults;
  assert.equal(defaults['enforce-version'], policyVersion);
  assert.equal(defaults['audit-version'], policyVersion);
  assert.equal(defaults['warn-version'], policyVersion);
}

function readActualBundle(): {
  changePackage: unknown;
  config: unknown;
  admissionConfig: unknown;
} {
  return {
    changePackage: parseReadmeFrontMatter(readFileSync(readmePath, 'utf8')),
    config: parseSingleYaml(readFileSync(configPath, 'utf8'), 'config.yaml'),
    admissionConfig: parseSingleYaml(
      readFileSync(admissionConfigPath, 'utf8'),
      'admission-config.yaml',
    ),
  };
}

function readActualKubernetesBundle(): {
  bootstrapSources: string[];
  bootstrapResources: YamlRecord[];
  deploymentSource: string;
  deployment: YamlRecord;
  readme: string;
} {
  const bootstrap = bootstrapManifestPaths.map(readKubernetesResource);
  const deployment = readKubernetesResource(deploymentTemplatePath);
  return {
    bootstrapSources: bootstrap.map((item) => item.source),
    bootstrapResources: bootstrap.map((item) => item.resource),
    deploymentSource: deployment.source,
    deployment: deployment.resource,
    readme: readFileSync(kubernetesReadmePath, 'utf8'),
  };
}

function activeConfigLines(source: string): string[] {
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function validateTrustedRoot(bytes: Buffer): void {
  assert.equal(bytes.byteLength, trustedRootSize);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    trustedRootSha256,
  );
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  assert.ok(
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
    'Sigstore trusted root must be an object',
  );
  const trustedRoot = parsed as Record<string, unknown>;
  assert.equal(
    trustedRoot.mediaType,
    'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
  );
  assert.ok(
    Array.isArray(trustedRoot.tlogs) && trustedRoot.tlogs.length > 0,
  );
  assert.ok(
    Array.isArray(trustedRoot.certificateAuthorities) &&
      trustedRoot.certificateAuthorities.length > 0,
  );
  assert.ok(
    Array.isArray(trustedRoot.ctlogs) && trustedRoot.ctlogs.length > 0,
  );
  assert.ok(
    Array.isArray(trustedRoot.timestampAuthorities) &&
      trustedRoot.timestampAuthorities.length > 0,
  );
}

function validateSudoers(source: string): void {
  assert.deepEqual(activeConfigLines(source), [...expectedSudoersLines]);
}

function validateRunnerHardening(source: string): void {
  assert.deepEqual(activeConfigLines(source), [
    ...expectedRunnerHardeningLines,
  ]);
}

function validateRunnerTmpfiles(source: string): void {
  assert.deepEqual(activeConfigLines(source), [
    ...expectedRunnerTmpfilesLines,
  ]);
}

function validateNoCredentialMaterial(source: string): void {
  assert.doesNotMatch(
    source,
    /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  );
  assert.doesNotMatch(
    source,
    /\b(?:certificate-authority|client-certificate|client-key)-data\s*:/u,
  );
  assert.doesNotMatch(
    source,
    /\bACTIONS_RUNNER_INPUT_TOKEN\s*[:=]\s*[^\s$]/u,
  );
  assert.doesNotMatch(
    source,
    /^[ \t]*(?:DEEPSEEK|VOYAGE)_API_KEY[ \t]*[:=][ \t]*(?!\$\{\{[ \t]*secrets\.)(?!["']?\$\(cat[ \t]+\/run\/secrets\/)\S+/mu,
  );
  assert.doesNotMatch(
    source,
    /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/u,
  );
}

function repositoryFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root },
  )
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0);
}

test('the checked-in K3s change package satisfies the deployment contract', () => {
  const actual = readActualBundle();
  const changePackage = validateChangePackage(actual.changePackage);
  validateK3sConfig(actual.config);
  validateAdmissionConfig(actual.admissionConfig, changePackage);
});

test('missing fixed release identity or installer checksum fails', async (t) => {
  const source = readActualBundle().changePackage;

  await t.test('missing version', () => {
    const candidate = structuredClone(source) as Record<string, unknown>;
    const release = candidate.release as Record<string, unknown>;
    delete release.version;
    assert.throws(() => validateChangePackage(candidate));
  });

  await t.test('missing installer checksum', () => {
    const candidate = structuredClone(source) as Record<string, unknown>;
    const release = candidate.release as Record<string, unknown>;
    const artifacts = release.artifacts as Record<string, unknown>;
    const installer = artifacts.installer as Record<string, unknown>;
    delete installer.sha256;
    assert.throws(() => validateChangePackage(candidate));
  });

  await t.test('floating channel', () => {
    const candidate = structuredClone(source) as Record<string, unknown>;
    const release = candidate.release as Record<string, unknown>;
    release.channel = 'stable';
    assert.throws(() => validateChangePackage(candidate));
  });

  await t.test('placeholder secret metadata', () => {
    const candidate = structuredClone(source) as Record<string, unknown>;
    const backup = candidate.backup as Record<string, unknown>;
    const serverToken = backup.serverToken as Record<string, unknown>;
    serverToken.backupSet = 'CHANGE_ME';
    assert.throws(() => validateChangePackage(candidate));
  });
});

test('the deployment adapter privilege boundary is fixed and credential-free', () => {
  const trustedRoot = readFileSync(trustedRootPath);
  validateTrustedRoot(trustedRoot);

  const files = repositoryFiles();
  const matchingTrustedRoots = files.filter((path) => {
    if (path === 'deploy/adapter/sigstore-trusted-root.json') return true;
    if (!path.endsWith('.json')) return false;
    const bytes = readFileSync(join(root, path));
    return (
      createHash('sha256').update(bytes).digest('hex') ===
      trustedRootSha256
    );
  });
  assert.deepEqual(
    matchingTrustedRoots,
    ['deploy/adapter/sigstore-trusted-root.json'],
  );

  const adapter = readFileSync(adapterPath, 'utf8');
  assert.equal(
    adapter.split(installedTrustedRootPath).length - 1,
    1,
  );

  const sudoers = readFileSync(sudoersPath, 'utf8');
  const hardening = readFileSync(runnerHardeningPath, 'utf8');
  const tmpfiles = readFileSync(runnerTmpfilesPath, 'utf8');
  validateSudoers(sudoers);
  validateRunnerHardening(hardening);
  validateRunnerTmpfiles(tmpfiles);
  validateNoCredentialMaterial(
    `${adapter}\n${sudoers}\n${hardening}\n${tmpfiles}`,
  );

  const explicitlyValidated = new Set([
    'deploy/adapter/k8s_yaml_assistant_deploy.py',
    'deploy/adapter/k8s-yaml-assistant-deploy.sudoers',
    'deploy/adapter/actions-runner-hardening.conf',
    'deploy/adapter/k8s-yaml-assistant-deployer.tmpfiles.conf',
    'deploy/adapter/sigstore-trusted-root.json',
  ]);
  for (const path of files) {
    if (
      explicitlyValidated.has(path) ||
      path.endsWith('.test.ts') ||
      path.endsWith('.test.py') ||
      path.split('/').at(-1)?.startsWith('test_')
    ) {
      continue;
    }
    const bytes = readFileSync(join(root, path));
    if (bytes.includes(0)) continue;
    validateNoCredentialMaterial(bytes.toString('utf8'));
  }
});

test('unsafe deployment privilege boundary mutations fail', async (t) => {
  const trustedRoot = readFileSync(trustedRootPath);
  const sudoers = `${expectedSudoersLines.join('\n')}\n`;
  const hardening = `${expectedRunnerHardeningLines.join('\n')}\n`;
  const tmpfiles = `${expectedRunnerTmpfilesLines.join('\n')}\n`;

  await t.test('truncated trusted root', () => {
    assert.throws(() =>
      validateTrustedRoot(trustedRoot.subarray(0, -1)),
    );
  });

  await t.test('trusted root digest drift', () => {
    const candidate = Buffer.from(trustedRoot);
    const index = candidate.length - 2;
    candidate[index] = candidate[index]! ^ 1;
    assert.throws(() => validateTrustedRoot(candidate));
  });

  for (const [name, mutate] of [
    ['sudo wildcard', (source: string) => source.replace(' ""', ' *')],
    [
      'sudo environment preservation',
      (source: string) => `${source}Defaults:${runnerAccount} env_keep += "PATH"\n`,
    ],
    [
      'alternate root command',
      (source: string) => `${source}${runnerAccount} ALL=(root) NOPASSWD: /usr/bin/python3\n`,
    ],
  ] as const) {
    await t.test(name, () => {
      assert.throws(() => validateSudoers(mutate(sudoers)));
    });
  }

  for (const [name, mutate] of [
    [
      'missing private account',
      (source: string) => source.replace(`User=${runnerAccount}\n`, ''),
    ],
    [
      'writable installation root',
      (source: string) =>
        source.replace(
          'ReadWritePaths=/var/lib/k8s-yaml-assistant-deployer',
          'ReadWritePaths=/opt /var/lib/k8s-yaml-assistant-deployer',
        ),
    ],
    [
      'host work paths shadow bounded tmpfs mounts',
      (source: string) =>
        source.replace(
          'ReadWritePaths=/var/lib/k8s-yaml-assistant-deployer',
          'ReadWritePaths=/opt/actions-runner-k8s-yaml-prod/_work /opt/actions-runner-k8s-yaml-prod/_diag /var/lib/k8s-yaml-assistant-deployer',
        ),
    ],
    [
      'missing metadata denial',
      (source: string) =>
        source.replace('IPAddressDeny=169.254.0.0/16\n', ''),
    ],
    [
      'runtime directory delegated to the runner account',
      (source: string) =>
        `${source}RuntimeDirectory=k8s-yaml-assistant-deployer\n`,
    ],
    [
      'privilege escalation disabled',
      (source: string) =>
        source.replace(
          'NoNewPrivileges=false',
          'NoNewPrivileges=true',
        ),
    ],
    [
      'runner joins an administrative group',
      (source: string) => `${source}SupplementaryGroups=docker k3s\n`,
    ],
    [
      'unbounded memory',
      (source: string) => source.replace('MemoryMax=1G\n', ''),
    ],
    [
      'unbounded work directory',
      (source: string) =>
        source.replace(
          'size=128M,mode=0700',
          'mode=0700',
        ),
    ],
    [
      'runner tmpfs ownership is omitted',
      (source: string) => source.replace(',uid=996,gid=988', ''),
    ],
  ] as const) {
    await t.test(name, () => {
      assert.throws(() => validateRunnerHardening(mutate(hardening)));
    });
  }

  for (const [name, mutate] of [
    [
      'runtime directory owned by the runner',
      (source: string) =>
        source.replace('root root', `${runnerAccount} ${runnerAccount}`),
    ],
    [
      'runtime directory mode is broadened',
      (source: string) => source.replace('0700', '0755'),
    ],
    [
      'runtime directory scope is broadened',
      (source: string) =>
        source.replace(
          '/run/k8s-yaml-assistant-deployer',
          '/run',
        ),
    ],
  ] as const) {
    await t.test(name, () => {
      assert.throws(() => validateRunnerTmpfiles(mutate(tmpfiles)));
    });
  }

  await t.test('embedded kubeconfig', () => {
    assert.throws(() =>
      validateNoCredentialMaterial(
        'client-key-data: cHJpdmF0ZS1rZXk=',
      ),
    );
  });

  await t.test('embedded runner token', () => {
    assert.throws(() =>
      validateNoCredentialMaterial(
        'ACTIONS_RUNNER_INPUT_TOKEN=credential-value',
      ),
    );
  });

  await t.test('embedded access token', () => {
    assert.throws(() =>
      validateNoCredentialMaterial(
        'TOKEN=ghp_0123456789abcdefghijklmnop',
      ),
    );
  });
});

test('unsafe kubeconfig mode and disabled encryption fail', () => {
  const source = readActualBundle().config as Record<string, unknown>;

  const unsafeMode = structuredClone(source);
  unsafeMode['write-kubeconfig-mode'] = '0644';
  assert.throws(() => validateK3sConfig(unsafeMode));

  const encryptionOff = structuredClone(source);
  encryptionOff['secrets-encryption'] = false;
  assert.throws(() => validateK3sConfig(encryptionOff));
});

test('Pod Security Admission must enforce a pinned restricted profile', () => {
  const actual = readActualBundle();
  const changePackage = validateChangePackage(actual.changePackage);
  const source = actual.admissionConfig as Record<string, unknown>;

  const missingPlugin = structuredClone(source);
  missingPlugin.plugins = [];
  assert.throws(() => validateAdmissionConfig(missingPlugin, changePackage));

  const baseline = structuredClone(source);
  const plugins = baseline.plugins as Array<Record<string, unknown>>;
  const configuration = plugins[0]!.configuration as Record<string, unknown>;
  const defaults = configuration.defaults as Record<string, unknown>;
  defaults.enforce = 'baseline';
  assert.throws(() => validateAdmissionConfig(baseline, changePackage));

  const floatingVersion = structuredClone(source);
  const floatingPlugins = floatingVersion.plugins as Array<Record<string, unknown>>;
  const floatingConfiguration = floatingPlugins[0]!
    .configuration as Record<string, unknown>;
  const floatingDefaults = floatingConfiguration.defaults as Record<string, unknown>;
  floatingDefaults['enforce-version'] = 'latest';
  assert.throws(() =>
    validateAdmissionConfig(floatingVersion, changePackage),
  );
});

test('tokens, kubeconfig paths, public API binding, and disabled components fail', () => {
  const source = readActualBundle().config as Record<string, unknown>;
  const unsafeChanges: Array<Record<string, unknown>> = [
    { token: 'CHANGE_ME' },
    { 'write-kubeconfig': '/tmp/admin.yaml' },
    { 'bind-address': '0.0.0.0', 'https-listen-port': 6443 },
    { disable: ['traefik'] },
    { 'disable-network-policy': true },
    { 'datastore-endpoint': 'sqlite:///tmp/k3s.db' },
    { server: 'https://example.invalid:6443' },
  ];

  for (const change of unsafeChanges) {
    assert.throws(() => validateK3sConfig({ ...source, ...change }));
  }
});

test('public control-plane ports fail the package boundary', () => {
  const source = readActualBundle().changePackage as Record<string, unknown>;
  const candidate = structuredClone(source);
  const network = candidate.network as Record<string, unknown>;
  network.publicApi6443 = true;
  assert.throws(() => validateChangePackage(candidate));
});

test('database and server token cannot share an unencrypted backup set', () => {
  const source = readActualBundle().changePackage as Record<string, unknown>;
  const candidate = structuredClone(source);
  const backup = candidate.backup as Record<string, unknown>;
  const database = backup.database as Record<string, unknown>;
  const serverToken = backup.serverToken as Record<string, unknown>;
  serverToken.backupSet = database.backupSet;
  database.encrypted = false;
  serverToken.encrypted = false;
  assert.throws(() => validateChangePackage(candidate));
});

test('backup target and writer identity cannot be broadened', async (t) => {
  const source = readActualBundle().changePackage as Record<string, unknown>;

  await t.test('missing dedicated bucket', () => {
    const candidate = structuredClone(source);
    const backup = candidate.backup as Record<string, unknown>;
    const target = backup.target as Record<string, unknown>;
    delete target.bucket;
    assert.throws(() => validateChangePackage(candidate));
  });

  await t.test('persistent access key', () => {
    const candidate = structuredClone(source);
    const backup = candidate.backup as Record<string, unknown>;
    const identity = backup.writerIdentity as Record<string, unknown>;
    identity.persistentAccessKey = true;
    assert.throws(() => validateChangePackage(candidate));
  });

  await t.test('writer can read objects', () => {
    const candidate = structuredClone(source);
    const backup = candidate.backup as Record<string, unknown>;
    const identity = backup.writerIdentity as Record<string, unknown>;
    identity.canRead = true;
    assert.throws(() => validateChangePackage(candidate));
  });

  await t.test('uploader checksum drift', () => {
    const candidate = structuredClone(source);
    const backup = candidate.backup as Record<string, unknown>;
    const uploader = backup.uploader as Record<string, unknown>;
    const artifact = uploader.artifact as Record<string, unknown>;
    artifact.sha256 = '0'.repeat(64);
    assert.throws(() => validateChangePackage(candidate));
  });

  await t.test('database and token share an object prefix', () => {
    const candidate = structuredClone(source);
    const backup = candidate.backup as Record<string, unknown>;
    const database = backup.database as Record<string, unknown>;
    const serverToken = backup.serverToken as Record<string, unknown>;
    serverToken.objectPrefix = database.objectPrefix;
    assert.throws(() => validateChangePackage(candidate));
  });
});

test('implemented recovery evidence must remain separated and administrator-readable', async (t) => {
  const source = readActualBundle().changePackage as Record<string, unknown>;

  await t.test('missing implementation evidence', () => {
    const candidate = structuredClone(source);
    delete candidate.implementationEvidence;
    assert.throws(() => validateChangePackage(candidate));
  });

  await t.test('administrator read not verified', () => {
    const candidate = structuredClone(source);
    const implementation = candidate.implementationEvidence as Record<
      string,
      unknown
    >;
    const backup = implementation.backup as Record<string, unknown>;
    backup.administratorReadVerified = false;
    assert.throws(() => validateChangePackage(candidate));
  });

  await t.test('database and token evidence share an object', () => {
    const candidate = structuredClone(source);
    const implementation = candidate.implementationEvidence as Record<
      string,
      unknown
    >;
    const backup = implementation.backup as Record<string, unknown>;
    const database = backup.database as Record<string, unknown>;
    const serverToken = backup.serverToken as Record<string, unknown>;
    serverToken.objectKey = database.objectKey;
    assert.throws(() => validateChangePackage(candidate));
  });
});

test('the checked-in Kubernetes resources satisfy the private bootstrap contract', () => {
  const actual = readActualKubernetesBundle();
  validateBootstrapResources(actual.bootstrapResources);
  validateDeploymentTemplate(actual.deploymentSource, actual.deployment);
  validateKubernetesReadme(actual.readme);

  const expectedManifestFiles = [
    ...bootstrapManifestPaths,
    deploymentTemplatePath,
  ]
    .map((path) => path.slice(root.length + 1))
    .sort();
  const actualManifestFiles = repositoryFiles()
    .filter(
      (path) =>
        path.startsWith('deploy/k8s/') && /\.ya?ml$/u.test(path),
    )
    .sort();
  assert.deepEqual(actualManifestFiles, expectedManifestFiles);

  const allManifestSource = [
    ...actual.bootstrapSources,
    actual.deploymentSource,
  ].join('\n');
  assert.doesNotMatch(allManifestSource, /\bnamespace:\s*default\b/u);
  assert.doesNotMatch(
    allManifestSource,
    /^kind:\s*(?:Secret|Role|RoleBinding|ClusterRole|ClusterRoleBinding|Ingress)\s*$/mu,
  );
  validateNoCredentialMaterial(allManifestSource);
});

test('unsafe Kubernetes bootstrap mutations fail', async (t) => {
  const actual = readActualKubernetesBundle();

  await t.test('namespace loses restricted enforcement', () => {
    const candidate = structuredClone(actual.bootstrapResources[0]!);
    const labels = nestedRecord(
      resourceMetadata(candidate, 'Namespace'),
      'labels',
      'Namespace.metadata',
    );
    delete labels['pod-security.kubernetes.io/enforce'];
    assert.throws(() => validateNamespace(candidate));
  });

  await t.test('resource falls back to the default namespace', () => {
    const candidate = structuredClone(actual.bootstrapResources);
    resourceMetadata(candidate[1]!, 'ServiceAccount').namespace = 'default';
    assert.throws(() => validateBootstrapResources(candidate));
  });

  await t.test('service account mounts its API token', () => {
    const candidate = structuredClone(actual.bootstrapResources[1]!);
    candidate.automountServiceAccountToken = true;
    assert.throws(() => validateServiceAccount(candidate));
  });

  await t.test('bootstrap adds an RBAC binding', () => {
    const candidate = structuredClone(actual.bootstrapResources);
    candidate.push({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: {
        name: applicationName,
        namespace: productionNamespace,
      },
    });
    assert.throws(() => validateBootstrapResources(candidate));
  });

  await t.test('service becomes a NodePort', () => {
    const candidate = structuredClone(actual.bootstrapResources[3]!);
    nestedRecord(candidate, 'spec', 'Service').type = 'NodePort';
    assert.throws(() => validateService(candidate));
  });

  await t.test('observation claim is broadened', () => {
    const candidate = structuredClone(actual.bootstrapResources[4]!);
    const spec = nestedRecord(
      candidate,
      'spec',
      'PersistentVolumeClaim',
    );
    const resources = nestedRecord(
      spec,
      'resources',
      'PersistentVolumeClaim.spec',
    );
    nestedRecord(
      resources,
      'requests',
      'PersistentVolumeClaim.spec.resources',
    ).storage = '10Gi';
    assert.throws(() => validateObservationClaim(candidate));
  });

  await t.test('network policy drops DNS egress', () => {
    const candidate = structuredClone(actual.bootstrapResources[5]!);
    nestedRecord(candidate, 'spec', 'NetworkPolicy').egress = [
      {
        ports: [{ protocol: 'TCP', port: 443 }],
      },
    ];
    assert.throws(() => validateNetworkPolicy(candidate));
  });

  await t.test('network policy drops HTTPS egress', () => {
    const candidate = structuredClone(actual.bootstrapResources[5]!);
    const spec = nestedRecord(candidate, 'spec', 'NetworkPolicy');
    spec.egress = yamlArray(
      spec.egress,
      'NetworkPolicy.spec.egress',
    ).slice(0, 1);
    assert.throws(() => validateNetworkPolicy(candidate));
  });

  await t.test('config map contains a model credential', () => {
    const candidate = structuredClone(actual.bootstrapResources[2]!);
    nestedRecord(candidate, 'data', 'ConfigMap').VOYAGE_API_KEY =
      'credential-material';
    assert.throws(() => validateConfigMap(candidate));
  });

  await t.test('config map enables portfolio access', () => {
    const candidate = structuredClone(actual.bootstrapResources[2]!);
    nestedRecord(candidate, 'data', 'ConfigMap').ACCESS_MODE = 'portfolio';
    assert.throws(() => validateConfigMap(candidate));
  });

  await t.test('config map omits observation retention', () => {
    const candidate = structuredClone(actual.bootstrapResources[2]!);
    delete nestedRecord(candidate, 'data', 'ConfigMap')
      .SERVING_OBSERVATION_RETENTION_DAYS;
    assert.throws(() => validateConfigMap(candidate));
  });
});

test('unsafe Kubernetes deployment template mutations fail', async (t) => {
  const actual = readActualKubernetesBundle();

  function deploymentParts(candidate: YamlRecord): {
    spec: YamlRecord;
    podSpec: YamlRecord;
    container: YamlRecord;
  } {
    const spec = nestedRecord(candidate, 'spec', 'Deployment');
    const template = nestedRecord(spec, 'template', 'Deployment.spec');
    const podSpec = nestedRecord(
      template,
      'spec',
      'Deployment.template',
    );
    const container = yamlRecord(
      yamlArray(
        podSpec.containers,
        'Deployment.template.spec.containers',
      )[0],
      'Deployment.container',
    );
    return { spec, podSpec, container };
  }

  for (const [name, mutate] of [
    [
      'multiple replicas',
      ({ spec }: ReturnType<typeof deploymentParts>) => {
        spec.replicas = 2;
      },
    ],
    [
      'surge update',
      ({ spec }: ReturnType<typeof deploymentParts>) => {
        nestedRecord(spec, 'strategy', 'Deployment.spec').rollingUpdate = {
          maxSurge: 1,
          maxUnavailable: 0,
        };
      },
    ],
    [
      'mutable image tag',
      ({ container }: ReturnType<typeof deploymentParts>) => {
        container.image = `${applicationImage}:latest`;
      },
    ],
    [
      'writable root filesystem',
      ({ container }: ReturnType<typeof deploymentParts>) => {
        nestedRecord(
          container,
          'securityContext',
          'Deployment.container',
        ).readOnlyRootFilesystem = false;
      },
    ],
    [
      'missing liveness probe',
      ({ container }: ReturnType<typeof deploymentParts>) => {
        delete container.livenessProbe;
      },
    ],
    [
      'unbounded temporary volume',
      ({ podSpec }: ReturnType<typeof deploymentParts>) => {
        const volumes = yamlArray(
          podSpec.volumes,
          'Deployment.template.spec.volumes',
        );
        yamlRecord(volumes[1], 'Deployment.tmpVolume').emptyDir = {};
      },
    ],
    [
      'index mounted from a writable volume',
      ({ container }: ReturnType<typeof deploymentParts>) => {
        const mounts = yamlArray(
          container.volumeMounts,
          'Deployment.container.volumeMounts',
        );
        mounts.push({
          name: 'observations',
          mountPath: '/app/data/index',
        });
      },
    ],
    [
      'second observation writer',
      ({ podSpec }: ReturnType<typeof deploymentParts>) => {
        const containers = yamlArray(
          podSpec.containers,
          'Deployment.template.spec.containers',
        );
        containers.push({
          name: 'sidecar',
          image: imageMarker,
          volumeMounts: [
            {
              name: 'observations',
              mountPath: '/app/data/observability',
            },
          ],
        });
      },
    ],
  ] as const) {
    await t.test(name, () => {
      const candidate = structuredClone(actual.deployment);
      mutate(deploymentParts(candidate));
      assert.throws(() =>
        validateDeploymentTemplate(actual.deploymentSource, candidate),
      );
    });
  }

  await t.test('duplicate image marker', () => {
    assert.throws(() =>
      validateDeploymentTemplate(
        `${actual.deploymentSource}\n${imageMarker}\n`,
        actual.deployment,
      ),
    );
  });

  await t.test('documentation claims domain allowlisting', () => {
    const candidate = actual.readme.replace(
      '标准 NetworkPolicy（网络策略）不能按域名建立可靠 allowlist（允许名单）',
      '标准 NetworkPolicy（网络策略）已经实现域名 allowlist（允许名单）',
    );
    assert.throws(() => validateKubernetesReadme(candidate));
  });
});
