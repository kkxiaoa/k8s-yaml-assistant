import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
  assert.doesNotMatch(JSON.stringify(config), /release-as/u);

  const versionManifest = json(releasePleaseManifestPath);
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

  const verify = job(value, 'verify');
  const verifyText = runText(verify, 'PR verify');
  assertContains(verifyText, prCommands);
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

  const releaseIndex = job(value, 'release_index');
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

  const releasePlease = job(value, 'release_please');
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
  });

  const artifacts = job(value, 'artifacts');
  assert.equal(artifacts.needs, 'release_please');
  assert.equal(
    artifacts.if,
    "needs.release_please.outputs.release_created == 'true'",
  );
  assert.equal(artifacts.uses, './.github/workflows/release-artifacts.yml');
  assert.deepEqual(artifacts.permissions, {
    contents: 'write',
    packages: 'write',
    'id-token': 'write',
  });
  assert.deepEqual(artifacts.with, {
    source_sha: '${{ needs.release_please.outputs.source_sha }}',
    tag: '${{ needs.release_please.outputs.tag }}',
    version: '${{ needs.release_please.outputs.version }}',
  });

  assertPinnedReviewedActions(value);
  assertSafeExecutionBoundary(source);
  assert.doesNotMatch(source, /skip-github-(?:release|pull-request)/u);
  assert.doesNotMatch(source, /\b(?:VOYAGE|DEEPSEEK)_[A-Z0-9_]+\b/u);
  assert.doesNotMatch(source, /\bgh\s+release\b/u);
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
    contents: 'read',
    packages: 'read',
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
    'release:manifest -- index-identity',
    'docker buildx imagetools inspect',
    'cosign verify',
    'release:manifest -- verify-index',
  ]);
  for (const command of repeatedPrCommands) {
    assert.doesNotMatch(
      verifyText,
      new RegExp(escapeRegExp(command), 'u'),
      `release artifact verify repeats PR gate: ${command}`,
    );
  }
  assert.equal(object(verify.outputs, 'verify outputs').index_tag, undefined);
  assert.equal(build.outputs, undefined);

  const buildText = runText(build, 'release artifact build');
  assertContains(buildText, [
    'docker history --no-trunc',
    'container-smoke.ts',
    'cosign attest',
    'cosign verify-attestation',
    'cosign sign-blob',
    'release:manifest -- finalize',
  ]);
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

  const attachText = runText(attach, 'release artifact attach');
  assertContains(attachText, [
    'gh release upload',
    '--clobber',
    'gh release download',
    'release:manifest -- verify-draft',
  ]);
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

test('pull request workflow owns source gates and checks release indexes without secrets', () => {
  const actual = workflow(prWorkflowPath, 'PR workflow');
  validatePrWorkflow(actual.value, actual.source);
  assertCodeowners();
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

test('manual index workflow is the only workflow allowed to consume Voyage', () => {
  const actual = workflow(indexWorkflowPath, 'index workflow');
  validateIndexWorkflow(actual.value, actual.source);
  for (const path of [
    prWorkflowPath,
    releaseWorkflowPath,
    releaseArtifactsWorkflowPath,
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

test('release contracts reject mutable actions, split ownership, and paid artifact builds', () => {
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
});
