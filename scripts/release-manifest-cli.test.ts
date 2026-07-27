import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { KNOWLEDGE_IDENTITY_VERSION } from '../src/knowledge/identity';
import { INDEX_FORMAT_VERSION } from '../src/retrieval/index-store';

function githubOutputs(path: string): Map<string, string> {
  return new Map(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
}

test('index-identity emits only workflow-consumed outputs', () => {
  const tempDir = mkdtempSync(
    join(tmpdir(), 'k8s-yaml-assistant-release-manifest-'),
  );
  const outputPath = join(tempDir, 'github-output');

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/release-manifest.ts',
        'index-identity',
        '--github-output',
        outputPath,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    assert.equal(
      result.status,
      0,
      `index-identity failed:\n${result.stderr}`,
    );
    const outputs = githubOutputs(outputPath);
    assert.deepEqual([...outputs.keys()].sort(), [
      'embedding_model',
      'index_hash',
      'index_image',
      'index_tag',
    ]);
    assert.equal(outputs.get('embedding_model'), 'voyage-3');

    const overridden = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/release-manifest.ts',
        'index-identity',
        '--embedding-model',
        'voyage-4',
        '--github-output',
        outputPath,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    assert.notEqual(overridden.status, 0);
    assert.match(overridden.stderr, /unknown.*--embedding-model/u);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('prepare emits only the release notes identity consumed by the workflow', () => {
  const tempDir = mkdtempSync(
    join(tmpdir(), 'k8s-yaml-assistant-release-prepare-'),
  );
  const outputPath = join(tempDir, 'github-output');
  const releasePath = join(tempDir, 'release.json');
  const sourceCommit = 'a'.repeat(40);
  const version = (
    JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  ).version;
  writeFileSync(
    releasePath,
    JSON.stringify({
      name: version,
      tagName: `v${version}`,
      targetCommitish: sourceCommit,
      isDraft: true,
      isPrerelease: false,
      body: [
        '### Features',
        '',
        '- Build verified release evidence.',
        '',
        '### Known limitations',
        '',
        '- Production deployment is not enabled.',
        '',
      ].join('\n'),
      assets: [],
    }),
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/release-manifest.ts',
        'prepare',
        '--release-json',
        releasePath,
        '--source-sha',
        sourceCommit,
        '--github-output',
        outputPath,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, `prepare failed:\n${result.stderr}`);
    assert.deepEqual([...githubOutputs(outputPath).keys()], [
      'release_notes_sha256',
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('verify-published writes only the deployment authorization identity', () => {
  const tempDir = mkdtempSync(
    join(tmpdir(), 'k8s-yaml-assistant-published-release-'),
  );
  const assetsDir = join(tempDir, 'assets');
  const identityPath = join(tempDir, 'identity.json');
  const releasePath = join(tempDir, 'release.json');
  const sourceCommit = 'a'.repeat(40);
  const imageDigest = `sha256:${'b'.repeat(64)}`;
  const releaseNotes = [
    '### Features',
    '',
    '- Build verified release evidence.',
    '',
    '### Known limitations',
    '',
    '- Production is single-node and single-replica.',
    '',
  ].join('\n');
  const sha256 = (value: string | Uint8Array): string =>
    createHash('sha256').update(value).digest('hex');
  const predicate = {
    buildDefinition: {
      buildType:
        'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md',
      externalParameters: {
        configSource: { path: 'Dockerfile' },
        request: {
          args: { target: 'runtime' },
          root: {
            configSource: {
              path: 'Dockerfile',
            },
            request: {
              args: {
                'vcs:source':
                  'https://github.com/kkxiaoa/k8s-yaml-assistant',
                'vcs:revision': sourceCommit,
              },
            },
          },
        },
      },
    },
  };
  const provenance = Buffer.from(`${JSON.stringify(predicate)}\n`);
  const provenanceBundle = Buffer.from(
    `${JSON.stringify({
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: Buffer.from(
          JSON.stringify({
            _type: 'https://in-toto.io/Statement/v0.1',
            subject: [
              {
                name: 'ghcr.io/kkxiaoa/k8s-yaml-assistant',
                digest: {
                  sha256: imageDigest.slice('sha256:'.length),
                },
              },
            ],
            predicateType: 'https://slsa.dev/provenance/v1',
            predicate,
          }),
        ).toString('base64'),
      },
    })}\n`,
  );
  const sbom = Buffer.from(
    '{"spdxVersion":"SPDX-2.3","packages":[{"name":"app"}]}\n',
  );
  const sbomBundle = Buffer.from(
    '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}\n',
  );
  const manifestBundle = Buffer.from(
    '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}\n',
  );
  const packageJson = JSON.parse(
    readFileSync('package.json', 'utf8'),
  ) as {
    version: string;
    dependencies: { next: string };
  };
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const indexHash = '8'.repeat(64);
  const manifest = {
    schemaVersion: 2,
    release: {
      version: packageJson.version,
      tag: `v${packageJson.version}`,
      sourceCommit,
      changelogPath: 'CHANGELOG.md',
      changelogSha256: sha256(changelog),
      releaseNotesSha256: sha256(releaseNotes),
      manifestBundlePath: 'release-manifest.sigstore.json',
    },
    image: {
      name: 'ghcr.io/kkxiaoa/k8s-yaml-assistant',
      digest: imageDigest,
      platform: 'linux/amd64',
    },
    build: {
      nodeVersion: '24.18.0',
      nextVersion: packageJson.dependencies.next,
      repository: 'kkxiaoa/k8s-yaml-assistant',
      workflow: '.github/workflows/release-artifacts.yml',
      workflowRef:
        'kkxiaoa/k8s-yaml-assistant/.github/workflows/release-artifacts.yml@refs/heads/main',
      workflowRunUrl:
        'https://github.com/kkxiaoa/k8s-yaml-assistant/actions/runs/123',
      nodeBaseImage: `node@sha256:${'1'.repeat(64)}`,
      runtimeBaseImage: `distroless@sha256:${'2'.repeat(64)}`,
    },
    corpus: {
      identityVersion: KNOWLEDGE_IDENTITY_VERSION,
      count: 8410,
      manifestHash: '3'.repeat(64),
    },
    index: {
      formatVersion: INDEX_FORMAT_VERSION,
      corpusIdentityVersion: KNOWLEDGE_IDENTITY_VERSION,
      embeddingModel: 'voyage-3',
      dimension: 1024,
      count: 8410,
      indexHash,
      chunksHash: '4'.repeat(64),
      embeddingsHash: '5'.repeat(64),
      createdAt: '2026-07-27T07:00:00Z',
      artifact: {
        name: 'ghcr.io/kkxiaoa/k8s-yaml-assistant-index',
        tag: `index-v${INDEX_FORMAT_VERSION}-${indexHash}`,
        digest: `sha256:${'6'.repeat(64)}`,
        certificateIdentity:
          'https://github.com/kkxiaoa/k8s-yaml-assistant/.github/workflows/index-build.yml@refs/heads/main',
        oidcIssuer: 'https://token.actions.githubusercontent.com',
      },
    },
    sbom: {
      path: 'sbom.spdx.json',
      format: 'spdx-2.3-json',
      sha256: sha256(sbom),
    },
    provenance: {
      path: 'provenance.slsa.json',
      sha256: sha256(provenance),
      predicateType: 'https://slsa.dev/provenance/v1',
    },
    attestations: {
      provider: 'sigstore-cosign',
      subjectDigest: imageDigest,
      certificateIdentity:
        'https://github.com/kkxiaoa/k8s-yaml-assistant/.github/workflows/release-artifacts.yml@refs/heads/main',
      oidcIssuer: 'https://token.actions.githubusercontent.com',
      sbom: {
        bundlePath: 'sbom-attestation.sigstore.json',
        bundleSha256: sha256(sbomBundle),
        predicateType: 'https://spdx.dev/Document',
      },
      provenance: {
        bundlePath: 'provenance-attestation.sigstore.json',
        bundleSha256: sha256(provenanceBundle),
        predicateType: 'https://slsa.dev/provenance/v1',
      },
    },
    deployment: {
      status: 'candidate',
      currentProductionDigest: null,
      rollback: {
        eligible: false,
        digest: null,
        reason: 'not_deployed',
      },
    },
  };
  const artifacts = {
    'sbom.spdx.json': sbom,
    'provenance.slsa.json': provenance,
    'release-manifest.json': Buffer.from(
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
    'sbom-attestation.sigstore.json': sbomBundle,
    'provenance-attestation.sigstore.json': provenanceBundle,
    'release-manifest.sigstore.json': manifestBundle,
  };
  mkdirSync(assetsDir);
  for (const [name, bytes] of Object.entries(artifacts)) {
    writeFileSync(join(assetsDir, name), bytes);
  }
  writeFileSync(
    releasePath,
    `${JSON.stringify({
      databaseId: 123,
      tagName: `v${packageJson.version}`,
      targetCommitish: sourceCommit,
      isDraft: false,
      isPrerelease: false,
      publishedAt: '2026-07-27T08:00:00Z',
      body: releaseNotes.trimEnd(),
      assets: Object.keys(artifacts).map((name) => ({ name })),
    })}\n`,
  );

  try {
    const verifyArgs = [
      '--import',
      'tsx',
      'scripts/release-manifest.ts',
      'verify-published',
      '--release-json',
      releasePath,
      '--assets-dir',
      assetsDir,
      '--tag-commit',
      sourceCommit,
      '--identity-out',
      identityPath,
    ];
    const result = spawnSync(
      process.execPath,
      verifyArgs,
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(
      JSON.parse(readFileSync(identityPath, 'utf8')),
      {
        releaseId: '123',
        releaseTag: `v${packageJson.version}`,
        sourceCommit,
        publishedAt: '2026-07-27T08:00:00Z',
        imageName: 'ghcr.io/kkxiaoa/k8s-yaml-assistant',
        imageDigest,
        provenanceBundleSha256: sha256(provenanceBundle),
      },
    );

    writeFileSync(join(assetsDir, 'extra.txt'), 'unexpected\n');
    const extraArtifact = spawnSync(process.execPath, verifyArgs, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.notEqual(extraArtifact.status, 0);
    assert.match(extraArtifact.stderr, /exactly six artifacts/u);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
