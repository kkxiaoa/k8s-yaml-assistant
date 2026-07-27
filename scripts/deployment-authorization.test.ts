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

const sourceCommit = 'a'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const provenanceBundle = '{"mediaType":"fixture"}\n';
const authorizationBundle = '{"verificationMaterial":"fixture"}\n';
const provenanceBundleSha256 = createHash('sha256')
  .update(provenanceBundle)
  .digest('hex');
const workflowRunUrl =
  'https://github.com/kkxiaoa/k8s-yaml-assistant/actions/runs/456';

function outputs(path: string): Map<string, string> {
  const source = readFileSync(path, 'utf8').trim();
  return new Map(
    source.length === 0
      ? []
      : source.split('\n').map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)] as const;
        }),
  );
}

function run(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/deployment-authorization.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
}

test('deployment authorization CLI creates files without printing proof material', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deployment-authorize-'));
  const identityPath = join(directory, 'identity.json');
  const provenancePath = join(directory, 'provenance.json');
  const authorizationPath = join(directory, 'authorization.json');
  const deploymentPath = join(directory, 'deployment.json');
  const pendingStatusPath = join(directory, 'pending-status.json');
  writeFileSync(
    identityPath,
    `${JSON.stringify({
      releaseId: '123',
      releaseTag: 'v0.1.0',
      sourceCommit,
      publishedAt: '2026-07-27T08:00:00Z',
      imageName: 'ghcr.io/kkxiaoa/k8s-yaml-assistant',
      imageDigest,
      provenanceBundleSha256,
    })}\n`,
  );
  writeFileSync(provenancePath, provenanceBundle);

  try {
    const result = run([
      'create',
      '--identity-json',
      identityPath,
      '--provenance-bundle',
      provenancePath,
      '--workflow-run-id',
      '456',
      '--workflow-run-attempt',
      '1',
      '--release-commit',
      sourceCommit,
      '--workflow-run-url',
      workflowRunUrl,
      '--authorization-out',
      authorizationPath,
      '--deployment-out',
      deploymentPath,
      '--pending-status-out',
      pendingStatusPath,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    const authorization = readFileSync(authorizationPath, 'utf8');
    assert.match(authorization, /"action":"deploy"/u);
    assert.equal(authorization.endsWith('\n'), true);
    const deployment = JSON.parse(
      readFileSync(deploymentPath, 'utf8'),
    ) as Record<string, any>;
    assert.equal(deployment.ref, sourceCommit);
    assert.equal(deployment.payload.imageDigest, imageDigest);
    assert.deepEqual(
      JSON.parse(readFileSync(pendingStatusPath, 'utf8')),
      {
        state: 'pending',
        log_url: workflowRunUrl,
        description: 'Published release verified; awaiting production runner.',
        environment: 'production-private',
        auto_inactive: false,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('request and result commands transfer only Base64 and bounded status JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deployment-request-'));
  const identityPath = join(directory, 'identity.json');
  const provenancePath = join(directory, 'provenance.json');
  const authorizationPath = join(directory, 'authorization.json');
  const authorizationBundlePath = join(
    directory,
    'authorization-bundle.json',
  );
  const deploymentPath = join(directory, 'deployment.json');
  const pendingStatusPath = join(directory, 'pending-status.json');
  const requestOutputPath = join(directory, 'request-output');
  const statusPath = join(directory, 'status.json');
  writeFileSync(
    identityPath,
    `${JSON.stringify({
      releaseId: '123',
      releaseTag: 'v0.1.0',
      sourceCommit,
      publishedAt: '2026-07-27T08:00:00Z',
      imageName: 'ghcr.io/kkxiaoa/k8s-yaml-assistant',
      imageDigest,
      provenanceBundleSha256,
    })}\n`,
  );
  writeFileSync(provenancePath, provenanceBundle);
  writeFileSync(authorizationBundlePath, authorizationBundle);

  try {
    const created = run([
      'create',
      '--identity-json',
      identityPath,
      '--provenance-bundle',
      provenancePath,
      '--workflow-run-id',
      '456',
      '--workflow-run-attempt',
      '1',
      '--release-commit',
      sourceCommit,
      '--workflow-run-url',
      workflowRunUrl,
      '--authorization-out',
      authorizationPath,
      '--deployment-out',
      deploymentPath,
      '--pending-status-out',
      pendingStatusPath,
    ]);
    assert.equal(created.status, 0, created.stderr);

    const request = run([
      'request',
      '--authorization',
      authorizationPath,
      '--authorization-bundle',
      authorizationBundlePath,
      '--provenance-bundle',
      provenancePath,
      '--github-output',
      requestOutputPath,
    ]);
    assert.equal(request.status, 0, request.stderr);
    assert.equal(request.stdout, '');
    const requestBase64 = outputs(requestOutputPath).get('request_base64');
    assert.ok(requestBase64);
    const requestJson = Buffer.from(requestBase64, 'base64').toString();
    assert.equal(
      (JSON.parse(requestJson) as Record<string, unknown>).provenanceBundle,
      provenanceBundle,
    );

    const adapterResult = {
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
    const finalized = run([
      'result',
      '--request-base64',
      requestBase64,
      '--result-base64',
      Buffer.from(`${JSON.stringify(adapterResult)}\n`).toString('base64'),
      '--job-result',
      'success',
      '--workflow-run-url',
      workflowRunUrl,
      '--status-out',
      statusPath,
    ]);
    assert.equal(finalized.status, 0, finalized.stderr);
    assert.equal(finalized.stdout, '');
    assert.deepEqual(JSON.parse(readFileSync(statusPath, 'utf8')), {
      state: 'success',
      log_url: workflowRunUrl,
      description: 'Deployment adapter completed successfully.',
      environment: 'production-private',
      auto_inactive: false,
    });

    const invalidResult = run([
      'result',
      '--request-base64',
      requestBase64,
      '--result-base64',
      'not-base64',
      '--job-result',
      'success',
      '--workflow-run-url',
      workflowRunUrl,
      '--status-out',
      statusPath,
    ]);
    assert.equal(invalidResult.status, 0, invalidResult.stderr);
    assert.deepEqual(JSON.parse(readFileSync(statusPath, 'utf8')), {
      state: 'failure',
      log_url: workflowRunUrl,
      description: 'Production runner returned an invalid result.',
      environment: 'production-private',
      auto_inactive: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('current-production command strictly joins GitHub deployments and statuses', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deployment-history-'));
  const deploymentsPath = join(directory, 'deployments.json');
  const statusesDir = join(directory, 'statuses');
  const outputPath = join(directory, 'github-output');
  mkdirSync(statusesDir);
  const deployments = Array.from({ length: 101 }, (_, index) => ({
    id: index + 10,
    ref: sourceCommit,
    sha: sourceCommit,
    task: 'deploy',
    environment: 'production-private',
    repository_url:
      'https://api.github.com/repos/kkxiaoa/k8s-yaml-assistant',
    transient_environment: false,
    production_environment: true,
    created_at: '2026-07-27T08:00:00Z',
    payload: {
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
    },
  }));
  writeFileSync(
    deploymentsPath,
    `${JSON.stringify(deployments)}\n`,
  );
  for (const [index, deployment] of deployments.entries()) {
    writeFileSync(
      join(statusesDir, `${deployment.id}.json`),
      `${JSON.stringify([
        {
          id: index + 100,
          state: 'success',
          environment: 'production-private',
          repository_url:
            'https://api.github.com/repos/kkxiaoa/k8s-yaml-assistant',
          created_at:
            `2026-07-27T08:10:00.${String(index).padStart(3, '0')}Z`,
        },
      ])}\n`,
    );
  }
  try {
    const result = run([
      'current-production',
      '--deployments-json',
      deploymentsPath,
      '--statuses-dir',
      statusesDir,
      '--github-output',
      outputPath,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual([...outputs(outputPath)], [
      ['current_production_digest', imageDigest],
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('tag inspection and rollback candidate reject arbitrary target input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rollback-candidate-'));
  const outputPath = join(directory, 'github-output');
  const releasesPath = join(directory, 'releases.json');
  const notesPath = join(directory, 'notes.md');
  writeFileSync(releasesPath, '[]\n');

  try {
    const inspected = run([
      'inspect-tag',
      '--release-tag',
      `rollback-v0.1.0-sha256-${'b'.repeat(64)}-r789`,
      '--github-output',
      outputPath,
    ]);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.deepEqual([...outputs(outputPath)], [
      ['action', 'rollback'],
      ['source_tag', 'v0.1.0'],
    ]);

    writeFileSync(outputPath, '');
    const candidate = run([
      'rollback-candidate',
      '--source-tag',
      'v0.1.0',
      '--image-digest',
      imageDigest,
      '--workflow-run-id',
      '789',
      '--releases-json',
      releasesPath,
      '--notes-out',
      notesPath,
      '--github-output',
      outputPath,
    ]);
    assert.equal(candidate.status, 0, candidate.stderr);
    assert.equal(
      outputs(outputPath).get('rollback_tag'),
      `rollback-v0.1.0-sha256-${'b'.repeat(64)}-r789`,
    );
    assert.match(readFileSync(notesPath, 'utf8'), /v0\.1\.0/u);
    assert.doesNotMatch(
      readFileSync('scripts/deployment-authorization.ts', 'utf8'),
      /--target-digest|--manifest|--url/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rollback draft verification consumes the downloaded source proof', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rollback-draft-'));
  const sourceIdentityPath = join(directory, 'source-identity.json');
  const provenancePath = join(directory, 'provenance.json');
  const releasePath = join(directory, 'release.json');
  const releaseTag =
    `rollback-v0.1.0-sha256-${'b'.repeat(64)}-r789`;
  writeFileSync(
    sourceIdentityPath,
    `${JSON.stringify({
      releaseId: '123',
      releaseTag: 'v0.1.0',
      sourceCommit,
      publishedAt: '2026-07-27T08:00:00Z',
      imageName: 'ghcr.io/kkxiaoa/k8s-yaml-assistant',
      imageDigest,
      provenanceBundleSha256,
    })}\n`,
  );
  writeFileSync(provenancePath, provenanceBundle);
  writeFileSync(
    releasePath,
    `${JSON.stringify({
      tagName: releaseTag,
      targetCommitish: sourceCommit,
      isDraft: true,
      isPrerelease: false,
      assets: [{ name: 'provenance-attestation.sigstore.json' }],
    })}\n`,
  );

  try {
    const result = run([
      'verify-rollback-draft',
      '--release-json',
      releasePath,
      '--tag-commit',
      sourceCommit,
      '--provenance-bundle',
      provenancePath,
      '--source-identity',
      sourceIdentityPath,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unknown command and duplicate option fail closed', () => {
  assert.notEqual(run(['unknown']).status, 0);
  assert.notEqual(
    run([
      'inspect-tag',
      '--release-tag',
      'v0.1.0',
      '--release-tag',
      'v0.2.0',
      '--github-output',
      '/tmp/unused',
    ]).status,
    0,
  );
});
