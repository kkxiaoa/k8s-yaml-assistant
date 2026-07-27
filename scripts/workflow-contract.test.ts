import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';

const root = process.cwd();
const workflowDir = join(root, '.github', 'workflows');
const prWorkflowPath = join(workflowDir, 'pr-verify.yml');
const releaseWorkflowPath = join(workflowDir, 'release.yml');
const releaseArtifactsWorkflowPath = join(
  workflowDir,
  'release-artifacts.yml',
);
const indexWorkflowPath = join(workflowDir, 'index-build.yml');
const publishedReleaseDeployWorkflowPath = join(
  workflowDir,
  'published-release-deploy.yml',
);
const publishedReleaseWorkflowPath = join(
  workflowDir,
  'published-release.yml',
);
const rollbackCandidateWorkflowPath = join(
  workflowDir,
  'rollback-candidate.yml',
);
const releasePleaseConfigPath = join(root, 'release-please-config.json');
const releasePleaseManifestPath = join(root, '.release-please-manifest.json');
const codeownersPath = join(root, '.github', 'CODEOWNERS');
const dockerfilePath = join(root, 'Dockerfile');

const releaseBootstrapSha = '273704fb72133abed5d70678d0259de9c600c21c';
const applicationImage = 'ghcr.io/kkxiaoa/k8s-yaml-assistant';
const indexImage = 'ghcr.io/kkxiaoa/k8s-yaml-assistant-index';

const checkoutAction =
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const setupNodeAction =
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020';
const releasePleaseAction =
  'googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7';
const dockerLoginAction =
  'docker/login-action@af1e73f918a031802d376d3c8bbc3fe56130a9b0';
const setupBuildxAction =
  'docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c';
const buildPushAction =
  'docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a';
const cosignInstallerAction =
  'sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6';
const sbomAction =
  'anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610';
const trivyAction =
  'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25';
const uploadArtifactAction =
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const downloadArtifactAction =
  'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c';

const reviewedActions = new Set([
  checkoutAction,
  setupNodeAction,
  releasePleaseAction,
  dockerLoginAction,
  setupBuildxAction,
  buildPushAction,
  cosignInstallerAction,
  sbomAction,
  trivyAction,
  uploadArtifactAction,
  downloadArtifactAction,
]);

const releaseArtifactFiles = [
  'sbom.spdx.json',
  'provenance.slsa.json',
  'release-manifest.json',
  'sbom-attestation.sigstore.json',
  'provenance-attestation.sigstore.json',
  'release-manifest.sigstore.json',
] as const;

const prCommands = [
  'npm ci',
  'npm run adapter:check',
  'npm run schemas:check',
  'npm run aliases:check',
  'npm run corpus:closure',
  'npm run eval:check',
  'npm test',
  'npm run typecheck',
  'npm run build',
  'npm run container:build:runtime-base',
  'npm run container:smoke:runtime-base',
] as const;

const forbiddenModelCommands = [
  'npm run index:build',
  'npm run eval',
  'npm run eval:faith',
  'npm run eval:judge',
  'npm run eval:gen',
  'npm run eval:fix',
  'npm run voyage:ab',
  'npm run aliases:ab',
] as const;

const repeatedPrCommands = [
  'npm run schemas:check',
  'npm run aliases:check',
  'npm run corpus:closure',
  'npm run eval:check',
  'npm test',
  'npm run typecheck',
  'npm run build',
  'npm run release:check',
  'npm run workflow:check',
  'npm run container:build:runtime-base',
  'npm run container:smoke:runtime-base',
] as const;

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as JsonObject;
}

function workflow(path: string, label: string): {
  value: JsonObject;
  source: string;
} {
  assert.ok(existsSync(path), `${label} must exist`);
  const source = readFileSync(path, 'utf8');
  return { value: object(load(source), label), source };
}

function json(path: string): JsonObject {
  return object(JSON.parse(readFileSync(path, 'utf8')), path);
}

function jobs(value: JsonObject): JsonObject {
  return object(value.jobs, 'jobs');
}

function job(value: JsonObject, name: string): JsonObject {
  return object(jobs(value)[name], `jobs.${name}`);
}

function steps(value: JsonObject, label: string): JsonObject[] {
  assert.ok(Array.isArray(value.steps), `${label}.steps must be an array`);
  return value.steps.map((step, index) =>
    object(step, `${label}.steps[${index}]`),
  );
}

function allSteps(value: JsonObject): JsonObject[] {
  return Object.entries(jobs(value)).flatMap(([name, candidate]) => {
    const value = object(candidate, `jobs.${name}`);
    return Array.isArray(value.steps) ? steps(value, `jobs.${name}`) : [];
  });
}

function runText(value: JsonObject, label: string): string {
  return steps(value, label)
    .map((step) => (typeof step.run === 'string' ? step.run : ''))
    .join('\n');
}

function commandLines(value: JsonObject, label: string): string[] {
  return runText(value, label)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function actionStep(value: JsonObject, uses: string, label: string): JsonObject {
  const matches = steps(value, label).filter((step) => step.uses === uses);
  assert.equal(matches.length, 1, `${label} must use ${uses} exactly once`);
  return matches[0]!;
}

function namedStep(value: JsonObject, name: string, label: string): JsonObject {
  const matches = steps(value, label).filter((step) => step.name === name);
  assert.equal(matches.length, 1, `${label} must contain one ${name} step`);
  return matches[0]!;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function assertContains(value: string, expected: readonly string[]): void {
  for (const item of expected) {
    assert.match(
      value,
      new RegExp(escapeRegExp(item), 'u'),
      `missing required workflow behavior: ${item}`,
    );
  }
}

function assertPinnedReviewedActions(value: JsonObject): void {
  for (const step of allSteps(value)) {
    if (typeof step.uses !== 'string') continue;
    assert.match(step.uses, /^[^@\s]+@[a-f0-9]{40}$/u);
    assert.ok(reviewedActions.has(step.uses), `unreviewed action: ${step.uses}`);
  }
}

function assertSafeExecutionBoundary(source: string): void {
  assert.doesNotMatch(source, /\bpull_request_target\b/u);
  assert.doesNotMatch(source, /\bself-hosted\b/u);
  assert.doesNotMatch(source, /\bschedule\s*:/u);
  assert.doesNotMatch(source, /\brepository_dispatch\s*:/u);
}

function assertNoEmbeddedCredentials(source: string, label: string): void {
  assert.doesNotMatch(
    source,
    /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
    label,
  );
  assert.doesNotMatch(
    source,
    /\b(?:certificate-authority|client-certificate|client-key)-data\s*:/u,
    label,
  );
  assert.doesNotMatch(
    source,
    /\bACTIONS_RUNNER_INPUT_TOKEN\s*[:=]/u,
    label,
  );
  assert.doesNotMatch(
    source,
    /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/u,
    label,
  );
  for (const line of source.split(/\r?\n/u)) {
    const match =
      /^\s*(?:DEEPSEEK|VOYAGE)_API_KEY:\s*(?<value>.+)$/u.exec(line);
    if (!match?.groups?.value) continue;
    assert.match(
      match.groups.value,
      /^\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}$/u,
      label,
    );
  }
}

function assertCodeowners(): void {
  const rules = new Set(
    readFileSync(codeownersPath, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
  for (const rule of [
    '* @kkxiaoa',
    '/.github/ @kkxiaoa',
    '/Dockerfile @kkxiaoa',
    '/deploy/ @kkxiaoa',
  ]) {
    assert.ok(rules.has(rule), `CODEOWNERS missing ${rule}`);
  }
}

function validateReleasePleaseConfig(): void {
  const config = json(releasePleaseConfigPath);
  assert.equal(config['bootstrap-sha'], releaseBootstrapSha);
  const versionManifest = json(releasePleaseManifestPath);
  const rootPackage = object(
    object(config.packages, 'release-please packages')['.'],
    'release-please root package',
  );
  assert.equal(rootPackage['release-type'], 'node');
  assert.equal(rootPackage['package-name'], 'k8s-yaml-assistant');
  assert.equal(rootPackage['changelog-path'], 'CHANGELOG.md');
  assert.equal(rootPackage['include-v-in-tag'], true);
  assert.equal(rootPackage['include-component-in-tag'], false);
  assert.equal(rootPackage.draft, true);
  assert.equal(rootPackage['bump-minor-pre-major'], true);
  if (versionManifest['.'] === '0.0.0') {
    assert.equal(rootPackage['release-as'], '0.1.0');
  } else {
    assert.equal(rootPackage['release-as'], undefined);
  }

  const packageJson = json(join(root, 'package.json'));
  const packageLock = json(join(root, 'package-lock.json'));
  assert.equal(versionManifest['.'], packageJson.version);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(
    object(object(packageLock.packages, 'lock packages')[''], 'lock root')
      .version,
    packageJson.version,
  );
}

function validatePrWorkflow(value: JsonObject, source: string): void {
  assert.equal(value.name, 'PR verify');
  assert.deepEqual(object(value.on, 'PR triggers').pull_request, {
    branches: ['main'],
  });
  assert.deepEqual(value.permissions, { contents: 'read' });

  const releaseState = job(value, 'release_state');
  assert.deepEqual(releaseState.permissions, { contents: 'write' });
  assert.equal(releaseState['runs-on'], 'ubuntu-24.04');
  assertContains(runText(releaseState, 'PR release state'), [
    'gh api',
    '--paginate',
    '--slurp',
    'releases?per_page=100',
    "jq 'add'",
    'active application draft blocks a new release PR',
  ]);
  assert.doesNotMatch(source, /--jq 'add/u);
  assert.doesNotMatch(
    source,
    /release inventory exceeds the bounded inspection page/u,
  );
  assert.equal(
    steps(releaseState, 'PR release state')[0]?.if,
    "github.event.pull_request.user.login == 'github-actions[bot]' && startsWith(github.head_ref, 'release-please--branches--main')",
  );
  assert.equal(
    steps(releaseState, 'PR release state').some(
      (step) => typeof step.uses === 'string',
    ),
    false,
  );

  const verify = job(value, 'verify');
  assert.equal(verify.needs, 'release_state');
  assert.equal(verify.if, '${{ !cancelled() }}');
  const verifyText = runText(verify, 'PR verify');
  assertContains(verifyText, [
    'release state gate must succeed before PR verification',
    ...prCommands,
  ]);
  for (const command of commandLines(verify, 'PR verify')) {
    assert.equal(
      forbiddenModelCommands.some(
        (forbidden) =>
          command === forbidden || command.startsWith(`${forbidden} `),
      ),
      false,
      `PR verify contains paid/model command: ${command}`,
    );
  }
  assert.equal(verify['runs-on'], 'ubuntu-24.04');
  assert.doesNotMatch(JSON.stringify(verify), /\bghcr\.io\b/u);
  assert.deepEqual(
    object(
      actionStep(verify, trivyAction, 'PR verify').with,
      'PR runtime vulnerability gate inputs',
    ),
    {
      'scan-type': 'image',
      'image-ref': 'k8s-yaml-assistant:test-runtime-base',
      format: 'table',
      'exit-code': '1',
      'ignore-unfixed': false,
      'vuln-type': 'os,library',
      severity: 'HIGH,CRITICAL',
      scanners: 'vuln',
      'hide-progress': true,
      version: 'v0.70.0',
    },
  );

  const releaseIndex = job(value, 'release_index');
  assert.equal(releaseIndex.needs, 'release_state');
  assert.equal(
    releaseIndex.if,
    "github.event.pull_request.user.login == 'github-actions[bot]' && startsWith(github.head_ref, 'release-please--branches--main')",
  );
  assert.deepEqual(releaseIndex.permissions, {
    contents: 'read',
    packages: 'read',
  });
  const indexText = runText(releaseIndex, 'PR release index');
  assertContains(indexText, [
    'release:manifest -- index-identity',
    'docker buildx imagetools inspect',
    'cosign verify',
  ]);
  assert.doesNotMatch(indexText, /npm run index:build/u);
  assert.deepEqual(
    object(
      actionStep(releaseIndex, checkoutAction, 'PR release index').with,
      'release index checkout inputs',
    ),
    {
      ref: 'refs/heads/main',
      'persist-credentials': false,
    },
  );

  assertPinnedReviewedActions(value);
  assertSafeExecutionBoundary(source);
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./u);
  assert.doesNotMatch(source, /\b(?:VOYAGE|DEEPSEEK)_[A-Z0-9_]+\b/u);
}

function validateReleaseWorkflow(value: JsonObject, source: string): void {
  assert.equal(value.name, 'Release lifecycle');
  assert.deepEqual(object(value.on, 'release triggers'), {
    push: { branches: ['main'] },
    workflow_dispatch: null,
  });
  assert.deepEqual(value.permissions, { contents: 'read' });

  const releaseState = job(value, 'inspect_release_state');
  assert.equal(
    releaseState.if,
    "github.event_name == 'push' && github.ref == 'refs/heads/main'",
  );
  assert.deepEqual(releaseState.permissions, {
    contents: 'write',
    'pull-requests': 'read',
  });
  assert.deepEqual(releaseState.outputs, {
    release_action: '${{ steps.gate.outputs.release_action }}',
  });
  assert.deepEqual(
    object(
      actionStep(releaseState, checkoutAction, 'release state').with,
      'release state checkout inputs',
    ),
    {
      'fetch-depth': 0,
      'persist-credentials': false,
    },
  );
  assertContains(runText(releaseState, 'release state'), [
    '--paginate',
    '--slurp',
    'releases?per_page=100',
    "jq 'add | map",
    'commits/$GITHUB_SHA/pulls',
    'release:manifest -- gate',
    '--tag-commit "$TAG_COMMIT"',
  ]);
  assert.doesNotMatch(
    source,
    /release inventory exceeds the bounded inspection page/u,
  );
  assert.doesNotMatch(source, /--jq 'add/u);

  const releasePlease = job(value, 'release_please');
  assert.equal(releasePlease.needs, 'inspect_release_state');
  assert.equal(
    releasePlease.if,
    "needs.inspect_release_state.outputs.release_action == 'prepare' || needs.inspect_release_state.outputs.release_action == 'create-draft'",
  );
  assert.deepEqual(releasePlease.permissions, {
    contents: 'write',
    issues: 'write',
    'pull-requests': 'write',
  });
  assert.deepEqual(releasePlease.outputs, {
    release_created: '${{ steps.release.outputs.release_created }}',
    source_sha: '${{ steps.release.outputs.sha }}',
    tag: '${{ steps.release.outputs.tag_name }}',
    version: '${{ steps.release.outputs.version }}',
  });
  const releaseStep = actionStep(
    releasePlease,
    releasePleaseAction,
    'Release Please',
  );
  assert.equal(releaseStep.id, 'release');
  assert.deepEqual(releaseStep.with, {
    token: '${{ github.token }}',
    'config-file': 'release-please-config.json',
    'manifest-file': '.release-please-manifest.json',
    'skip-github-pull-request':
      "${{ needs.inspect_release_state.outputs.release_action == 'create-draft' }}",
  });

  const resolveDraft = job(value, 'resolve_draft');
  assert.equal(
    resolveDraft.if,
    "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
  );
  assert.deepEqual(resolveDraft.permissions, { contents: 'write' });
  assert.deepEqual(resolveDraft.outputs, {
    source_sha: '${{ steps.draft.outputs.source_sha }}',
    tag: '${{ steps.draft.outputs.tag }}',
    version: '${{ steps.draft.outputs.version }}',
  });
  assert.deepEqual(
    object(
      actionStep(resolveDraft, checkoutAction, 'draft recovery').with,
      'draft recovery checkout inputs',
    ),
    {
      ref: 'refs/heads/main',
      'fetch-depth': 0,
      'persist-credentials': false,
    },
  );
  assertContains(runText(resolveDraft, 'draft recovery'), [
    'gh release view',
    'targetCommitish',
    'git merge-base --is-ancestor',
    '$GITHUB_OUTPUT',
  ]);

  const artifacts = job(value, 'artifacts');
  assert.equal(artifacts.needs, 'release_please');
  assert.equal(
    artifacts.if,
    "needs.release_please.outputs.release_created == 'true'",
  );
  assert.equal(artifacts.uses, './.github/workflows/release-artifacts.yml');
  assert.deepEqual(artifacts.permissions, {
    contents: 'write',
    deployments: 'read',
    packages: 'write',
    'id-token': 'write',
  });
  assert.deepEqual(artifacts.with, {
    source_sha: '${{ needs.release_please.outputs.source_sha }}',
    tag: '${{ needs.release_please.outputs.tag }}',
    version: '${{ needs.release_please.outputs.version }}',
  });

  const recoveredArtifacts = job(value, 'recover_artifacts');
  assert.equal(recoveredArtifacts.needs, 'resolve_draft');
  assert.equal(recoveredArtifacts.if, undefined);
  assert.equal(
    recoveredArtifacts.uses,
    './.github/workflows/release-artifacts.yml',
  );
  assert.deepEqual(recoveredArtifacts.permissions, {
    contents: 'write',
    deployments: 'read',
    packages: 'write',
    'id-token': 'write',
  });
  assert.deepEqual(recoveredArtifacts.with, {
    source_sha: '${{ needs.resolve_draft.outputs.source_sha }}',
    tag: '${{ needs.resolve_draft.outputs.tag }}',
    version: '${{ needs.resolve_draft.outputs.version }}',
  });

  assertPinnedReviewedActions(value);
  assertSafeExecutionBoundary(source);
  assert.doesNotMatch(source, /skip-github-release/u);
  assert.doesNotMatch(source, /\b(?:VOYAGE|DEEPSEEK)_[A-Z0-9_]+\b/u);
  assert.doesNotMatch(
    source,
    /\bgh\s+release\s+(?:create|delete|edit|upload)\b/u,
  );
}

function validateReleaseArtifactsWorkflow(
  value: JsonObject,
  source: string,
): void {
  assert.equal(value.name, 'Build draft release artifacts');
  const triggers = object(value.on, 'release artifact triggers');
  assert.deepEqual(Object.keys(triggers), ['workflow_call']);
  const inputs = object(
    object(triggers.workflow_call, 'workflow_call').inputs,
    'release artifact inputs',
  );
  for (const name of ['source_sha', 'tag', 'version']) {
    const input = object(inputs[name], `input ${name}`);
    assert.equal(input.required, true);
    assert.equal(input.type, 'string');
  }
  assert.deepEqual(value.permissions, { contents: 'read' });

  const verify = job(value, 'verify');
  const build = job(value, 'build');
  const attach = job(value, 'attach');
  assert.deepEqual(verify.permissions, {
    contents: 'write',
    packages: 'read',
    deployments: 'read',
  });
  assert.deepEqual(build.permissions, {
    contents: 'read',
    packages: 'write',
    'id-token': 'write',
  });
  assert.deepEqual(attach.permissions, { contents: 'write' });
  assert.deepEqual(build.needs, ['verify']);
  assert.deepEqual(attach.needs, ['verify', 'build']);

  const verifyText = runText(verify, 'release artifact verify');
  assertContains(verifyText, [
    'npm ci',
    'release:manifest -- check',
    'gh release view',
    'release:manifest -- prepare',
    'deployments?environment=production-private',
    '/statuses?per_page=100',
    '--paginate',
    '--slurp',
    "jq 'add'",
    'deployment:authorize -- current-production',
    'release:manifest -- index-identity',
    'docker buildx imagetools inspect',
    'cosign verify',
    'release:manifest -- verify-index',
  ]);
  assert.equal(
    object(verify.outputs, 'verify outputs').current_production_digest,
    '${{ steps.production.outputs.current_production_digest }}',
  );
  assert.doesNotMatch(source, /vars\.CURRENT_PRODUCTION_DIGEST/u);
  assert.doesNotMatch(
    verifyText,
    /test "\$SOURCE_SHA" = "\$GITHUB_SHA"/u,
  );
  for (const command of repeatedPrCommands) {
    assert.doesNotMatch(
      verifyText,
      new RegExp(escapeRegExp(command), 'u'),
      `release artifact verify repeats PR gate: ${command}`,
    );
  }
  assert.equal(object(verify.outputs, 'verify outputs').index_tag, undefined);
  assert.equal(build.outputs, undefined);
  assert.deepEqual(
    object(
      namedStep(
        verify,
        'Upload verified draft snapshot',
        'release artifact verify',
      ).with,
      'verified draft upload inputs',
    ),
    {
      name: 'verified-draft-${{ inputs.source_sha }}',
      path: 'candidate-state/draft-release.json',
      'if-no-files-found': 'error',
      'retention-days': 1,
    },
  );
  assert.deepEqual(
    object(
      namedStep(
        build,
        'Download verified draft snapshot',
        'release artifact build',
      ).with,
      'verified draft download inputs',
    ),
    {
      name: 'verified-draft-${{ inputs.source_sha }}',
      path: 'candidate-state',
    },
  );

  const buildText = runText(build, 'release artifact build');
  assertContains(buildText, [
    'docker history --no-trunc',
    'container-smoke.ts',
    'cosign attest',
    'cosign verify-attestation',
    'cosign sign-blob',
    'release:manifest -- finalize',
    '--release-json candidate-state/draft-release.json',
  ]);
  assert.equal(
    object(
      namedStep(
        build,
        'Build and sign release manifest',
        'release artifact build',
      ).env,
      'release manifest environment',
    ).WORKFLOW_RUN_URL,
    'https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}/attempts/${{ github.run_attempt }}',
  );
  assert.doesNotMatch(buildText, /\bgh release view\b/u);
  const image = actionStep(build, buildPushAction, 'release artifact build');
  const imageWith = object(image.with, 'release image inputs');
  assert.equal(imageWith.target, 'runtime');
  assert.equal(
    imageWith.tags,
    `${applicationImage}:\${{ inputs.source_sha }}`,
  );
  assert.equal(
    imageWith['build-contexts'],
    `verified-index=docker-image://${indexImage}@\${{ needs.verify.outputs.index_digest }}`,
  );
  assert.equal(imageWith['secret-envs'], undefined);

  const vulnerabilityReport = actionStep(
    build,
    trivyAction,
    'release artifact build',
  );
  assert.deepEqual(
    object(vulnerabilityReport.with, 'release vulnerability report inputs'),
    {
      'scan-type': 'image',
      'image-ref': `${applicationImage}@\${{ steps.image.outputs.digest }}`,
      format: 'json',
      output: 'candidate-state/trivy-results.json',
      'exit-code': '0',
      'ignore-unfixed': false,
      'vuln-type': 'os,library',
      severity: 'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL',
      scanners: 'vuln',
      'hide-progress': true,
      version: 'v0.70.0',
    },
  );
  const vulnerabilityGate = namedStep(
    build,
    'Reject high and critical vulnerabilities',
    'release artifact build',
  );
  assert.equal(vulnerabilityGate.uses, undefined);
  assert.equal(
    typeof vulnerabilityGate.run,
    'string',
    'release vulnerability gate must be a command',
  );
  assert.equal(
    (vulnerabilityGate.run as string)
      .replace(/\\\r?\n\s*/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
    'trivy convert --format table --severity HIGH,CRITICAL --exit-code 1 --scanners vuln candidate-state/trivy-results.json',
  );

  const attachText = runText(attach, 'release artifact attach');
  assertContains(attachText, [
    'gh release upload',
    '--clobber',
    'gh release download',
    'release:manifest -- verify-draft',
  ]);
  assert.equal(
    (attachText.match(/\bgh release view\b/gu) ?? []).length,
    2,
  );
  for (const file of releaseArtifactFiles) {
    assert.match(source, new RegExp(file.replaceAll('.', '\\.'), 'u'));
  }

  assertPinnedReviewedActions(value);
  assertSafeExecutionBoundary(source);
  assert.doesNotMatch(source, /\bworkflow_dispatch\b/u);
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./u);
  assert.doesNotMatch(source, /\b(?:VOYAGE|DEEPSEEK)_API_KEY\b/u);
  assert.doesNotMatch(source, /\bgh\s+release\s+(?:create|edit)\b/u);
  assert.doesNotMatch(source, /\bgh\s+api\b[\s\S]*git\/refs/u);
  assert.doesNotMatch(source, /deployment response must be a bounded array/u);
  assert.doesNotMatch(source, /--jq 'add/u);
  assert.doesNotMatch(source, /--notes-file\b|--generate-notes\b/u);
  assert.doesNotMatch(source, /\bsecret-envs\b/u);
  assert.doesNotMatch(source, /npm run index:build/u);
  assert.doesNotMatch(source, /:latest\b/u);
  assert.match(
    source,
    /kkxiaoa\/k8s-yaml-assistant\/\.github\/workflows\/release-artifacts\.yml@refs\/heads\/main/u,
  );
}

function validateIndexWorkflow(value: JsonObject, source: string): void {
  assert.equal(value.name, 'Build index artifact');
  assert.deepEqual(object(value.on, 'index triggers'), {
    workflow_dispatch: null,
  });
  assert.deepEqual(value.permissions, { contents: 'read' });

  const inspect = job(value, 'inspect');
  const build = job(value, 'build');
  assert.deepEqual(inspect.permissions, {
    contents: 'read',
    packages: 'read',
  });
  const inspectOutputs = object(inspect.outputs, 'index inspect outputs');
  assert.equal(inspectOutputs.digest, undefined);
  assert.equal(inspectOutputs.index_image, undefined);
  for (const name of [
    'exists',
    'source_sha',
    'index_tag',
    'index_hash',
    'embedding_model',
  ]) {
    assert.equal(typeof inspectOutputs[name], 'string', `missing output ${name}`);
  }
  assert.equal(build.environment, 'index-build');
  assert.deepEqual(build.permissions, {
    contents: 'read',
    packages: 'write',
    'id-token': 'write',
  });
  assert.deepEqual(build.needs, ['inspect']);
  assert.equal(build.if, "needs.inspect.outputs.exists == 'false'");

  const inspectText = runText(inspect, 'index inspect');
  assertContains(inspectText, [
    'release:manifest -- index-identity',
    'docker buildx imagetools inspect',
    'cosign verify',
    'release:manifest -- verify-index',
  ]);
  const buildText = runText(build, 'index build');
  assertContains(buildText, [
    'release:manifest -- verify-index',
    'cosign sign',
    'cosign verify',
    'docker history --no-trunc',
  ]);
  const image = actionStep(build, buildPushAction, 'index build');
  assert.deepEqual(image.env, {
    VOYAGE_API_KEY: '${{ secrets.VOYAGE_API_KEY }}',
  });
  const imageWith = object(image.with, 'index image inputs');
  assert.equal(imageWith.target, 'index-artifact');
  assert.equal(
    imageWith.tags,
    `${indexImage}:\${{ needs.inspect.outputs.index_tag }}`,
  );
  assert.equal(imageWith['secret-envs'], 'voyage_api_key=VOYAGE_API_KEY');
  assert.equal(
    (source.match(/\$\{\{\s*secrets\.VOYAGE_API_KEY\s*\}\}/gu) ?? []).length,
    1,
  );

  assertPinnedReviewedActions(value);
  assertSafeExecutionBoundary(source);
  assert.doesNotMatch(source, /\bDEEPSEEK_API_KEY\b/u);
  assert.doesNotMatch(source, new RegExp(`${applicationImage}:`, 'u'));
  assert.doesNotMatch(source, /\bgh\s+release\b/u);
  assert.doesNotMatch(source, /:latest\b/u);
}

function validatePublishedReleaseWorkflow(
  value: JsonObject,
  source: string,
): void {
  assert.deepEqual(object(value.on, 'published release triggers'), {
    release: { types: ['published'] },
  });
  assert.deepEqual(value.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(object(value.jobs, 'published release jobs')), [
    'deploy',
  ]);

  const deploy = job(value, 'deploy');
  assert.equal(
    deploy.uses,
    'kkxiaoa/k8s-yaml-assistant/.github/workflows/published-release-deploy.yml@main',
  );
  assert.deepEqual(deploy.permissions, {
    contents: 'read',
    deployments: 'write',
    'id-token': 'write',
  });
  assert.equal(deploy.with, undefined);
  assert.equal(deploy.secrets, undefined);
  assert.equal(deploy.steps, undefined);
  assert.equal(deploy['runs-on'], undefined);

  assert.doesNotMatch(
    source,
    /\b(?:workflow_dispatch|push|pull_request|workflow_call|repository_dispatch|schedule)\s*:/u,
  );
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./u);
  assertNoEmbeddedCredentials(source, 'published release trigger');
}

function validatePublishedReleaseDeployWorkflow(
  value: JsonObject,
  source: string,
): void {
  assert.deepEqual(object(value.on, 'published release triggers'), {
    workflow_call: null,
  });
  assert.deepEqual(value.permissions, { contents: 'read' });

  const validate = job(value, 'validate');
  assert.equal(validate['runs-on'], 'ubuntu-24.04');
  assert.equal(validate['timeout-minutes'], 30);
  assert.deepEqual(validate.permissions, {
    contents: 'read',
    deployments: 'write',
    'id-token': 'write',
  });
  assert.deepEqual(validate.outputs, {
    request_base64: '${{ steps.request.outputs.request_base64 }}',
    deployment_id: '${{ steps.deployment.outputs.deployment_id }}',
  });
  const validateText = runText(validate, 'published release validation');
  assertContains(source, [
    'github.event_name',
    'github.event.action',
    'github.event.release.draft',
    'github.event.release.prerelease',
    'github.actor',
    'job.workflow_sha',
  ]);
  assert.doesNotMatch(source, /github\.event\.sender\.login/u);
  assertContains(validateText, [
    'test "$EVENT_ACTION" = "published"',
    'release:manifest -- verify-published',
    'deployment:authorize -- verify-rollback',
    'cosign verify-blob-attestation',
    'deployment:authorize -- create',
    'cosign sign-blob',
    'cosign verify-blob',
    '--certificate-github-workflow-ref "$GITHUB_REF"',
    '--certificate-github-workflow-sha "$GITHUB_SHA"',
    '--certificate-github-workflow-repository "$GITHUB_REPOSITORY"',
    '--certificate-github-workflow-trigger release',
    'deployment:authorize -- request',
    'repos/$GITHUB_REPOSITORY/deployments',
    '/statuses',
  ]);
  const publishedVerification = validateText.indexOf(
    'release:manifest -- verify-published',
  );
  const rollbackVerification = validateText.indexOf(
    'deployment:authorize -- verify-rollback',
  );
  const authorizationSigning = validateText.indexOf('cosign sign-blob');
  assert.ok(publishedVerification >= 0);
  assert.ok(rollbackVerification >= 0);
  assert.ok(
    authorizationSigning > publishedVerification &&
      authorizationSigning > rollbackVerification,
    'authorization signing must follow both published release branches',
  );
  assert.doesNotMatch(validateText, /\bcmp\b/u);
  assert.equal(
    object(
      namedStep(
        validate,
        'Build deployment authorization',
        'published release validation',
      ).env,
      'deployment authorization environment',
    ).WORKFLOW_RUN_URL,
    'https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}/attempts/${{ github.run_attempt }}',
  );

  const production = job(value, 'production');
  assert.equal(production.needs, 'validate');
  assert.deepEqual(production['runs-on'], [
    'self-hosted',
    'Linux',
    'X64',
    'k8s-yaml-assistant-prod',
  ]);
  assert.deepEqual(production.permissions, {});
  assert.equal(production['timeout-minutes'], 30);
  assert.deepEqual(production.concurrency, {
    group: 'production-deploy',
    'cancel-in-progress': false,
  });
  assert.deepEqual(production.outputs, {
    result_base64: '${{ steps.adapter.outputs.result_base64 }}',
  });
  assert.equal(production.container, undefined);
  assert.equal(production.services, undefined);
  const productionSteps = steps(production, 'production deployment');
  assert.equal(productionSteps.length, 1);
  assert.equal(productionSteps[0]?.uses, undefined);
  assert.deepEqual(productionSteps[0]?.env, {
    REQUEST_BASE64: '${{ needs.validate.outputs.request_base64 }}',
  });
  const productionRun =
    typeof productionSteps[0]?.run === 'string'
      ? productionSteps[0].run
      : '';
  assertContains(productionRun, [
    'printf',
    'base64 --decode',
    'sudo -n /usr/local/sbin/k8s-yaml-assistant-deploy',
    'result_base64=',
    'ADAPTER_STATUS=1',
    '$GITHUB_OUTPUT',
  ]);
  assert.doesNotMatch(
    productionRun,
    /\b(?:gh|git|node|npm|npx|docker|cosign|kubectl|curl|wget)\b/u,
  );
  assert.doesNotMatch(productionRun, /\beval\b|bash\s+-c|sh\s+-c/u);

  const finalize = job(value, 'finalize');
  assert.deepEqual(finalize.needs, ['validate', 'production']);
  assert.equal(
    finalize.if,
    "${{ always() && needs.validate.outputs.deployment_id != '' }}",
  );
  assert.equal(finalize['runs-on'], 'ubuntu-24.04');
  assert.deepEqual(finalize.permissions, {
    contents: 'read',
    deployments: 'write',
  });
  assertContains(runText(finalize, 'deployment finalizer'), [
    'deployment:authorize -- result',
    'repos/$GITHUB_REPOSITORY/deployments/',
    '/statuses',
  ]);
  assert.equal(
    object(
      namedStep(
        finalize,
        'Resolve bounded adapter result',
        'deployment finalizer',
      ).env,
      'deployment result environment',
    ).WORKFLOW_RUN_URL,
    'https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}/attempts/${{ github.run_attempt }}',
  );
  assertContains(source, [
    'needs.production.result',
    'needs.production.outputs.result_base64',
  ]);

  assertPinnedReviewedActions(value);
  assert.doesNotMatch(
    source,
    /\b(?:workflow_dispatch|push|pull_request|repository_dispatch|schedule)\s*:/u,
  );
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./u);
  assert.doesNotMatch(source, /\b(?:VOYAGE|DEEPSEEK)_API_KEY\b/u);
  assertNoEmbeddedCredentials(source, 'published release deployment');
}

function validateRollbackCandidateWorkflow(
  value: JsonObject,
  source: string,
): void {
  const triggers = object(value.on, 'rollback candidate triggers');
  assert.deepEqual(Object.keys(triggers), ['workflow_dispatch']);
  const inputs = object(
    object(triggers.workflow_dispatch, 'rollback dispatch').inputs,
    'rollback inputs',
  );
  assert.deepEqual(Object.keys(inputs), ['source_tag']);
  const sourceTag = object(inputs.source_tag, 'rollback source tag');
  assert.equal(sourceTag.required, true);
  assert.equal(sourceTag.type, 'string');
  assert.deepEqual(value.concurrency, {
    group: 'rollback-candidate',
    'cancel-in-progress': false,
  });
  assert.deepEqual(value.permissions, { contents: 'read' });

  const candidate = job(value, 'candidate');
  assert.equal(candidate['runs-on'], 'ubuntu-24.04');
  assert.equal(candidate['timeout-minutes'], 30);
  assert.deepEqual(candidate.permissions, { contents: 'write' });
  const candidateSteps = steps(candidate, 'rollback candidate');
  assert.equal(candidateSteps[0]?.uses, undefined);
  assertContains(
    typeof candidateSteps[0]?.run === 'string'
      ? candidateSteps[0].run
      : '',
    [
      'test "$EVENT_ACTOR" = "kkxiaoa"',
      'test "$EVENT_REF" = "refs/heads/main"',
    ],
  );
  const candidateText = runText(candidate, 'rollback candidate');
  assertContains(candidateText, [
    'release:manifest -- verify-published',
    'cosign verify-blob',
    'cosign verify-blob-attestation',
    'deployment:authorize -- rollback-candidate',
    'deployment:authorize -- verify-rollback-draft',
    'gh api',
    '--paginate',
    '--slurp',
    'releases?per_page=100',
    "jq 'add | map",
    'gh release create',
    '--draft',
    '--target "$GITHUB_SHA"',
    'provenance-attestation.sigstore.json',
  ]);
  assert.doesNotMatch(candidateText, /\bcmp\b/u);
  assert.doesNotMatch(candidateText, /\bgh release list\b/u);
  assert.doesNotMatch(candidateText, /--jq 'add/u);
  assertPinnedReviewedActions(value);
  assertSafeExecutionBoundary(source);
  assert.doesNotMatch(source, /\bdeployments\s*:/u);
  assert.doesNotMatch(source, /\bdeployment:authorize -- (?:create|request)\b/u);
  assert.doesNotMatch(source, /\bgh\s+release\s+(?:publish|delete|edit)\b/u);
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./u);
  assert.doesNotMatch(source, /\b(?:VOYAGE|DEEPSEEK)_API_KEY\b/u);
  assertNoEmbeddedCredentials(source, 'rollback candidate');
}

test('pull request workflow owns source gates and checks release indexes without secrets', () => {
  const actual = workflow(prWorkflowPath, 'PR workflow');
  validatePrWorkflow(actual.value, actual.source);
  assertCodeowners();
});

test('only the fixed production deployment workflow may route to the production runner', () => {
  for (const name of readdirSync(workflowDir).filter((candidate) =>
    /\.ya?ml$/u.test(candidate),
  )) {
    if (name === 'published-release-deploy.yml') continue;
    const source = readFileSync(join(workflowDir, name), 'utf8');
    assert.doesNotMatch(source, /\bself-hosted\b/u, name);
    assert.doesNotMatch(
      source,
      /\bk8s-yaml-assistant-prod\b/u,
      name,
    );
    assertNoEmbeddedCredentials(source, name);
  }
});

test('release lifecycle owns version preparation and draft creation', () => {
  const actual = workflow(releaseWorkflowPath, 'release workflow');
  validateReleaseWorkflow(actual.value, actual.source);
  validateReleasePleaseConfig();
});

test('release artifact workflow verifies identities without repeating PR gates', () => {
  const actual = workflow(
    releaseArtifactsWorkflowPath,
    'release artifact workflow',
  );
  validateReleaseArtifactsWorkflow(actual.value, actual.source);
});

test('published release tags call the main deployment workflow', () => {
  const actual = workflow(
    publishedReleaseWorkflowPath,
    'published release trigger workflow',
  );
  validatePublishedReleaseWorkflow(actual.value, actual.source);
});

test('published release deployment validates on hosted runners before the minimal production job', () => {
  const actual = workflow(
    publishedReleaseDeployWorkflowPath,
    'published release deployment workflow',
  );
  validatePublishedReleaseDeployWorkflow(actual.value, actual.source);
});

test('rollback candidates accept only one published source release tag', () => {
  const actual = workflow(
    rollbackCandidateWorkflowPath,
    'rollback candidate workflow',
  );
  validateRollbackCandidateWorkflow(actual.value, actual.source);
});

test('manual index workflow is the only workflow allowed to consume Voyage', () => {
  const actual = workflow(indexWorkflowPath, 'index workflow');
  validateIndexWorkflow(actual.value, actual.source);
  for (const path of [
    prWorkflowPath,
    releaseWorkflowPath,
    releaseArtifactsWorkflowPath,
    publishedReleaseWorkflowPath,
    publishedReleaseDeployWorkflowPath,
    rollbackCandidateWorkflowPath,
  ]) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /\bVOYAGE_API_KEY\b/u);
  }
});

test('release index model has one source-controlled identity', () => {
  const dockerfile = readFileSync(dockerfilePath, 'utf8');
  assert.match(dockerfile, /^ARG RELEASE_INDEX_EMBEDDING_MODEL$/mu);
  assert.match(
    dockerfile,
    /VOYAGE_EMBEDDING_MODEL="\$RELEASE_INDEX_EMBEDDING_MODEL"/u,
  );
  assert.doesNotMatch(
    dockerfile,
    /\bVOYAGE_EMBEDDING_MODEL=voyage-[^\s\\]+/u,
  );

  for (const path of [
    prWorkflowPath,
    indexWorkflowPath,
    releaseArtifactsWorkflowPath,
  ]) {
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /release:manifest -- index-identity[\s\\]*--embedding-model\b/u,
    );
  }

  const index = workflow(indexWorkflowPath, 'index workflow');
  const image = actionStep(
    job(index.value, 'build'),
    buildPushAction,
    'index build',
  );
  assert.equal(
    object(image.with, 'index image inputs')['build-args'],
    'RELEASE_INDEX_EMBEDDING_MODEL=${{ needs.inspect.outputs.embedding_model }}',
  );
});

test('release contracts reject mutable actions, split ownership, paid builds, and detached gates', () => {
  const releaseActual = workflow(releaseWorkflowPath, 'release workflow');
  const mutableRelease = structuredClone(releaseActual.value);
  actionStep(
    job(mutableRelease, 'release_please'),
    releasePleaseAction,
    'Release Please',
  ).uses = 'googleapis/release-please-action@v5';
  assert.throws(() =>
    validateReleaseWorkflow(mutableRelease, JSON.stringify(mutableRelease)),
  );

  const splitRelease = structuredClone(releaseActual.value);
  const releaseStep = actionStep(
    job(splitRelease, 'release_please'),
    releasePleaseAction,
    'Release Please',
  );
  releaseStep.with = {
    ...object(releaseStep.with, 'release inputs'),
    'skip-github-release': true,
  };
  assert.throws(() =>
    validateReleaseWorkflow(splitRelease, JSON.stringify(splitRelease)),
  );

  const artifactsActual = workflow(
    releaseArtifactsWorkflowPath,
    'release artifact workflow',
  );
  const paidArtifacts = structuredClone(artifactsActual.value);
  job(paidArtifacts, 'build').env = {
    VOYAGE_API_KEY: '${{ secrets.VOYAGE_API_KEY }}',
  };
  assert.throws(() =>
    validateReleaseArtifactsWorkflow(
      paidArtifacts,
      JSON.stringify(paidArtifacts),
    ),
  );

  for (const [expected, replacement] of [
    ['--exit-code 1', '--exit-code 0'],
    [
      'candidate-state/trivy-results.json',
      'candidate-state/other-trivy-results.json',
    ],
  ] as const) {
    const candidate = structuredClone(artifactsActual.value);
    const gate = namedStep(
      job(candidate, 'build'),
      'Reject high and critical vulnerabilities',
      'release artifact build',
    );
    assert.equal(typeof gate.run, 'string');
    const mutatedRun = (gate.run as string).replace(expected, replacement);
    assert.notEqual(mutatedRun, gate.run);
    gate.run = mutatedRun;
    assert.throws(() =>
      validateReleaseArtifactsWorkflow(candidate, JSON.stringify(candidate)),
    );
  }
});
