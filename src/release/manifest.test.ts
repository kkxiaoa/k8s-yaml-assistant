import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { KNOWLEDGE_IDENTITY_VERSION } from '../knowledge/identity';
import {
  computeIndexHash,
  INDEX_FORMAT_VERSION,
} from '../retrieval/index-store';
import {
  INDEX_ARTIFACT_IMAGE,
  RELEASE_ARTIFACT_FILES,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  assertBuildKitSlsaV1Provenance,
  decodeReleaseManifest,
  deriveIndexArtifactIdentity,
  releaseNotesSha256,
  resolveDraftReleaseIdentity,
  resolveReleasePreparation,
  resolveReleaseIdentity,
  resolveReleaseSourceState,
  verifyDraftRelease,
} from './manifest';

const sha = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const buildKitSlsaV1BuildType =
  'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md';

const packageJson = {
  name: 'k8s-yaml-assistant',
  version: '0.1.0',
  private: true,
};

const packageLock = {
  name: 'k8s-yaml-assistant',
  version: '0.1.0',
  packages: {
    '': {
      name: 'k8s-yaml-assistant',
      version: '0.1.0',
      dependencies: {},
    },
    'node_modules/example': {
      version: '1.0.0',
    },
  },
};

const releasePleaseManifest = {
  '.': '0.1.0',
};

const changelog = `# Changelog

> 状态：当前维护。
> 用途：记录面向使用者的版本变化、部署边界和已知限制。

## [Unreleased]

## [0.1.0] - 2026-07-24

### Features

- 支持带依据的 Kubernetes YAML 编写、检查、生成与修复。

### Known limitations

- 当前只承诺单节点、单副本部署。
`;

const releaseNotes = `### Features

- Release Please 根据已审核提交生成此发布说明。

### Known limitations

- 当前只承诺单节点、单副本部署。
`;

const sourceCommit = 'a'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const indexArtifactDigest = `sha256:${'9'.repeat(64)}`;
const corpusManifest = {
  identityVersion: KNOWLEDGE_IDENTITY_VERSION,
  count: 8410,
  manifestHash:
    'a8a8cfb843289b7b66b37e6864221e887942f6183da97c9848ea93ea6b689daa',
};
const expectedIndexHash = computeIndexHash(corpusManifest, 'voyage-3');
const indexArtifact = deriveIndexArtifactIdentity(
  corpusManifest,
  'voyage-3',
);

function draftRelease(
  assets: readonly { name: string }[] = RELEASE_ARTIFACT_FILES.map((name) => ({
    name,
  })),
): Record<string, unknown> {
  return {
    databaseId: 123,
    name: 'v0.1.0',
    tagName: 'v0.1.0',
    targetCommitish: sourceCommit,
    isDraft: true,
    isPrerelease: false,
    body: releaseNotes.trimEnd(),
    assets,
    url: 'https://github.com/kkxiaoa/k8s-yaml-assistant/releases/tag/untagged-fixture',
  };
}

function releaseSourceState() {
  return resolveReleaseSourceState({
    packageJson,
    packageLock,
    releasePleaseManifest,
    changelog,
  });
}

function listedRelease(input: {
  tagName: string;
  targetCommitish: string;
  isDraft: boolean;
  isPrerelease?: boolean;
}): Record<string, unknown> {
  return {
    tagName: input.tagName,
    targetCommitish: input.targetCommitish,
    isDraft: input.isDraft,
    isPrerelease: input.isPrerelease ?? false,
  };
}

function releasePullRequest(
  mergeCommitSha: string = sourceCommit,
): Record<string, unknown> {
  return {
    author: 'github-actions[bot]',
    base: 'main',
    head: 'release-please--branches--main--components--k8s-yaml-assistant',
    mergedAt: '2026-07-26T08:00:00Z',
    mergeCommitSha,
  };
}

function validManifest(): Record<string, unknown> {
  const identity = resolveReleaseIdentity({
    packageJson,
    packageLock,
    releasePleaseManifest,
    changelog,
  });
  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    release: {
      version: identity.version,
      tag: identity.tag,
      sourceCommit,
      changelogPath: 'CHANGELOG.md',
      changelogSha256: identity.changelogSha256,
      releaseNotesSha256: releaseNotesSha256(releaseNotes),
      manifestBundlePath: 'release-manifest.sigstore.json',
    },
    image: {
      name: 'ghcr.io/kkxiaoa/k8s-yaml-assistant',
      digest: imageDigest,
      platform: 'linux/amd64',
    },
    build: {
      nodeVersion: '24.18.0',
      nextVersion: '16.2.9',
      repository: 'kkxiaoa/k8s-yaml-assistant',
      workflow: '.github/workflows/release-artifacts.yml',
      workflowRef:
        'kkxiaoa/k8s-yaml-assistant/.github/workflows/release-artifacts.yml@refs/heads/main',
      workflowRunUrl:
        'https://github.com/kkxiaoa/k8s-yaml-assistant/actions/runs/123',
      nodeBaseImage:
        'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d',
      runtimeBaseImage:
        'gcr.io/distroless/cc-debian12:nonroot@sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e',
    },
    corpus: corpusManifest,
    index: {
      formatVersion: INDEX_FORMAT_VERSION,
      corpusIdentityVersion: KNOWLEDGE_IDENTITY_VERSION,
      embeddingModel: 'voyage-3',
      dimension: 1024,
      count: 8410,
      indexHash: indexArtifact.indexHash,
      chunksHash: 'd'.repeat(64),
      embeddingsHash: 'e'.repeat(64),
      createdAt: '2026-07-24T12:00:00.000Z',
      artifact: {
        name: INDEX_ARTIFACT_IMAGE,
        tag: indexArtifact.tag,
        digest: indexArtifactDigest,
        certificateIdentity:
          'https://github.com/kkxiaoa/k8s-yaml-assistant/.github/workflows/index-build.yml@refs/heads/main',
        oidcIssuer: 'https://token.actions.githubusercontent.com',
      },
    },
    sbom: {
      path: 'sbom.spdx.json',
      format: 'spdx-2.3-json',
      sha256: 'f'.repeat(64),
    },
    provenance: {
      path: 'provenance.slsa.json',
      sha256: '2'.repeat(64),
      predicateType: 'https://slsa.dev/provenance/v1',
    },
    attestations: {
      subjectDigest: imageDigest,
      provider: 'sigstore-cosign',
      certificateIdentity:
        'https://github.com/kkxiaoa/k8s-yaml-assistant/.github/workflows/release-artifacts.yml@refs/heads/main',
      oidcIssuer: 'https://token.actions.githubusercontent.com',
      sbom: {
        bundlePath: 'sbom-attestation.sigstore.json',
        bundleSha256: '1'.repeat(64),
        predicateType: 'https://spdx.dev/Document',
      },
      provenance: {
        bundlePath: 'provenance-attestation.sigstore.json',
        bundleSha256: '3'.repeat(64),
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
}

test('BuildKit SLSA v1 provenance uses the v1 build definition identity', () => {
  assert.doesNotThrow(() =>
    assertBuildKitSlsaV1Provenance({
      buildDefinition: {
        buildType: buildKitSlsaV1BuildType,
      },
      runDetails: {
        builder: {
          id: 'https://github.com/docker/build-push-action',
        },
      },
    }),
  );
  assert.throws(() =>
    assertBuildKitSlsaV1Provenance({
      buildType: 'https://mobyproject.org/buildkit@v1',
    }),
  );
  assert.throws(() =>
    assertBuildKitSlsaV1Provenance({
      buildDefinition: {
        buildType: 'https://mobyproject.org/buildkit@v1',
      },
    }),
  );
});

test('release identity validates source metadata without extracting release notes', () => {
  const identity = resolveReleaseIdentity({
    packageJson,
    packageLock,
    releasePleaseManifest,
    changelog,
  });

  assert.deepEqual(identity, {
    version: '0.1.0',
    tag: 'v0.1.0',
    changelogPath: 'CHANGELOG.md',
    changelogSha256: sha(changelog),
  });
  assert.notEqual(releaseNotes, changelog);
  assert.equal(releaseNotesSha256(releaseNotes), sha(releaseNotes));
  assert.doesNotMatch(
    readFileSync('src/release/manifest.ts', 'utf8'),
    /\.passthrough\s*\(/u,
  );
});

test('repository release source state is internally consistent', () => {
  const currentPackage = JSON.parse(
    readFileSync('package.json', 'utf8'),
  ) as unknown;
  const currentState = resolveReleaseSourceState({
    packageJson: currentPackage,
    packageLock: JSON.parse(
      readFileSync('package-lock.json', 'utf8'),
    ) as unknown,
    releasePleaseManifest: JSON.parse(
      readFileSync('.release-please-manifest.json', 'utf8'),
    ) as unknown,
    changelog: existsSync('CHANGELOG.md')
      ? readFileSync('CHANGELOG.md', 'utf8')
      : null,
  });

  assert.equal(
    currentState.status,
    (currentPackage as { version?: unknown }).version === '0.0.0'
      ? 'placeholder'
      : 'release',
  );
});

test('release source state rejects placeholder/changelog and stable/no-changelog drift', () => {
  assert.throws(() =>
    resolveReleaseSourceState({
      packageJson: { ...packageJson, version: '0.0.0' },
      packageLock: {
        ...packageLock,
        version: '0.0.0',
        packages: {
          ...packageLock.packages,
          '': { ...packageLock.packages[''], version: '0.0.0' },
        },
      },
      releasePleaseManifest: { '.': '0.0.0' },
      changelog,
    }),
  );
  assert.throws(() =>
    resolveReleaseSourceState({
      packageJson,
      packageLock,
      releasePleaseManifest,
      changelog: null,
    }),
  );
});

test('release identity rejects version and changelog identity drift', async (t) => {
  const mutations: Array<{
    name: string;
    input: Parameters<typeof resolveReleaseIdentity>[0];
  }> = [
    {
      name: 'placeholder',
      input: {
        packageJson: { ...packageJson, version: '0.0.0' },
        packageLock: {
          ...packageLock,
          version: '0.0.0',
          packages: {
            ...packageLock.packages,
            '': { ...packageLock.packages[''], version: '0.0.0' },
          },
        },
        releasePleaseManifest: { '.': '0.0.0' },
        changelog,
      },
    },
    {
      name: 'lockfile drift',
      input: {
        packageJson,
        packageLock: { ...packageLock, version: '0.1.1' },
        releasePleaseManifest,
        changelog,
      },
    },
    {
      name: 'manifest drift',
      input: {
        packageJson,
        packageLock,
        releasePleaseManifest: { '.': '0.1.1' },
        changelog,
      },
    },
    {
      name: 'missing release heading',
      input: {
        packageJson,
        packageLock,
        releasePleaseManifest,
        changelog: changelog.replace('## [0.1.0]', '## [0.2.0]'),
      },
    },
    {
      name: 'duplicate release heading',
      input: {
        packageJson,
        packageLock,
        releasePleaseManifest,
        changelog: `${changelog}\n## 0.1.0\n`,
      },
    },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, () => {
      assert.throws(() => resolveReleaseIdentity(mutation.input));
    });
  }
});

test('release identity rejects unsafe changelog metadata', async (t) => {
  const mutations: Array<[string, string]> = [
    ['missing status', changelog.replace('> 状态：当前维护。\n', '')],
    ['missing purpose', changelog.replace(/^> 用途：.*\n/mu, '')],
    [
      'duplicate top-level heading',
      changelog.replace('# Changelog', '# Changelog\n\n# Changelog'),
    ],
    ['missing unreleased heading', changelog.replace('## [Unreleased]\n\n', '')],
    [
      'placeholder',
      changelog.replace(
        '## [Unreleased]\n\n',
        '## [Unreleased]\n\n- TODO\n\n',
      ),
    ],
    [
      'local path',
      changelog.replace(
        '- 当前只承诺单节点、单副本部署。',
        '- 读取 /Users/example/private/config。',
      ),
    ],
    [
      'secret assignment',
      changelog.replace(
        '- 当前只承诺单节点、单副本部署。',
        '- VOYAGE_API_KEY=example-secret-value',
      ),
    ],
  ];

  for (const [name, candidate] of mutations) {
    await t.test(name, () => {
      assert.throws(() =>
        resolveReleaseIdentity({
          packageJson,
          packageLock,
          releasePleaseManifest,
          changelog: candidate,
        }),
      );
    });
  }
});

test('Release Please draft body owns release-notes identity', () => {
  const resolved = resolveDraftReleaseIdentity({
    release: draftRelease([]),
    expectedTag: 'v0.1.0',
    expectedSourceCommit: sourceCommit,
  });
  assert.equal(resolved.body, releaseNotes);
  assert.equal(resolved.releaseNotesSha256, sha(releaseNotes));
});

test('draft release identity rejects unsafe or mismatched generated notes', async (t) => {
  const mutations: Array<[string, (value: Record<string, any>) => void]> = [
    ['published', (value) => (value.isDraft = false)],
    ['prerelease', (value) => (value.isPrerelease = true)],
    ['tag drift', (value) => (value.tagName = 'v0.2.0')],
    ['source drift', (value) => (value.targetCommitish = 'b'.repeat(40))],
    [
      'missing limitations',
      (value) => (value.body = '### Features\n\n- change\n'),
    ],
    [
      'secret assignment',
      (value) =>
        (value.body = `${releaseNotes}\nVOYAGE_API_KEY=example-secret-value\n`),
    ],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const value = draftRelease([]);
      mutate(value);
      assert.throws(() =>
        resolveDraftReleaseIdentity({
          release: value,
          expectedTag: 'v0.1.0',
          expectedSourceCommit: sourceCommit,
        }),
      );
    });
  }
});

test('release preparation distinguishes development, release merge and active draft states', async (t) => {
  await t.test('published version allows the next release PR update', () => {
    assert.deepEqual(
      resolveReleasePreparation({
        sourceState: releaseSourceState(),
        releases: [
          listedRelease({
            tagName: 'v0.1.0',
            targetCommitish: sourceCommit,
            isDraft: false,
          }),
        ],
        associatedPullRequests: [],
        headCommit: 'b'.repeat(40),
        currentTagCommit: sourceCommit,
      }),
      {
        action: 'prepare',
        historyBoundaryCommit: sourceCommit,
      },
    );
  });

  await t.test('release PR merge creates only the current draft', () => {
    assert.deepEqual(
      resolveReleasePreparation({
        sourceState: releaseSourceState(),
        releases: [],
        associatedPullRequests: [releasePullRequest()],
        headCommit: sourceCommit,
        currentTagCommit: null,
      }),
      {
        action: 'create-draft',
        historyBoundaryCommit: null,
      },
    );
  });

  await t.test('active draft defers the next release PR', () => {
    assert.deepEqual(
      resolveReleasePreparation({
        sourceState: releaseSourceState(),
        releases: [
          listedRelease({
            tagName: 'v0.1.0',
            targetCommitish: sourceCommit,
            isDraft: true,
          }),
          listedRelease({
            tagName: 'rollback-2026-07-26',
            targetCommitish: sourceCommit,
            isDraft: true,
          }),
        ],
        associatedPullRequests: [],
        headCommit: 'b'.repeat(40),
        currentTagCommit: null,
      }),
      {
        action: 'defer',
        historyBoundaryCommit: sourceCommit,
      },
    );
  });

  await t.test('placeholder source can prepare the first release PR', () => {
    assert.deepEqual(
      resolveReleasePreparation({
        sourceState: {
          status: 'placeholder',
          version: '0.0.0',
        },
        releases: [],
        associatedPullRequests: [],
        headCommit: sourceCommit,
        currentTagCommit: null,
      }),
      {
        action: 'prepare',
        historyBoundaryCommit: null,
      },
    );
  });
});

test('release preparation fails closed on ambiguous or broken lifecycle state', () => {
  const activeDraft = listedRelease({
    tagName: 'v0.1.0',
    targetCommitish: sourceCommit,
    isDraft: true,
  });
  const published = listedRelease({
    tagName: 'v0.1.0',
    targetCommitish: sourceCommit,
    isDraft: false,
  });
  const invalidInputs = [
    {
      releases: [],
      associatedPullRequests: [],
      currentTagCommit: null,
    },
    {
      releases: [published],
      associatedPullRequests: [],
      currentTagCommit: null,
    },
    {
      releases: [],
      associatedPullRequests: [],
      currentTagCommit: sourceCommit,
    },
    {
      releases: [
        listedRelease({
          tagName: 'v0.1.0',
          targetCommitish: 'b'.repeat(40),
          isDraft: false,
        }),
      ],
      associatedPullRequests: [],
      currentTagCommit: sourceCommit,
    },
    {
      releases: [activeDraft],
      associatedPullRequests: [releasePullRequest()],
      currentTagCommit: null,
    },
    {
      releases: [
        activeDraft,
        listedRelease({
          tagName: 'v0.2.0',
          targetCommitish: 'b'.repeat(40),
          isDraft: true,
        }),
      ],
      associatedPullRequests: [],
      currentTagCommit: null,
    },
    {
      releases: [
        listedRelease({
          tagName: 'v0.2.0',
          targetCommitish: sourceCommit,
          isDraft: true,
        }),
      ],
      associatedPullRequests: [],
      currentTagCommit: null,
    },
    {
      releases: [],
      associatedPullRequests: [
        releasePullRequest(),
        releasePullRequest(),
      ],
      currentTagCommit: null,
    },
  ];

  for (const input of invalidInputs) {
    assert.throws(() =>
      resolveReleasePreparation({
        sourceState: releaseSourceState(),
        headCommit: sourceCommit,
        ...input,
      }),
    );
  }

  assert.throws(() =>
    resolveReleasePreparation({
      sourceState: {
        status: 'placeholder',
        version: '0.0.0',
      },
      releases: [
        listedRelease({
          tagName: 'v0.1.0',
          targetCommitish: sourceCommit,
          isDraft: false,
        }),
      ],
      associatedPullRequests: [],
      headCommit: sourceCommit,
      currentTagCommit: null,
    }),
  );
});

test('index artifact identity is derived from corpus, model and format', () => {
  assert.deepEqual(indexArtifact, {
    name: INDEX_ARTIFACT_IMAGE,
    tag: `index-v${INDEX_FORMAT_VERSION}-${expectedIndexHash}`,
    indexHash: expectedIndexHash,
    formatVersion: INDEX_FORMAT_VERSION,
    corpusIdentityVersion: KNOWLEDGE_IDENTITY_VERSION,
    embeddingModel: 'voyage-3',
  });
});

test('index artifact identity rejects a non-canonical embedding model', () => {
  assert.throws(
    () => deriveIndexArtifactIdentity(corpusManifest, ' voyage-3'),
    /embeddingModel must be a non-empty trimmed string/u,
  );
});

test('release manifest accepts a closed image/index/release identity', () => {
  const decoded = decodeReleaseManifest(validManifest());
  assert.equal(decoded.release.version, '0.1.0');
  assert.equal(decoded.image.digest, decoded.attestations.subjectDigest);
  assert.equal(decoded.corpus.count, decoded.index.count);
  assert.equal(
    decoded.index.artifact.tag,
    `index-v${INDEX_FORMAT_VERSION}-${decoded.index.indexHash}`,
  );
});

test('release manifest rejects image, index artifact and rollback drift', () => {
  const mutations: Array<(value: Record<string, any>) => void> = [
    (value) => {
      value.schemaVersion = 1;
    },
    (value) => {
      value.release.tag = 'latest';
    },
    (value) => {
      value.image.digest = `sha256:${'7'.repeat(64)}`;
    },
    (value) => {
      value.index.count = 8127;
    },
    (value) => {
      value.corpus.contentHash = 'a'.repeat(64);
    },
    (value) => {
      value.index.artifact.tag =
        `index-v${INDEX_FORMAT_VERSION}-${'8'.repeat(64)}`;
    },
    (value) => {
      value.index.artifact.name = 'ghcr.io/other/index';
    },
    (value) => {
      value.attestations.provider = 'none';
    },
    (value) => {
      value.deployment.rollback = {
        eligible: true,
        digest: null,
        reason: 'accepted',
      };
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(validManifest());
    mutate(candidate);
    assert.throws(() => decodeReleaseManifest(candidate));
  }
});

test('draft readback preserves Release Please notes, source and six assets', () => {
  const expectedNotesHash = releaseNotesSha256(releaseNotes);
  const verified = verifyDraftRelease({
    release: draftRelease(),
    expectedTag: 'v0.1.0',
    expectedSourceCommit: sourceCommit,
    expectedReleaseNotesSha256: expectedNotesHash,
  });

  assert.equal(verified.releaseNotesSha256, expectedNotesHash);
  assert.deepEqual(
    verified.assets.map((asset) => asset.name),
    [...RELEASE_ARTIFACT_FILES],
  );
});

test('draft readback rejects body and asset drift', () => {
  const expectedReleaseNotesSha256 = releaseNotesSha256(releaseNotes);
  const mutations: Array<(value: Record<string, any>) => void> = [
    (value) => {
      value.body = `${releaseNotes}\n- unreviewed\n`;
    },
    (value) => {
      value.assets = value.assets.slice(1);
    },
    (value) => {
      value.assets.push({ name: 'extra.txt' });
    },
  ];
  for (const mutate of mutations) {
    const value = draftRelease();
    mutate(value);
    assert.throws(() =>
      verifyDraftRelease({
        release: value,
        expectedTag: 'v0.1.0',
        expectedSourceCommit: sourceCommit,
        expectedReleaseNotesSha256,
      }),
    );
  }
});
