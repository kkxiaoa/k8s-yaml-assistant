import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { loadAll } from 'js-yaml';
import { z } from 'zod';

const root = process.cwd();
const k3sDir = join(root, 'deploy', 'k3s');
const readmePath = join(k3sDir, 'README.md');
const configPath = join(k3sDir, 'config.yaml');
const admissionConfigPath = join(k3sDir, 'admission-config.yaml');

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
