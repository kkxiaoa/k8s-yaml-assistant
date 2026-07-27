import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  createDeploymentAuthorization,
  createDeploymentRequest,
  createGitHubDeploymentRequest,
  createGitHubDeploymentStatusRequest,
  decodePublishedDeploymentIdentity,
  resolveAdapterResult,
  resolveCurrentProductionDigest,
  resolveDeploymentReleaseTag,
  resolveRollbackCandidateTag,
  verifyRollbackDraftRelease,
  verifyPublishedRollbackRelease,
  type DeploymentStatusDecision,
} from '../src/release/deployment-authorization';
import {
  DEPLOYMENT_AUTHORIZATION_BUNDLE_MAX_EMBEDDED_BYTES,
  DEPLOYMENT_AUTHORIZATION_MAX_EMBEDDED_BYTES,
  DEPLOYMENT_PROVENANCE_BUNDLE_MAX_EMBEDDED_BYTES,
} from '../src/release/manifest';

type Options = Record<string, string>;

const textLimits = {
  authorization: DEPLOYMENT_AUTHORIZATION_MAX_EMBEDDED_BYTES,
  authorizationBundle:
    DEPLOYMENT_AUTHORIZATION_BUNDLE_MAX_EMBEDDED_BYTES,
  github: 2 * 1024 * 1024,
  identity: 16 * 1024,
  provenanceBundle:
    DEPLOYMENT_PROVENANCE_BUNDLE_MAX_EMBEDDED_BYTES,
} as const;

function parseOptions(
  args: readonly string[],
  allowed: readonly string[],
): Options {
  const options: Options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith('--') ||
      value.startsWith('--')
    ) {
      throw new TypeError(
        'deployment-authorization options must be --name value pairs',
      );
    }
    const name = flag.slice(2);
    if (!allowed.includes(name)) {
      throw new TypeError(`unknown deployment-authorization option: ${flag}`);
    }
    if (options[name] !== undefined) {
      throw new TypeError(
        `duplicate deployment-authorization option: ${flag}`,
      );
    }
    options[name] = value;
  }
  for (const name of allowed) {
    if (options[name] === undefined) {
      throw new TypeError(
        `missing deployment-authorization option: --${name}`,
      );
    }
  }
  return options;
}

function readText(path: string, maxBytes: number, label: string): string {
  const size = statSync(path).size;
  if (size === 0 || size > maxBytes) {
    throw new TypeError(`${label} exceeds its file size boundary`);
  }
  return readFileSync(path, 'utf8');
}

function readJson(path: string, maxBytes: number, label: string): unknown {
  try {
    return JSON.parse(readText(path, maxBytes, label)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError(`${label} must contain valid JSON`);
    }
    throw error;
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function number(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function appendGitHubOutputs(
  path: string,
  outputs: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(outputs)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(name) || /[\r\n]/u.test(value)) {
      throw new TypeError('GitHub outputs must be single-line values');
    }
    appendFileSync(resolve(path), `${name}=${value}\n`);
  }
}

function inspectTag(options: Options): void {
  const tag = resolveDeploymentReleaseTag(options['release-tag']);
  appendGitHubOutputs(resolve(options['github-output']!), {
    action: tag.action,
    source_tag: tag.sourceTag ?? 'none',
  });
}

function create(options: Options): void {
  const provenanceBundle = readText(
    options['provenance-bundle']!,
    textLimits.provenanceBundle,
    'provenance bundle',
  );
  const identity = decodePublishedDeploymentIdentity(
    readJson(
      options['identity-json']!,
      textLimits.identity,
      'published deployment identity',
    ),
    provenanceBundle,
  );
  const authorization = createDeploymentAuthorization({
    action: identity.action,
    releaseId: identity.releaseId,
    releaseTag: identity.releaseTag,
    sourceCommit: identity.sourceCommit,
    publishedAt: identity.publishedAt,
    imageDigest: identity.imageDigest,
    provenanceBundleSha256: identity.provenanceBundleSha256,
    workflowRunId: options['workflow-run-id'],
    workflowRunAttempt: options['workflow-run-attempt'],
  });
  writeText(options['authorization-out']!, authorization.text);
  writeText(
    options['deployment-out']!,
    createGitHubDeploymentRequest({
      authorization: authorization.value,
      releaseCommit: options['release-commit'],
    }),
  );
  writeText(
    options['pending-status-out']!,
    createGitHubDeploymentStatusRequest({
      state: 'pending',
      description:
        'Published release verified; awaiting production runner.',
      workflowRunUrl: options['workflow-run-url'],
    }),
  );
}

function request(options: Options): void {
  const authorization = readText(
    options.authorization!,
    textLimits.authorization,
    'deployment authorization',
  );
  const authorizationBundle = readText(
    options['authorization-bundle']!,
    textLimits.authorizationBundle,
    'authorization bundle',
  );
  const provenanceBundle = readText(
    options['provenance-bundle']!,
    textLimits.provenanceBundle,
    'provenance bundle',
  );
  const encoded = Buffer.from(
    createDeploymentRequest({
      authorization,
      authorizationBundle,
      provenanceBundle,
    }),
  ).toString('base64');
  appendGitHubOutputs(resolve(options['github-output']!), {
    request_base64: encoded,
  });
}

function normalizeHistory(
  deploymentsValue: unknown,
  statusesDir: string,
): unknown[] {
  if (!Array.isArray(deploymentsValue) || deploymentsValue.length >= 100) {
    throw new TypeError(
      'GitHub deployment history must be a non-truncated array below 100',
    );
  }
  return deploymentsValue.map((candidate, index) => {
    const deployment = object(candidate, `deployment ${index}`);
    const id = number(deployment.id, `deployment ${index} id`);
    const statusesValue = readJson(
      join(statusesDir, `${id}.json`),
      textLimits.github,
      `deployment ${id} statuses`,
    );
    if (!Array.isArray(statusesValue) || statusesValue.length >= 100) {
      throw new TypeError(
        `deployment ${id} statuses must be a non-truncated array below 100`,
      );
    }
    return {
      deployment: {
        ref: deployment.ref,
        sha: deployment.sha,
        task: deployment.task,
        environment: deployment.environment,
        repositoryUrl: deployment.repository_url,
        transientEnvironment: deployment.transient_environment,
        productionEnvironment: deployment.production_environment,
        payload: deployment.payload,
      },
      statuses: statusesValue.map((statusCandidate, statusIndex) => {
        const status = object(
          statusCandidate,
          `deployment ${id} status ${statusIndex}`,
        );
        return {
          state: status.state,
          environment: status.environment,
          repositoryUrl: status.repository_url,
          createdAt: status.created_at,
        };
      }),
    };
  });
}

function currentProduction(options: Options): void {
  const deployments = readJson(
    options['deployments-json']!,
    textLimits.github,
    'GitHub deployments',
  );
  const digest = resolveCurrentProductionDigest(
    normalizeHistory(deployments, resolve(options['statuses-dir']!)),
  );
  appendGitHubOutputs(resolve(options['github-output']!), {
    current_production_digest: digest ?? 'none',
  });
}

function result(options: Options): void {
  let decision: DeploymentStatusDecision;
  try {
    decision = resolveAdapterResult({
      requestBase64: options['request-base64'],
      resultBase64:
        options['result-base64'] === 'none'
          ? ''
          : options['result-base64'],
      jobResult: options['job-result'],
    });
  } catch {
    decision = {
      state: 'failure' as const,
      description: 'Production runner returned an invalid result.',
    };
  }
  writeText(
    options['status-out']!,
    createGitHubDeploymentStatusRequest({
      ...decision,
      workflowRunUrl: options['workflow-run-url'],
    }),
  );
}

function rollbackCandidate(options: Options): void {
  const tag = resolveRollbackCandidateTag({
    sourceTag: options['source-tag'],
    imageDigest: options['image-digest'],
    workflowRunId: options['workflow-run-id'],
    releases: readJson(
      options['releases-json']!,
      textLimits.github,
      'GitHub releases',
    ),
  });
  writeText(
    options['notes-out']!,
    [
      '### Rollback target',
      '',
      `- Source release: \`${options['source-tag']}\``,
      `- Image digest: \`${options['image-digest']}\``,
      '',
      '### Safety boundary',
      '',
      '- Publishing this draft is the explicit authorization to request rollback.',
      '- The production adapter still requires this digest in its local success ledger.',
      '',
    ].join('\n'),
  );
  appendGitHubOutputs(resolve(options['github-output']!), {
    rollback_tag: tag,
  });
}

function verifyRollback(options: Options): void {
  const provenanceBundle = readText(
    options['provenance-bundle']!,
    textLimits.provenanceBundle,
    'rollback provenance bundle',
  );
  const sourceIdentity = readJson(
    options['source-identity']!,
    textLimits.identity,
    'source deployment identity',
  );
  const identity = verifyPublishedRollbackRelease({
    release: readJson(
      options['release-json']!,
      textLimits.github,
      'published rollback release',
    ),
    tagCommit: options['tag-commit'],
    provenanceBundle,
    sourceIdentity,
  });
  writeText(
    options['identity-out']!,
    `${JSON.stringify(identity, null, 2)}\n`,
  );
}

function verifyRollbackDraft(options: Options): void {
  const provenanceBundle = readText(
    options['provenance-bundle']!,
    textLimits.provenanceBundle,
    'rollback provenance bundle',
  );
  const sourceIdentity = readJson(
    options['source-identity']!,
    textLimits.identity,
    'source deployment identity',
  );
  verifyRollbackDraftRelease({
    release: readJson(
      options['release-json']!,
      textLimits.github,
      'rollback draft release',
    ),
    tagCommit: options['tag-commit'],
    provenanceBundle,
    sourceIdentity,
  });
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'inspect-tag') {
    inspectTag(
      parseOptions(args, ['release-tag', 'github-output']),
    );
    return;
  }
  if (command === 'create') {
    create(
      parseOptions(args, [
        'identity-json',
        'provenance-bundle',
        'workflow-run-id',
        'workflow-run-attempt',
        'release-commit',
        'workflow-run-url',
        'authorization-out',
        'deployment-out',
        'pending-status-out',
      ]),
    );
    return;
  }
  if (command === 'request') {
    request(
      parseOptions(args, [
        'authorization',
        'authorization-bundle',
        'provenance-bundle',
        'github-output',
      ]),
    );
    return;
  }
  if (command === 'current-production') {
    currentProduction(
      parseOptions(args, [
        'deployments-json',
        'statuses-dir',
        'github-output',
      ]),
    );
    return;
  }
  if (command === 'result') {
    result(
      parseOptions(args, [
        'request-base64',
        'result-base64',
        'job-result',
        'workflow-run-url',
        'status-out',
      ]),
    );
    return;
  }
  if (command === 'rollback-candidate') {
    rollbackCandidate(
      parseOptions(args, [
        'source-tag',
        'image-digest',
        'workflow-run-id',
        'releases-json',
        'notes-out',
        'github-output',
      ]),
    );
    return;
  }
  if (command === 'verify-rollback') {
    verifyRollback(
      parseOptions(args, [
        'release-json',
        'tag-commit',
        'provenance-bundle',
        'source-identity',
        'identity-out',
      ]),
    );
    return;
  }
  if (command === 'verify-rollback-draft') {
    verifyRollbackDraft(
      parseOptions(args, [
        'release-json',
        'tag-commit',
        'provenance-bundle',
        'source-identity',
      ]),
    );
    return;
  }
  throw new TypeError(
    'usage: deployment-authorization <inspect-tag|create|request|current-production|result|rollback-candidate|verify-rollback|verify-rollback-draft> [options]',
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
