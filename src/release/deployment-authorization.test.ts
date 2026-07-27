import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createDeploymentAuthorization,
  createDeploymentRequest,
  createGitHubDeploymentRequest,
  createGitHubDeploymentStatusRequest,
  resolveAdapterResult,
  resolveCurrentProductionDigest,
  resolveDeploymentReleaseTag,
  resolveRollbackCandidateTag,
  verifyRollbackDraftRelease,
  verifyPublishedRollbackRelease,
} from './deployment-authorization';

const sourceCommit = 'a'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const previousDigest = `sha256:${'c'.repeat(64)}`;
const provenanceBundle = '{"mediaType":"fixture"}\n';
const authorizationBundle = '{"verificationMaterial":"fixture"}\n';
const repositoryUrl =
  'https://api.github.com/repos/kkxiaoa/k8s-yaml-assistant';

function authorizationInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: 'deploy',
    releaseId: '123',
    releaseTag: 'v0.1.0',
    sourceCommit,
    publishedAt: '2026-07-27T08:00:00Z',
    imageDigest,
    provenanceBundleSha256: createHash('sha256')
      .update(provenanceBundle)
      .digest('hex'),
    workflowRunId: '456',
    workflowRunAttempt: '1',
    ...overrides,
  };
}

function deploymentPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    repository: 'kkxiaoa/k8s-yaml-assistant',
    environment: 'production-private',
    action: 'deploy',
    releaseId: '123',
    releaseTag: 'v0.1.0',
    releaseCommit: sourceCommit,
    sourceCommit,
    imageDigest,
    workflowRunId: '456',
    workflowRunAttempt: '1',
    ...overrides,
  };
}

function deploymentRecord(input: {
  state?: string;
  statusCreatedAt?: string;
  payload?: Record<string, unknown>;
  environment?: string;
  repositoryUrl?: string;
} = {}): Record<string, unknown> {
  return {
    deployment: {
      ref: sourceCommit,
      sha: sourceCommit,
      task: 'deploy',
      environment: input.environment ?? 'production-private',
      repositoryUrl: input.repositoryUrl ?? repositoryUrl,
      transientEnvironment: false,
      productionEnvironment: true,
      payload: input.payload ?? deploymentPayload(),
    },
    statuses: [
      {
        state: input.state ?? 'success',
        environment: input.environment ?? 'production-private',
        repositoryUrl: input.repositoryUrl ?? repositoryUrl,
        createdAt:
          input.statusCreatedAt ?? '2026-07-27T08:10:00Z',
      },
    ],
  };
}

test('deployment authorization has fixed bytes shared with the Python adapter', () => {
  const authorization = createDeploymentAuthorization(
    authorizationInput(),
  ).text;

  assert.equal(
    authorization,
    `${JSON.stringify({
      schemaVersion: 1,
      action: 'deploy',
      repository: 'kkxiaoa/k8s-yaml-assistant',
      releaseId: '123',
      releaseTag: 'v0.1.0',
      sourceCommit,
      publishedAt: '2026-07-27T08:00:00Z',
      imageName: 'ghcr.io/kkxiaoa/k8s-yaml-assistant',
      imageDigest,
      provenanceBundleSha256: createHash('sha256')
        .update(provenanceBundle)
        .digest('hex'),
      workflowRunId: '456',
      workflowRunAttempt: '1',
    })}\n`,
  );
});

test('deployment authorization rejects malformed fields and action/tag drift', async (t) => {
  const mutations: Array<[string, Record<string, unknown>]> = [
    ['unknown field', { extra: true }],
    ['missing field', { releaseId: undefined }],
    ['numeric release id', { releaseId: 123 }],
    ['zero release id', { releaseId: '0' }],
    ['unsafe integer release id', { releaseId: '1'.repeat(33) }],
    ['numeric workflow run id', { workflowRunId: 456 }],
    ['zero workflow attempt', { workflowRunAttempt: '0' }],
    ['invalid commit', { sourceCommit: 'main' }],
    ['invalid timestamp', { publishedAt: '2026-02-30T08:00:00Z' }],
    ['offset timestamp', { publishedAt: '2026-07-27T16:00:00+08:00' }],
    ['invalid digest', { imageDigest: 'latest' }],
    ['deploy with rollback tag', { releaseTag: `rollback-v0.1.0-${imageDigest}-r456` }],
    [
      'rollback with release tag',
      { action: 'rollback', releaseTag: 'v0.1.0' },
    ],
    [
      'rollback target drift',
      {
        action: 'rollback',
        releaseTag: `rollback-v0.1.0-sha256-${'d'.repeat(64)}-r456`,
      },
    ],
  ];

  for (const [name, mutation] of mutations) {
    await t.test(name, () => {
      assert.throws(() =>
        createDeploymentAuthorization(authorizationInput(mutation)),
      );
    });
  }
});

test('request envelope preserves raw bundle strings and enforces the adapter limit', () => {
  const authorization = createDeploymentAuthorization(
    authorizationInput(),
  ).text;
  const request = createDeploymentRequest({
    authorization,
    authorizationBundle,
    provenanceBundle,
  });
  const decoded = JSON.parse(request) as Record<string, unknown>;

  assert.equal(decoded.authorization, authorization);
  assert.equal(decoded.authorizationBundle, authorizationBundle);
  assert.equal(decoded.provenanceBundle, provenanceBundle);
  assert.ok(Buffer.byteLength(request) <= 64 * 1024);
  assert.throws(() =>
    createDeploymentRequest({
      authorization,
      authorizationBundle: JSON.parse(authorizationBundle),
      provenanceBundle,
    }),
  );
  assert.throws(() =>
    createDeploymentRequest({
      authorization,
      authorizationBundle,
      provenanceBundle: `${provenanceBundle}${'x'.repeat(64 * 1024)}`,
    }),
  );
});

test('request envelope reserves independent budgets for signed proof components', () => {
  const oversizedProvenanceBundle = `${JSON.stringify({
    padding: 'p'.repeat(32 * 1024),
  })}\n`;
  const authorizationForLargeProvenance =
    createDeploymentAuthorization(
      authorizationInput({
        provenanceBundleSha256: createHash('sha256')
          .update(oversizedProvenanceBundle)
          .digest('hex'),
      }),
    ).text;
  assert.throws(() =>
    createDeploymentRequest({
      authorization: authorizationForLargeProvenance,
      authorizationBundle,
      provenanceBundle: oversizedProvenanceBundle,
    }),
  );

  const oversizedAuthorizationBundle = `${JSON.stringify({
    padding: 'a'.repeat(28 * 1024),
  })}\n`;
  const authorization = createDeploymentAuthorization(
    authorizationInput(),
  ).text;
  assert.throws(() =>
    createDeploymentRequest({
      authorization,
      authorizationBundle: oversizedAuthorizationBundle,
      provenanceBundle,
    }),
  );
});

test('adapter result accepts a request above the result size limit', () => {
  const largeProvenanceBundle = `${JSON.stringify({
    padding: 'p'.repeat(8 * 1024),
  })}\n`;
  const authorization = createDeploymentAuthorization(
    authorizationInput({
      provenanceBundleSha256: createHash('sha256')
        .update(largeProvenanceBundle)
        .digest('hex'),
    }),
  ).text;
  const requestBase64 = Buffer.from(
    createDeploymentRequest({
      authorization,
      authorizationBundle,
      provenanceBundle: largeProvenanceBundle,
    }),
  ).toString('base64');
  const result = {
    event: 'k8s_yaml_assistant_deployment',
    action: 'deploy',
    releaseId: '123',
    releaseTag: 'v0.1.0',
    sourceCommit,
    workflowRunId: '456',
    workflowRunAttempt: '1',
    previousDigest: null,
    targetDigest: imageDigest,
    result: 'success',
    failureCode: null,
    durationMs: 1000,
  };

  assert.deepEqual(
    resolveAdapterResult({
      resultBase64: Buffer.from(`${JSON.stringify(result)}\n`).toString(
        'base64',
      ),
      requestBase64,
      jobResult: 'success',
    }),
    {
      state: 'success',
      description: 'Deployment adapter completed successfully.',
    },
  );
});

test('GitHub deployment requests carry only the audited non-sensitive payload', () => {
  const authorization = createDeploymentAuthorization(
    authorizationInput(),
  );
  const workflowRunUrl =
    'https://github.com/kkxiaoa/k8s-yaml-assistant/actions/runs/456';
  const deployment = JSON.parse(
    createGitHubDeploymentRequest({
      authorization: authorization.value,
      releaseCommit: sourceCommit,
    }),
  ) as Record<string, any>;

  assert.equal(deployment.ref, sourceCommit);
  assert.equal(deployment.environment, 'production-private');
  assert.equal(deployment.auto_merge, false);
  assert.deepEqual(deployment.required_contexts, []);
  assert.deepEqual(deployment.payload, deploymentPayload());
  assert.doesNotMatch(JSON.stringify(deployment), /provenanceBundle/u);
  assert.deepEqual(
    JSON.parse(
      createGitHubDeploymentStatusRequest({
        state: 'pending',
        description: 'Published release verified.',
        workflowRunUrl,
      }),
    ),
    {
      state: 'pending',
      log_url: workflowRunUrl,
      description: 'Published release verified.',
      environment: 'production-private',
      auto_inactive: false,
    },
  );
});

test('GitHub deployment status preserves an attempt-specific workflow run URL', () => {
  const workflowRunUrl =
    'https://github.com/kkxiaoa/k8s-yaml-assistant/actions/runs/456/attempts/3';

  assert.equal(
    JSON.parse(
      createGitHubDeploymentStatusRequest({
        state: 'failure',
        description: 'Deployment adapter failed.',
        workflowRunUrl,
      }),
    ).log_url,
    workflowRunUrl,
  );
  assert.throws(() =>
    createGitHubDeploymentStatusRequest({
      state: 'failure',
      description: 'Deployment adapter failed.',
      workflowRunUrl:
        'https://github.com/kkxiaoa/k8s-yaml-assistant/actions/runs/456/attempts/0',
    }),
  );
});

test('latest successful production deployment resolves one immutable digest', () => {
  assert.equal(resolveCurrentProductionDigest([]), null);
  assert.equal(
    resolveCurrentProductionDigest([
      deploymentRecord({
        statusCreatedAt: '2026-07-27T08:10:00Z',
        payload: deploymentPayload({ imageDigest: previousDigest }),
      }),
      deploymentRecord({
        statusCreatedAt: '2026-07-27T09:10:00Z',
      }),
    ]),
    imageDigest,
  );
  assert.equal(
    resolveCurrentProductionDigest([
      deploymentRecord({
        statusCreatedAt: '2026-07-27T08:10:00Z',
        payload: deploymentPayload({ imageDigest: previousDigest }),
      }),
      deploymentRecord({
        state: 'failure',
        statusCreatedAt: '2026-07-27T09:10:00Z',
      }),
    ]),
    previousDigest,
  );
  assert.equal(
    resolveCurrentProductionDigest([
      deploymentRecord({
        statusCreatedAt: '2026-07-27T08:10:00Z',
        payload: deploymentPayload({ imageDigest: previousDigest }),
      }),
      deploymentRecord({
        statusCreatedAt: '2026-07-27T08:10:00.500Z',
      }),
    ]),
    imageDigest,
  );
});

test('deployment history rejects false success and ambiguous identities', async (t) => {
  const invalid: Array<[string, unknown]> = [
    [
      'wrong repository',
      [deploymentRecord({ repositoryUrl: 'https://api.github.com/repos/other/repo' })],
    ],
    [
      'wrong environment',
      [deploymentRecord({ environment: 'production' })],
    ],
    [
      'invalid payload digest',
      [
        deploymentRecord({
          payload: deploymentPayload({ imageDigest: 'latest' }),
        }),
      ],
    ],
    [
      'payload repository drift',
      [
        deploymentRecord({
          payload: deploymentPayload({ repository: 'other/repo' }),
        }),
      ],
    ],
    [
      'payload action and tag drift',
      [
        deploymentRecord({
          payload: deploymentPayload({
            action: 'rollback',
            releaseTag: 'v0.1.0',
          }),
        }),
      ],
    ],
    [
      'ambiguous latest success',
      [
        deploymentRecord(),
        deploymentRecord({
          payload: deploymentPayload({ imageDigest: previousDigest }),
        }),
      ],
    ],
    [
      'older success after newer failure status',
      [
        {
          ...deploymentRecord(),
          statuses: [
            {
              state: 'failure',
              environment: 'production-private',
              repositoryUrl,
              createdAt: '2026-07-27T09:00:00Z',
            },
            {
              state: 'success',
              environment: 'production-private',
              repositoryUrl,
              createdAt: '2026-07-27T08:00:00Z',
            },
          ],
        },
      ],
    ],
  ];

  for (const [name, value] of invalid) {
    await t.test(name, () => {
      if (name === 'older success after newer failure status') {
        assert.equal(resolveCurrentProductionDigest(value), null);
        return;
      }
      assert.throws(() => resolveCurrentProductionDigest(value));
    });
  }
});

test('rollback candidate tag binds source version, digest and workflow run', () => {
  assert.equal(
    resolveRollbackCandidateTag({
      sourceTag: 'v0.1.0',
      imageDigest,
      workflowRunId: '789',
      releases: [],
    }),
    `rollback-v0.1.0-sha256-${'b'.repeat(64)}-r789`,
  );
  assert.throws(() =>
    resolveRollbackCandidateTag({
      sourceTag: 'rollback-v0.1.0',
      imageDigest,
      workflowRunId: '789',
      releases: [],
    }),
  );
  assert.throws(() =>
    resolveRollbackCandidateTag({
      sourceTag: 'v0.1.0',
      imageDigest,
      workflowRunId: '789',
      releases: [
        {
          tagName: 'rollback-v0.0.9-sha256-' + 'a'.repeat(64) + '-r1',
          isDraft: true,
        },
      ],
    }),
  );
  assert.throws(() =>
    resolveRollbackCandidateTag({
      sourceTag: 'v0.1.0',
      imageDigest,
      workflowRunId: '789',
      releases: [
        {
          tagName: 'v0.1.0',
          isDraft: false,
          unexpected: true,
        },
      ],
    }),
  );
});

test('published deployment tags select only normal deploy or bound rollback', () => {
  assert.deepEqual(resolveDeploymentReleaseTag('v0.1.0'), {
    action: 'deploy',
    sourceTag: null,
    imageDigest: null,
  });
  assert.deepEqual(
    resolveDeploymentReleaseTag(
      `rollback-v0.1.0-sha256-${'b'.repeat(64)}-r789`,
    ),
    {
      action: 'rollback',
      sourceTag: 'v0.1.0',
      imageDigest,
    },
  );
  assert.throws(() => resolveDeploymentReleaseTag('latest'));
});

test('published rollback release is bound to one verified source provenance', () => {
  const releaseTag =
    `rollback-v0.1.0-sha256-${'b'.repeat(64)}-r789`;
  const sourceIdentity = {
    releaseId: '123',
    releaseTag: 'v0.1.0',
    sourceCommit,
    publishedAt: '2026-07-27T08:00:00Z',
    imageName: 'ghcr.io/kkxiaoa/k8s-yaml-assistant' as const,
    imageDigest,
    provenanceBundleSha256: createHash('sha256')
      .update(provenanceBundle)
      .digest('hex'),
  };
  const release = {
    databaseId: 999,
    tagName: releaseTag,
    targetCommitish: sourceCommit,
    isDraft: false,
    isPrerelease: false,
    publishedAt: '2026-07-27T10:00:00Z',
    assets: [{ name: 'provenance-attestation.sigstore.json' }],
  };

  assert.deepEqual(
    verifyPublishedRollbackRelease({
      release,
      tagCommit: sourceCommit,
      provenanceBundle,
      sourceIdentity,
    }),
    {
      releaseId: '999',
      releaseTag,
      sourceCommit,
      publishedAt: '2026-07-27T10:00:00Z',
      imageName: 'ghcr.io/kkxiaoa/k8s-yaml-assistant',
      imageDigest,
      provenanceBundleSha256:
        sourceIdentity.provenanceBundleSha256,
    },
  );
  assert.throws(() =>
    verifyPublishedRollbackRelease({
      release: {
        ...release,
        assets: [
          ...release.assets,
          { name: 'release-manifest.json' },
        ],
      },
      tagCommit: sourceCommit,
      provenanceBundle,
      sourceIdentity,
    }),
  );
});

test('rollback draft readback is bound to one source release provenance', () => {
  const releaseTag =
    `rollback-v0.1.0-sha256-${'b'.repeat(64)}-r789`;
  const sourceIdentity = {
    releaseId: '123',
    releaseTag: 'v0.1.0',
    sourceCommit,
    publishedAt: '2026-07-27T08:00:00Z',
    imageName: 'ghcr.io/kkxiaoa/k8s-yaml-assistant' as const,
    imageDigest,
    provenanceBundleSha256: createHash('sha256')
      .update(provenanceBundle)
      .digest('hex'),
  };
  const release = {
    tagName: releaseTag,
    targetCommitish: sourceCommit,
    isDraft: true,
    isPrerelease: false,
    assets: [{ name: 'provenance-attestation.sigstore.json' }],
  };

  assert.doesNotThrow(() =>
    verifyRollbackDraftRelease({
      release,
      tagCommit: sourceCommit,
      provenanceBundle,
      sourceIdentity,
    }),
  );
  for (const invalidRelease of [
    { ...release, isDraft: false },
    {
      ...release,
      assets: [...release.assets, { name: 'release-manifest.json' }],
    },
    { ...release, targetCommitish: 'c'.repeat(40) },
  ]) {
    assert.throws(() =>
      verifyRollbackDraftRelease({
        release: invalidRelease,
        tagCommit: sourceCommit,
        provenanceBundle,
        sourceIdentity,
      }),
    );
  }
});

test('adapter result is decoded without exposing raw output', () => {
  const authorization = createDeploymentAuthorization(
    authorizationInput(),
  ).text;
  const result = {
    event: 'k8s_yaml_assistant_deployment',
    action: 'deploy',
    releaseId: '123',
    releaseTag: 'v0.1.0',
    sourceCommit,
    workflowRunId: '456',
    workflowRunAttempt: '1',
    previousDigest: null,
    targetDigest: imageDigest,
    result: 'success',
    failureCode: null,
    durationMs: 1250,
  };
  const resolved = resolveAdapterResult({
    resultBase64: Buffer.from(`${JSON.stringify(result)}\n`).toString('base64'),
    requestBase64: Buffer.from(
      createDeploymentRequest({
        authorization,
        authorizationBundle,
        provenanceBundle,
      }),
    ).toString('base64'),
    jobResult: 'success',
  });

  assert.deepEqual(resolved, {
    state: 'success',
    description: 'Deployment adapter completed successfully.',
  });
  assert.doesNotMatch(JSON.stringify(resolved), /sourceCommit|imageDigest/u);
  assert.throws(() =>
    resolveAdapterResult({
      resultBase64: Buffer.from(
        JSON.stringify({ ...result, targetDigest: previousDigest }),
      ).toString('base64'),
      requestBase64: Buffer.from(
        createDeploymentRequest({
          authorization,
          authorizationBundle,
          provenanceBundle,
        }),
      ).toString('base64'),
      jobResult: 'success',
    }),
  );
  assert.deepEqual(
    resolveAdapterResult({
      resultBase64: '',
      requestBase64: Buffer.from(
        createDeploymentRequest({
          authorization,
          authorizationBundle,
          provenanceBundle,
        }),
      ).toString('base64'),
      jobResult: 'failure',
    }),
    {
      state: 'failure',
      description: 'Production runner or adapter failed.',
    },
  );
});
