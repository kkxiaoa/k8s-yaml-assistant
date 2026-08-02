import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assertContainerBuildContract,
  assertImmutableDeploymentImageReference,
  assertLocalSmokeImageReference,
  findForbiddenRuntimePaths,
  parseContainerSmokeArguments,
  REVIEWED_WORKTREE_CONTEXT_FILES,
  selectBuildContextPaths,
} from './container-smoke';

const root = process.cwd();

function repositoryContract() {
  return {
    dockerfile: readFileSync(`${root}/Dockerfile`, 'utf8'),
    dockerignore: readFileSync(`${root}/.dockerignore`, 'utf8'),
    trackedSchemaPaths: [
      'data/schemas/generated/manifest.json',
      'data/schemas/generated/resources/core.v1.Pod.json',
      'data/schemas/generated/definitions/io.k8s.api.core.v1.PodSpec.json',
    ],
  };
}

test('repository container files satisfy the release build contract', () => {
  assert.doesNotThrow(() => assertContainerBuildContract(repositoryContract()));
});

test('dockerignore must exclude local state without excluding tracked schema closure', () => {
  const contract = repositoryContract();
  const requiredExclusions: Array<[string, string]> = [
    ['.env', '.env'],
    ['.git', '.git'],
    ['.ruff_cache', '.ruff_cache'],
    ['__pycache__', '__pycache__'],
    ['*.pyc', 'adapter.pyc'],
    ['*.tsbuildinfo', 'tsconfig.tsbuildinfo'],
    ['node_modules', 'node_modules'],
    ['.next', '.next'],
    ['data/index', 'data/index'],
    ['data/schemas/snapshots', 'data/schemas/snapshots'],
    ['data/observability', 'data/observability'],
    ['data/eval/runs', 'data/eval/runs'],
    ['data/eval/traces', 'data/eval/traces'],
    ['/AGENTS.md', 'AGENTS.md'],
    ['/CLAUDE.md', 'CLAUDE.md'],
    ['/HANDOFF.md', 'HANDOFF.md'],
    ['/docs/', 'docs/private.md'],
    ['/scripts/k3s-image-preheat.sh', 'scripts/k3s-image-preheat.sh'],
  ];

  for (const [rule, excludedPath] of requiredExclusions) {
    const mutated = contract.dockerignore
      .split('\n')
      .filter((line) => line.trim() !== rule)
      .join('\n');
    assert.throws(
      () =>
        assertContainerBuildContract({
          ...contract,
          dockerignore: mutated,
        }),
      new RegExp(excludedPath.replaceAll(/[./]/g, '\\$&')),
    );
  }

  for (const broadExclusion of [
    'data',
    'data/schemas',
    'data/schemas/generated',
  ]) {
    assert.throws(
      () =>
        assertContainerBuildContract({
          ...contract,
          dockerignore: `${contract.dockerignore}\n${broadExclusion}\n`,
        }),
      /tracked schema closure/,
    );
  }
});

test('gitignore excludes local state and private repository material', () => {
  const rules = readFileSync(`${root}/.gitignore`, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  for (const rule of [
    '__pycache__/',
    '*.pyc',
    '.ruff_cache/',
    '*.tsbuildinfo',
    'data/schemas/snapshots/',
    '/AGENTS.md',
    '/CLAUDE.md',
    '/HANDOFF.md',
    '/docs/',
    '/scripts/k3s-image-preheat.sh',
  ]) {
    assert.ok(rules.includes(rule), `.gitignore missing ${rule}`);
  }
});

test('Dockerfile contract rejects mutable images and weakened runtime boundaries', () => {
  const contract = repositoryContract();
  const mutations: Array<[string, string, RegExp]> = [
    [
      '@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d',
      '',
      /digest/,
    ],
    ['RUN --network=none npm run build', 'RUN npm run build', /network/],
    ['USER 10001:10001', 'USER 1000:1000', /10001:10001/],
    ['FROM runtime-base AS runtime', 'FROM build AS runtime', /runtime-base/],
    [
      'FROM scratch AS index-artifact',
      'FROM index-build AS index-artifact',
      /only the independently built index/,
    ],
    [
      'COPY --from=verified-index --chown=10001:10001 /data/index ./data/index',
      'COPY --from=index-build --chown=10001:10001 /app/data/index ./data/index',
      /immutable verified-index build context/,
    ],
    [
      '--mount=type=secret,id=voyage_api_key,required=true',
      'VOYAGE_API_KEY=fixture',
      /BuildKit secret/,
    ],
  ];

  for (const [present, replacement, expected] of mutations) {
    assert.ok(contract.dockerfile.includes(present), `missing fixture: ${present}`);
    assert.throws(
      () =>
        assertContainerBuildContract({
          ...contract,
          dockerfile: contract.dockerfile.replace(present, replacement),
        }),
      expected,
    );
  }

  assert.throws(
    () =>
      assertContainerBuildContract({
        ...contract,
        dockerfile: `${contract.dockerfile}\nARG VOYAGE_API_KEY\n`,
      }),
    /VOYAGE_API_KEY.*ARG|ARG.*VOYAGE_API_KEY/,
  );
});

test('runtime base supplies Node C++ libraries without adding distribution tools', () => {
  assert.match(
    repositoryContract().dockerfile,
    /FROM gcr\.io\/distroless\/cc-debian12:nonroot@sha256:[a-f0-9]{64} AS runtime-base/u,
  );
});

test('local smoke and deployment image references have separate immutability gates', () => {
  assert.doesNotThrow(() =>
    assertLocalSmokeImageReference('k8s-yaml-assistant:test-runtime-base'),
  );
  for (const value of ['', 'k8s-yaml-assistant', 'k8s-yaml-assistant:latest']) {
    assert.throws(() => assertLocalSmokeImageReference(value));
  }

  const digest = 'a'.repeat(64);
  assert.doesNotThrow(() =>
    assertImmutableDeploymentImageReference(
      `ghcr.io/example/k8s-yaml-assistant@sha256:${digest}`,
    ),
  );
  for (const value of [
    '',
    'ghcr.io/example/k8s-yaml-assistant:release',
    'ghcr.io/example/k8s-yaml-assistant:latest',
    'ghcr.io/example/k8s-yaml-assistant@sha256:abc',
  ]) {
    assert.throws(() => assertImmutableDeploymentImageReference(value));
  }
});

test('runtime content audit rejects development, credential, index and trace paths', () => {
  const forbidden = [
    'app/.env',
    'app/.git/config',
    'app/src/server/health.ts',
    'app/scripts/container-smoke.test.ts',
    'app/node_modules/typescript/bin/tsc',
    'app/.npm/_cacache/index-v5/fixture',
    'app/data/index/manifest.json',
    'app/data/observability/serving-000001.jsonl',
    'app/data/eval/runs/run-1.json',
    'app/data/eval/traces/trace-1.jsonl',
    'run/secrets/voyage_api_key',
    'var/run/secrets/kubernetes.io/serviceaccount/token',
  ];

  assert.deepEqual(findForbiddenRuntimePaths(forbidden), forbidden);
  assert.deepEqual(
    findForbiddenRuntimePaths([
      'app/server.js',
      'app/.next/server/app/api/health/ready/route.js',
      'app/data/policies.json',
      'app/data/schemas/generated/resources/core.v1.Pod.json',
      'app/node_modules/next/package.json',
      'app/node_modules/@anthropic-ai/sdk/core/api.d.mts',
    ]),
    [],
  );
});

test('candidate runtime audit permits only the three reviewed index files', () => {
  const indexPaths = [
    'app/data/index/manifest.json',
    'app/data/index/chunks.jsonl',
    'app/data/index/embeddings.f32',
  ];
  assert.deepEqual(
    findForbiddenRuntimePaths(indexPaths, { allowCandidateIndex: true }),
    [],
  );
  assert.deepEqual(
    findForbiddenRuntimePaths(
      [...indexPaths, 'app/data/index/debug-dump.json'],
      { allowCandidateIndex: true },
    ),
    ['app/data/index/debug-dump.json'],
  );
});

test('candidate smoke accepts only an immutable image digest', () => {
  const image = `ghcr.io/example/k8s-yaml-assistant@sha256:${'a'.repeat(64)}`;
  assert.deepEqual(
    parseContainerSmokeArguments(['--image', image, '--expect-ready']),
    {
      image,
      mode: 'expect-ready',
    },
  );
  for (const mutable of [
    'ghcr.io/example/k8s-yaml-assistant:main',
    'ghcr.io/example/k8s-yaml-assistant:release',
  ]) {
    assert.throws(() =>
      parseContainerSmokeArguments([
        '--image',
        mutable,
        '--expect-ready',
      ]),
    );
  }
});

test('runtime-base smoke names the exact index-missing expectation', () => {
  const image = 'k8s-yaml-assistant:test-runtime-base';
  assert.deepEqual(
    parseContainerSmokeArguments([
      '--image',
      image,
      '--expect-index-missing',
    ]),
    {
      image,
      mode: 'expect-index-missing',
    },
  );
  assert.throws(() =>
    parseContainerSmokeArguments(['--image', image, '--expect-not-ready']),
  );
});

test('build context selection includes only tracked and reviewed files', () => {
  assert.deepEqual(
    selectBuildContextPaths(
      ['src/server/health.ts', 'data/schemas/generated/manifest.json'],
      ['Dockerfile', '.dockerignore', 'Dockerfile'],
    ),
    [
      '.dockerignore',
      'Dockerfile',
      'data/schemas/generated/manifest.json',
      'src/server/health.ts',
    ],
  );
  for (const unsafe of ['/tmp/secret', '../outside', 'src/../../outside']) {
    assert.throws(() => selectBuildContextPaths([unsafe], []), /unsafe/);
  }
});

test('reviewed release files enter the clean build context before staging', () => {
  const required = [
    '.github/workflows/index-build.yml',
    '.github/workflows/release-artifacts.yml',
    '.github/workflows/release.yml',
    '.release-please-manifest.json',
    'release-please-config.json',
    'scripts/release-manifest-cli.test.ts',
    'scripts/release-manifest.ts',
    'src/release/manifest.test.ts',
    'src/release/manifest.ts',
  ];
  const reviewed = new Set<string>(REVIEWED_WORKTREE_CONTEXT_FILES);

  for (const path of required) {
    assert.ok(
      reviewed.has(path),
      `missing reviewed build-context file: ${path}`,
    );
  }
});
