import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { loadAll } from 'js-yaml';
import { z } from 'zod';
import { rootHealthRedirects } from '../src/shared/application-path.mjs';

const root = process.cwd();
const k3sDir = join(root, 'deploy', 'k3s');
const configPath = join(k3sDir, 'config.yaml');
const admissionConfigPath = join(k3sDir, 'admission-config.yaml');
const adapterDir = join(root, 'deploy', 'adapter');
const kubernetesDir = join(root, 'deploy', 'k8s');
const bootstrapDir = join(kubernetesDir, 'bootstrap');
const applicationDir = join(kubernetesDir, 'app');
const accessDir = join(kubernetesDir, 'access');
const tlsDir = join(kubernetesDir, 'tls');
const kubernetesReadmePath = join(kubernetesDir, 'README.md');
const deploymentTemplatePath = join(
  applicationDir,
  'deployment-template.yaml',
);
const configMapPath = join(bootstrapDir, 'config-map.yaml');
const controlClaimPath = join(bootstrapDir, 'control-pvc.yaml');
const networkPolicyPath = join(bootstrapDir, 'network-policy.yaml');
const accessMiddlewarePath = join(accessDir, 'middlewares.yaml');
const httpRedirectRoutePath = join(accessDir, 'http-redirect.yaml');
const accessRoutePath = join(accessDir, 'routes.yaml');
const productionCertificatePath = join(tlsDir, 'certificate.yaml');
const tlsStorePath = join(tlsDir, 'tls-store.yaml');
const imageMarker = '__K8S_YAML_ASSISTANT_IMAGE__';
const applicationImage = 'ghcr.io/kkxiaoa/k8s-yaml-assistant';

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

function parseSingleYaml(text: string, label: string): unknown {
  const documents: unknown[] = [];
  loadAll(text, (document) => documents.push(document));
  assert.equal(documents.length, 1, `${label} must contain exactly one YAML document`);
  return documents[0];
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

function parseYamlDocuments(text: string, label: string): YamlRecord[] {
  const documents: YamlRecord[] = [];
  loadAll(text, (document) => {
    assert.notEqual(document, null, `${label} contains an empty document`);
    documents.push(yamlRecord(document, label));
  });
  return documents;
}

function applicationContainer(deployment: YamlRecord): {
  podSpec: YamlRecord;
  container: YamlRecord;
} {
  const spec = nestedRecord(deployment, 'spec', 'Deployment');
  const template = nestedRecord(spec, 'template', 'Deployment.spec');
  const podSpec = nestedRecord(
    template,
    'spec',
    'Deployment.spec.template',
  );
  const containers = yamlArray(
    podSpec.containers,
    'Deployment.spec.template.spec.containers',
  );
  assert.equal(containers.length, 1);
  return {
    podSpec,
    container: yamlRecord(containers[0], 'application container'),
  };
}

function validateK3sConfig(value: unknown): void {
  assertNoPlaceholder(value);
  K3sConfigSchema.parse(value);
}

function validateAdmissionConfig(value: unknown): void {
  assertNoPlaceholder(value);
  const parsed = AdmissionConfigSchema.parse(value);
  const defaults = parsed.plugins[0].configuration.defaults;
  assert.equal(defaults['enforce-version'], 'v1.36');
  assert.equal(defaults['audit-version'], 'v1.36');
  assert.equal(defaults['warn-version'], 'v1.36');
}

function readActualBundle(): {
  config: unknown;
  admissionConfig: unknown;
} {
  return {
    config: parseSingleYaml(readFileSync(configPath, 'utf8'), 'config.yaml'),
    admissionConfig: parseSingleYaml(
      readFileSync(admissionConfigPath, 'utf8'),
      'admission-config.yaml',
    ),
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

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return filesUnder(path);
      return entry.isFile() ? [path] : [];
    })
    .sort();
}

test('the checked-in K3s configuration satisfies the deployment contract', () => {
  const actual = readActualBundle();
  validateK3sConfig(actual.config);
  validateAdmissionConfig(actual.admissionConfig);
});

test('the deployment adapter privilege boundary is fixed and credential-free', () => {
  const trustedRoot = readFileSync(trustedRootPath);
  validateTrustedRoot(trustedRoot);

  const deploymentFiles = filesUnder(join(root, 'deploy'));
  const matchingTrustedRoots = deploymentFiles.filter((path) => {
    if (path === trustedRootPath) return true;
    if (!path.endsWith('.json')) return false;
    const bytes = readFileSync(path);
    return (
      createHash('sha256').update(bytes).digest('hex') ===
      trustedRootSha256
    );
  });
  assert.deepEqual(
    matchingTrustedRoots,
    [trustedRootPath],
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
    adapterPath,
    sudoersPath,
    runnerHardeningPath,
    runnerTmpfilesPath,
    trustedRootPath,
  ]);
  for (const path of deploymentFiles) {
    if (
      explicitlyValidated.has(path) ||
      path.endsWith('.test.ts') ||
      path.endsWith('.test.py') ||
      path.split('/').at(-1)?.startsWith('test_')
    ) {
      continue;
    }
    const bytes = readFileSync(path);
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
    const embeddedValue = ['client-key-data:', 'cHJpdmF0ZS1rZXk='].join(' ');
    assert.throws(() =>
      validateNoCredentialMaterial(embeddedValue),
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
    const embeddedValue = [
      'TOKEN',
      ['ghp', '0123456789abcdefghijklmnop'].join('_'),
    ].join('=');
    assert.throws(() =>
      validateNoCredentialMaterial(embeddedValue),
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
  const source = actual.admissionConfig as Record<string, unknown>;

  const missingPlugin = structuredClone(source);
  missingPlugin.plugins = [];
  assert.throws(() => validateAdmissionConfig(missingPlugin));

  const baseline = structuredClone(source);
  const plugins = baseline.plugins as Array<Record<string, unknown>>;
  const configuration = plugins[0]!.configuration as Record<string, unknown>;
  const defaults = configuration.defaults as Record<string, unknown>;
  defaults.enforce = 'baseline';
  assert.throws(() => validateAdmissionConfig(baseline));

  const floatingVersion = structuredClone(source);
  const floatingPlugins = floatingVersion.plugins as Array<Record<string, unknown>>;
  const floatingConfiguration = floatingPlugins[0]!
    .configuration as Record<string, unknown>;
  const floatingDefaults = floatingConfiguration.defaults as Record<string, unknown>;
  floatingDefaults['enforce-version'] = 'latest';
  assert.throws(() => validateAdmissionConfig(floatingVersion));
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

test('the public experience manifests preserve the risky deployment relationships', () => {
  assert.deepEqual(rootHealthRedirects(), [
    {
      source: '/api/health/live',
      destination: '/k8s-yaml-assistant/api/health/live',
      permanent: false,
      basePath: false,
    },
    {
      source: '/api/health/ready',
      destination: '/k8s-yaml-assistant/api/health/ready',
      permanent: false,
      basePath: false,
    },
  ]);
  const configMap = readKubernetesResource(configMapPath);
  const configData = nestedRecord(configMap.resource, 'data', 'ConfigMap');
  assert.deepEqual(
    {
      MODEL_ACCESS_ENABLED: configData.MODEL_ACCESS_ENABLED,
      CONTROL_DB_PATH: configData.CONTROL_DB_PATH,
      NEXTAUTH_URL: configData.NEXTAUTH_URL,
      APP_PUBLIC_ORIGIN: configData.APP_PUBLIC_ORIGIN,
      NODE_USE_ENV_PROXY: configData.NODE_USE_ENV_PROXY,
      HTTPS_PROXY: configData.HTTPS_PROXY,
      NO_PROXY: configData.NO_PROXY,
    },
    {
      MODEL_ACCESS_ENABLED: 'true',
      CONTROL_DB_PATH: '/app/data/control/private/control.sqlite3',
      NEXTAUTH_URL:
        'https://120.46.57.214/k8s-yaml-assistant/api/auth',
      APP_PUBLIC_ORIGIN: 'https://120.46.57.214',
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://95.40.183.32:3128',
      NO_PROXY:
        'localhost,127.0.0.1,::1,.svc,.cluster.local,api.deepseek.com,api.voyageai.com',
    },
  );
  assert.equal(configData.ACCESS_MODE, undefined);
  for (const secretField of [
    'GITHUB_SECRET',
    'NEXTAUTH_SECRET',
    'CONTROL_SUBJECT_HMAC_KEY',
  ]) {
    assert.equal(configData[secretField], undefined);
  }

  const controlClaim = readKubernetesResource(controlClaimPath).resource;
  assert.equal(resourceMetadata(controlClaim, 'control PVC').name, 'k8s-yaml-assistant-control');
  const claimSpec = nestedRecord(controlClaim, 'spec', 'control PVC');
  assert.deepEqual(claimSpec.accessModes, ['ReadWriteOnce']);
  assert.equal(claimSpec.storageClassName, 'local-path');
  assert.equal(
    nestedRecord(
      nestedRecord(claimSpec, 'resources', 'control PVC'),
      'requests',
      'control PVC resources',
    ).storage,
    '1Gi',
  );

  const deploymentSource = readFileSync(deploymentTemplatePath, 'utf8');
  const deployment = yamlRecord(
    parseSingleYaml(deploymentSource, deploymentTemplatePath),
    'Deployment',
  );
  assert.equal(deploymentSource.split(imageMarker).length - 1, 1);
  const deploymentSpec = nestedRecord(deployment, 'spec', 'Deployment');
  assert.equal(deploymentSpec.replicas, 1);
  assert.equal(
    nestedRecord(
      nestedRecord(deploymentSpec, 'strategy', 'Deployment'),
      'rollingUpdate',
      'Deployment strategy',
    ).maxSurge,
    0,
  );
  const { podSpec, container } = applicationContainer(deployment);
  assert.equal(
    nestedRecord(container, 'securityContext', 'application container')
      .readOnlyRootFilesystem,
    true,
  );
  const environment = new Map(
    yamlArray(container.env, 'application env').map((entry) => {
      const variable = yamlRecord(entry, 'application env entry');
      return [String(variable.name), variable] as const;
    }),
  );
  const expectedSecretRefs = {
    DEEPSEEK_API_KEY: ['deepseek-runtime', 'api-key'],
    VOYAGE_API_KEY: ['voyage-runtime', 'api-key'],
    GITHUB_ID: ['k8s-yaml-assistant-auth', 'github-client-id'],
    GITHUB_SECRET: ['k8s-yaml-assistant-auth', 'github-client-secret'],
    NEXTAUTH_SECRET: ['k8s-yaml-assistant-auth', 'session-secret'],
    ADMIN_GITHUB_ID: ['k8s-yaml-assistant-auth', 'admin-github-id'],
    CONTROL_SUBJECT_HMAC_KEY: [
      'k8s-yaml-assistant-auth',
      'subject-hmac-key',
    ],
  } as const;
  assert.deepEqual(
    [...environment.keys()].sort(),
    Object.keys(expectedSecretRefs).sort(),
  );
  for (const [name, [secretName, key]] of Object.entries(
    expectedSecretRefs,
  )) {
    const variable = environment.get(name);
    assert.ok(variable);
    const valueFrom = nestedRecord(variable, 'valueFrom', name);
    const secretKeyRef = nestedRecord(
      valueFrom,
      'secretKeyRef',
      `${name}.valueFrom`,
    );
    assert.deepEqual(secretKeyRef, { name: secretName, key });
  }
  const mounts = new Map(
    yamlArray(container.volumeMounts, 'application volume mounts').map(
      (entry) => {
        const mount = yamlRecord(entry, 'volume mount');
        return [String(mount.name), mount.mountPath] as const;
      },
    ),
  );
  assert.equal(mounts.get('control'), '/app/data/control');
  assert.equal(mounts.get('observations'), '/app/data/observability');
  assert.equal(mounts.get('tmp'), '/tmp');
  const volumes = new Map(
    yamlArray(podSpec.volumes, 'application volumes').map((entry) => {
      const volume = yamlRecord(entry, 'volume');
      return [String(volume.name), volume] as const;
    }),
  );
  assert.equal(
    nestedRecord(
      volumes.get('control')!,
      'persistentVolumeClaim',
      'control volume',
    ).claimName,
    'k8s-yaml-assistant-control',
  );
  assert.equal(
    nestedRecord(
      volumes.get('observations')!,
      'persistentVolumeClaim',
      'observation volume',
    ).claimName,
    'k8s-yaml-assistant-observation',
  );
  assert.equal(
    nestedRecord(volumes.get('tmp')!, 'emptyDir', 'temporary volume')
      .sizeLimit,
    '64Mi',
  );
  assert.equal(
    nestedRecord(
      nestedRecord(container, 'startupProbe', 'application container'),
      'httpGet',
      'startup probe',
    ).path,
    '/api/health/ready',
  );
  assert.equal(
    nestedRecord(
      nestedRecord(container, 'readinessProbe', 'application container'),
      'httpGet',
      'readiness probe',
    ).path,
    '/api/health/ready',
  );
  assert.equal(
    nestedRecord(
      nestedRecord(container, 'livenessProbe', 'application container'),
      'httpGet',
      'liveness probe',
    ).path,
    '/api/health/live',
  );
  const rendered = deploymentSource.replace(
    imageMarker,
    `${applicationImage}@sha256:${'a'.repeat(64)}`,
  );
  assert.doesNotMatch(rendered, /__[A-Z0-9_]+__/u);
  assert.match(
    rendered,
    /ghcr\.io\/kkxiaoa\/k8s-yaml-assistant@sha256:[a-f0-9]{64}/u,
  );

  const networkPolicy = readKubernetesResource(networkPolicyPath).resource;
  const policySpec = nestedRecord(networkPolicy, 'spec', 'NetworkPolicy');
  const ingress = yamlRecord(
    yamlArray(policySpec.ingress, 'NetworkPolicy ingress')[0],
    'NetworkPolicy ingress rule',
  );
  const ingressPeer = yamlRecord(
    yamlArray(ingress.from, 'NetworkPolicy ingress peers')[0],
    'NetworkPolicy ingress peer',
  );
  assert.deepEqual(ingressPeer, {
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
  });
  const egressText = JSON.stringify(policySpec.egress);
  assert.match(egressText, /"port":443/u);
  assert.match(egressText, /"169\.254\.0\.0\/16"/u);

  const proxyEgressRules = yamlArray(
    policySpec.egress,
    'NetworkPolicy egress',
  ).filter((entry) => {
    const rule = yamlRecord(entry, 'NetworkPolicy egress rule');
    return yamlArray(rule.ports, 'NetworkPolicy egress ports').some(
      (portEntry) =>
        yamlRecord(portEntry, 'NetworkPolicy egress port').port === 3128,
    );
  });
  assert.equal(proxyEgressRules.length, 1);
  const proxyEgressRule = yamlRecord(
    proxyEgressRules[0],
    'proxy egress rule',
  );
  assert.deepEqual(proxyEgressRule.ports, [
    { protocol: 'TCP', port: 3128 },
  ]);
  const proxyEgressPeers = yamlArray(
    proxyEgressRule.to,
    'proxy egress peers',
  );
  assert.equal(proxyEgressPeers.length, 1);
  const proxyIpBlock = nestedRecord(
    yamlRecord(proxyEgressPeers[0], 'proxy egress peer'),
    'ipBlock',
    'proxy egress peer',
  );
  const proxyUrl = new URL(String(configData.HTTPS_PROXY));
  assert.equal(proxyUrl.protocol, 'http:');
  assert.equal(proxyUrl.port, '3128');
  assert.equal(proxyIpBlock.cidr, proxyUrl.hostname + '/32');

  const accessFiles = filesUnder(accessDir).map((path) =>
    path.slice(accessDir.length + 1),
  );
  assert.deepEqual(accessFiles, [
    'http-redirect.yaml',
    'middlewares.yaml',
    'routes.yaml',
  ]);
  const middlewares = parseYamlDocuments(
    readFileSync(accessMiddlewarePath, 'utf8'),
    accessMiddlewarePath,
  );
  assert.deepEqual(
    middlewares.map((resource) =>
      String(resourceMetadata(resource, 'Middleware').name),
    ),
    [
      'k8s-yaml-assistant-rate-limit',
      'k8s-yaml-assistant-inflight',
      'k8s-yaml-assistant-https-redirect',
    ],
  );
  assert.equal(
    nestedRecord(
      nestedRecord(middlewares[0]!, 'spec', 'rate middleware'),
      'rateLimit',
      'rate middleware spec',
    ).average,
    120,
  );
  assert.equal(
    nestedRecord(
      nestedRecord(middlewares[1]!, 'spec', 'inflight middleware'),
      'inFlightReq',
      'inflight middleware spec',
    ).amount,
    16,
  );
  assert.deepEqual(
    nestedRecord(
      nestedRecord(middlewares[2]!, 'spec', 'redirect middleware'),
      'redirectScheme',
      'redirect middleware spec',
    ),
    { scheme: 'https', permanent: true },
  );

  const route = readKubernetesResource(accessRoutePath).resource;
  const routeSpec = nestedRecord(route, 'spec', 'IngressRoute');
  assert.deepEqual(routeSpec.entryPoints, ['websecure']);
  const routeRule = yamlRecord(
    yamlArray(routeSpec.routes, 'IngressRoute routes')[0],
    'IngressRoute rule',
  );
  assert.equal(
    routeRule.match,
    'Path(`/k8s-yaml-assistant`) || PathPrefix(`/k8s-yaml-assistant/`)',
  );
  assert.deepEqual(
    yamlArray(routeRule.middlewares, 'IngressRoute middlewares'),
    [
      { name: 'k8s-yaml-assistant-rate-limit' },
      { name: 'k8s-yaml-assistant-inflight' },
    ],
  );
  assert.deepEqual(
    yamlArray(routeRule.services, 'IngressRoute services'),
    [{ name: 'k8s-yaml-assistant', port: 80 }],
  );
  assert.equal(
    nestedRecord(routeSpec, 'tls', 'IngressRoute').secretName,
    'k8s-yaml-assistant-ip-tls',
  );

  const httpRedirectRoute = readKubernetesResource(
    httpRedirectRoutePath,
  ).resource;
  assert.equal(
    resourceMetadata(httpRedirectRoute, 'HTTP redirect IngressRoute').name,
    'k8s-yaml-assistant-http-redirect',
  );
  const httpRedirectSpec = nestedRecord(
    httpRedirectRoute,
    'spec',
    'HTTP redirect IngressRoute',
  );
  assert.deepEqual(httpRedirectSpec.entryPoints, ['web']);
  assert.equal(httpRedirectSpec.tls, undefined);
  const httpRedirectRules = yamlArray(
    httpRedirectSpec.routes,
    'HTTP redirect IngressRoute routes',
  );
  assert.equal(httpRedirectRules.length, 1);
  const httpRedirectRule = yamlRecord(
    httpRedirectRules[0],
    'HTTP redirect IngressRoute rule',
  );
  assert.equal(
    httpRedirectRule.match,
    'Path(`/k8s-yaml-assistant`) || PathPrefix(`/k8s-yaml-assistant/`)',
  );
  assert.deepEqual(
    yamlArray(
      httpRedirectRule.middlewares,
      'HTTP redirect IngressRoute middlewares',
    ),
    [{ name: 'k8s-yaml-assistant-https-redirect' }],
  );
  assert.deepEqual(
    yamlArray(
      httpRedirectRule.services,
      'HTTP redirect IngressRoute services',
    ),
    [{ name: 'k8s-yaml-assistant', port: 80 }],
  );

  const certificate = readKubernetesResource(
    productionCertificatePath,
  ).resource;
  const certificateSpec = nestedRecord(
    certificate,
    'spec',
    'production Certificate',
  );
  assert.equal(certificateSpec.secretName, 'k8s-yaml-assistant-ip-tls');
  assert.deepEqual(certificateSpec.ipAddresses, ['120.46.57.214']);
  assert.equal(certificateSpec.renewBeforePercentage, 33);
  assert.deepEqual(certificateSpec.issuerRef, {
    name: 'letsencrypt-ip-production',
    kind: 'Issuer',
    group: 'cert-manager.io',
  });
  const tlsStore = readKubernetesResource(tlsStorePath).resource;
  assert.equal(resourceMetadata(tlsStore, 'TLSStore').name, 'default');
  assert.equal(
    nestedRecord(
      nestedRecord(tlsStore, 'spec', 'TLSStore'),
      'defaultCertificate',
      'TLSStore spec',
    ).secretName,
    'k8s-yaml-assistant-ip-tls',
  );

  const manifestSources = [
    configMap.source,
    readFileSync(controlClaimPath, 'utf8'),
    deploymentSource,
    readFileSync(networkPolicyPath, 'utf8'),
    readFileSync(accessMiddlewarePath, 'utf8'),
    readFileSync(accessRoutePath, 'utf8'),
    readFileSync(productionCertificatePath, 'utf8'),
    readFileSync(tlsStorePath, 'utf8'),
    readFileSync(kubernetesReadmePath, 'utf8'),
  ];
  for (const manifestSource of manifestSources) {
    validateNoCredentialMaterial(manifestSource);
  }
  assert.doesNotMatch(manifestSources.join('\n'), /oauth2-proxy|X-Forwarded-User|ACCESS_MODE/u);
});
