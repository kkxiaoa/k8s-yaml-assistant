import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import {
  DEPLOYMENT_AUTHORIZATION_BUNDLE_MAX_EMBEDDED_BYTES,
  DEPLOYMENT_AUTHORIZATION_MAX_EMBEDDED_BYTES,
  DEPLOYMENT_PROVENANCE_BUNDLE_MAX_EMBEDDED_BYTES,
  DEPLOYMENT_REQUEST_MAX_BYTES,
  IMAGE_NAME,
  REPOSITORY,
} from './manifest';

const DEPLOYMENT_ENVIRONMENT = 'production-private' as const;

const RESULT_MAX_BYTES = 4 * 1024;
const REPOSITORY_URL = `https://api.github.com/repos/${REPOSITORY}`;
const SEMVER = '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)';
const DEPLOY_TAG_PATTERN = new RegExp(`^v${SEMVER}$`, 'u');
const ROLLBACK_TAG_PATTERN = new RegExp(
  `^rollback-v(?<version>${SEMVER})-sha256-(?<digest>[a-f0-9]{64})-r(?<runId>[1-9][0-9]{0,31})$`,
  'u',
);
const DECIMAL_ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const DecimalIdSchema = z.string().regex(DECIMAL_ID_PATTERN);
const CommitSchema = z.string().regex(COMMIT_PATTERN);
const ImageDigestSchema = z.string().regex(IMAGE_DIGEST_PATTERN);
const Sha256Schema = z.string().regex(SHA256_PATTERN);
const UtcTimestampSchema = z.iso.datetime({ offset: false });

const AuthorizationInputSchema = z.strictObject({
  action: z.enum(['deploy', 'rollback']),
  releaseId: DecimalIdSchema,
  releaseTag: z.string().min(1),
  sourceCommit: CommitSchema,
  publishedAt: UtcTimestampSchema,
  imageDigest: ImageDigestSchema,
  provenanceBundleSha256: Sha256Schema,
  workflowRunId: DecimalIdSchema,
  workflowRunAttempt: DecimalIdSchema,
});

function actionTagIssue(
  action: 'deploy' | 'rollback',
  releaseTag: string,
  imageDigest: string,
): string | null {
  if (Buffer.byteLength(releaseTag) > 128) {
    return 'release tag exceeds 128 bytes';
  }
  if (action === 'deploy') {
    return DEPLOY_TAG_PATTERN.test(releaseTag)
      ? null
      : 'deploy authorization requires a release tag';
  }
  const rollback = ROLLBACK_TAG_PATTERN.exec(releaseTag);
  return rollback?.groups?.digest === imageDigest.slice('sha256:'.length)
    ? null
    : 'rollback tag must bind the target image digest';
}

const AuthorizationSchema = z
  .strictObject({
    ...AuthorizationInputSchema.shape,
    schemaVersion: z.literal(1),
    repository: z.literal(REPOSITORY),
    imageName: z.literal(IMAGE_NAME),
  })
  .superRefine((value, context) => {
    const issue = actionTagIssue(
      value.action,
      value.releaseTag,
      value.imageDigest,
    );
    if (issue !== null) {
      context.addIssue({
        code: 'custom',
        path: ['releaseTag'],
        message: issue,
      });
    }
  });

type DeploymentAuthorization = z.infer<typeof AuthorizationSchema>;

interface DeploymentAuthorizationDocument {
  text: string;
  value: DeploymentAuthorization;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`${label} must contain valid JSON`);
  }
  if (
    decoded === null ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded)
  ) {
    throw new TypeError(`${label} must contain a JSON object`);
  }
  return decoded as Record<string, unknown>;
}

function assertEmbeddedStringLimit(
  value: string,
  maxBytes: number,
  label: string,
): void {
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) {
    throw new TypeError(`${label} exceeds its deployment request budget`);
  }
}

function canonicalAuthorization(value: DeploymentAuthorization): string {
  return `${JSON.stringify({
    schemaVersion: value.schemaVersion,
    action: value.action,
    repository: value.repository,
    releaseId: value.releaseId,
    releaseTag: value.releaseTag,
    sourceCommit: value.sourceCommit,
    publishedAt: value.publishedAt,
    imageName: value.imageName,
    imageDigest: value.imageDigest,
    provenanceBundleSha256: value.provenanceBundleSha256,
    workflowRunId: value.workflowRunId,
    workflowRunAttempt: value.workflowRunAttempt,
  })}\n`;
}

function decodeDeploymentAuthorization(
  text: string,
  provenanceBundle: string,
): DeploymentAuthorization {
  const value = AuthorizationSchema.parse(parseJsonObject(text, 'authorization'));
  if (
    text !== canonicalAuthorization(value) ||
    value.provenanceBundleSha256 !== sha256(provenanceBundle)
  ) {
    throw new TypeError(
      'authorization bytes or provenance bundle identity do not match',
    );
  }
  return value;
}

function decodeDeploymentRequestBase64(
  value: string,
): DeploymentAuthorization {
  const request = decodeCanonicalBase64(
    value,
    DEPLOYMENT_REQUEST_MAX_BYTES,
    'deployment request',
  );
  return decodeDeploymentRequestEnvelope(
    parseJsonObject(request, 'deployment request'),
  );
}

export function createDeploymentAuthorization(
  input: unknown,
): DeploymentAuthorizationDocument {
  const decoded = AuthorizationInputSchema.parse(input);
  const issue = actionTagIssue(
    decoded.action,
    decoded.releaseTag,
    decoded.imageDigest,
  );
  if (issue !== null) {
    throw new TypeError(issue);
  }
  const authorization: DeploymentAuthorization = {
    schemaVersion: 1,
    action: decoded.action,
    repository: REPOSITORY,
    releaseId: decoded.releaseId,
    releaseTag: decoded.releaseTag,
    sourceCommit: decoded.sourceCommit,
    publishedAt: decoded.publishedAt,
    imageName: IMAGE_NAME,
    imageDigest: decoded.imageDigest,
    provenanceBundleSha256: decoded.provenanceBundleSha256,
    workflowRunId: decoded.workflowRunId,
    workflowRunAttempt: decoded.workflowRunAttempt,
  };
  return {
    text: canonicalAuthorization(authorization),
    value: authorization,
  };
}

const RequestInputSchema = z.strictObject({
  authorization: z.string().min(1),
  authorizationBundle: z.string().min(1),
  provenanceBundle: z.string().min(1),
});
const DeploymentRequestSchema = RequestInputSchema.extend({
  schemaVersion: z.literal(1),
});

function validateDeploymentRequestComponents(
  value: z.infer<typeof RequestInputSchema>,
): DeploymentAuthorization {
  assertEmbeddedStringLimit(
    value.authorization,
    DEPLOYMENT_AUTHORIZATION_MAX_EMBEDDED_BYTES,
    'deployment authorization',
  );
  assertEmbeddedStringLimit(
    value.authorizationBundle,
    DEPLOYMENT_AUTHORIZATION_BUNDLE_MAX_EMBEDDED_BYTES,
    'authorization bundle',
  );
  assertEmbeddedStringLimit(
    value.provenanceBundle,
    DEPLOYMENT_PROVENANCE_BUNDLE_MAX_EMBEDDED_BYTES,
    'provenance bundle',
  );
  parseJsonObject(value.authorizationBundle, 'authorization bundle');
  parseJsonObject(value.provenanceBundle, 'provenance bundle');
  return decodeDeploymentAuthorization(
    value.authorization,
    value.provenanceBundle,
  );
}

function decodeDeploymentRequestEnvelope(
  input: unknown,
): DeploymentAuthorization {
  const value = DeploymentRequestSchema.parse(input);
  return validateDeploymentRequestComponents(value);
}

export function createDeploymentRequest(input: unknown): string {
  const value = RequestInputSchema.parse(input);
  validateDeploymentRequestComponents(value);
  const request = `${JSON.stringify({
    schemaVersion: 1,
    authorization: value.authorization,
    authorizationBundle: value.authorizationBundle,
    provenanceBundle: value.provenanceBundle,
  })}\n`;
  if (Buffer.byteLength(request) > DEPLOYMENT_REQUEST_MAX_BYTES) {
    throw new TypeError('deployment request exceeds 64 KiB');
  }
  return request;
}

const DeploymentPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    repository: z.literal(REPOSITORY),
    environment: z.literal(DEPLOYMENT_ENVIRONMENT),
    action: z.enum(['deploy', 'rollback']),
    releaseId: DecimalIdSchema,
    releaseTag: z.string().min(1),
    releaseCommit: CommitSchema,
    sourceCommit: CommitSchema,
    imageDigest: ImageDigestSchema,
    workflowRunId: DecimalIdSchema,
    workflowRunAttempt: DecimalIdSchema,
  })
  .superRefine((value, context) => {
    const issue = actionTagIssue(
      value.action,
      value.releaseTag,
      value.imageDigest,
    );
    if (issue !== null) {
      context.addIssue({
        code: 'custom',
        path: ['releaseTag'],
        message: issue,
      });
    }
  });

const DeploymentRecordSchema = z.strictObject({
  deployment: z.strictObject({
    ref: z.string().min(1),
    sha: CommitSchema,
    task: z.literal('deploy'),
    environment: z.literal(DEPLOYMENT_ENVIRONMENT),
    repositoryUrl: z.literal(REPOSITORY_URL),
    transientEnvironment: z.literal(false),
    productionEnvironment: z.literal(true),
    payload: DeploymentPayloadSchema,
  }),
  statuses: z.array(
    z.strictObject({
      state: z.enum([
        'error',
        'failure',
        'inactive',
        'in_progress',
        'queued',
        'pending',
        'success',
      ]),
      environment: z.literal(DEPLOYMENT_ENVIRONMENT),
      repositoryUrl: z.literal(REPOSITORY_URL),
      createdAt: UtcTimestampSchema,
    }),
  ),
});

function latestByTimestamp<T extends { createdAt: string }>(
  values: readonly T[],
  label: string,
): T | null {
  if (values.length === 0) return null;
  const sorted = values
    .map((value) => {
      const withoutZulu = value.createdAt.slice(0, -1);
      const dot = withoutZulu.indexOf('.');
      const whole = dot === -1 ? withoutZulu : withoutZulu.slice(0, dot);
      const fraction = dot === -1 ? '' : withoutZulu.slice(dot + 1);
      return {
        value,
        orderKey: `${whole}.${fraction.padEnd(6, '0')}Z`,
      };
    })
    .sort((left, right) =>
      right.orderKey.localeCompare(left.orderKey),
  );
  if (
    sorted[1] !== undefined &&
    sorted[0]!.orderKey === sorted[1].orderKey
  ) {
    throw new TypeError(`${label} has an ambiguous latest timestamp`);
  }
  return sorted[0]!.value;
}

export function resolveCurrentProductionDigest(value: unknown): string | null {
  const records = z.array(DeploymentRecordSchema).parse(value);
  const successful = records.flatMap((record) => {
    if (
      record.deployment.ref !== record.deployment.payload.releaseCommit ||
      record.deployment.sha !== record.deployment.payload.releaseCommit
    ) {
      throw new TypeError('deployment record identity is inconsistent');
    }
    const latestStatus = latestByTimestamp(
      record.statuses,
      'deployment statuses',
    );
    return latestStatus?.state === 'success'
      ? [
          {
            createdAt: latestStatus.createdAt,
            imageDigest: record.deployment.payload.imageDigest,
          },
        ]
      : [];
  });
  return (
    latestByTimestamp(successful, 'successful deployments')?.imageDigest ??
    null
  );
}

const WorkflowRunUrlSchema = z
  .string()
  .regex(
    /^https:\/\/github\.com\/kkxiaoa\/k8s-yaml-assistant\/actions\/runs\/[1-9][0-9]{0,31}(?:\/attempts\/[1-9][0-9]{0,31})?$/u,
  );

export function createGitHubDeploymentRequest(input: {
  authorization: DeploymentAuthorization;
  releaseCommit: unknown;
}): string {
  const releaseCommit = CommitSchema.parse(input.releaseCommit);
  const authorization = input.authorization;
  return `${JSON.stringify({
    ref: releaseCommit,
    task: 'deploy',
    auto_merge: false,
    required_contexts: [],
    payload: {
      schemaVersion: 1,
      repository: REPOSITORY,
      environment: DEPLOYMENT_ENVIRONMENT,
      action: authorization.action,
      releaseId: authorization.releaseId,
      releaseTag: authorization.releaseTag,
      releaseCommit,
      sourceCommit: authorization.sourceCommit,
      imageDigest: authorization.imageDigest,
      workflowRunId: authorization.workflowRunId,
      workflowRunAttempt: authorization.workflowRunAttempt,
    },
    environment: DEPLOYMENT_ENVIRONMENT,
    description: 'Deploy an authorized published release.',
    transient_environment: false,
    production_environment: true,
  })}\n`;
}

export function createGitHubDeploymentStatusRequest(input: unknown): string {
  const value = z
    .strictObject({
      state: z.enum(['pending', 'success', 'failure']),
      description: z.string().min(1).max(140),
      workflowRunUrl: WorkflowRunUrlSchema,
    })
    .parse(input);
  return `${JSON.stringify({
    state: value.state,
    log_url: value.workflowRunUrl,
    description: value.description,
    environment: DEPLOYMENT_ENVIRONMENT,
    auto_inactive: false,
  })}\n`;
}

const ListedReleaseSchema = z.strictObject({
  tagName: z.string().min(1),
  isDraft: z.boolean(),
});

export function resolveRollbackCandidateTag(input: unknown): string {
  const value = z
    .strictObject({
      sourceTag: z.string().regex(DEPLOY_TAG_PATTERN),
      imageDigest: ImageDigestSchema,
      workflowRunId: DecimalIdSchema,
      releases: z.array(ListedReleaseSchema),
    })
    .parse(input);
  const tag =
    `rollback-${value.sourceTag}-sha256-` +
    `${value.imageDigest.slice('sha256:'.length)}-r${value.workflowRunId}`;
  if (
    Buffer.byteLength(tag) > 128 ||
    value.releases.some(
      (release) =>
        release.tagName === tag ||
        (release.isDraft && ROLLBACK_TAG_PATTERN.test(release.tagName)),
    )
  ) {
    throw new TypeError('rollback release candidate conflicts with release state');
  }
  return tag;
}

type DeploymentReleaseTag =
  | {
      action: 'deploy';
      sourceTag: null;
      imageDigest: null;
    }
  | {
      action: 'rollback';
      sourceTag: string;
      imageDigest: string;
    };

export function resolveDeploymentReleaseTag(value: unknown): DeploymentReleaseTag {
  const tag = z.string().min(1).parse(value);
  if (DEPLOY_TAG_PATTERN.test(tag)) {
    return {
      action: 'deploy',
      sourceTag: null,
      imageDigest: null,
    };
  }
  const rollback = ROLLBACK_TAG_PATTERN.exec(tag);
  if (
    rollback?.groups?.version === undefined ||
    rollback.groups.digest === undefined
  ) {
    throw new TypeError('published release tag is not deployable');
  }
  return {
    action: 'rollback',
    sourceTag: `v${rollback.groups.version}`,
    imageDigest: `sha256:${rollback.groups.digest}`,
  };
}

const PublishedRollbackReleaseSchema = z.strictObject({
  databaseId: z.number().int().positive().safe(),
  tagName: z.string().min(1),
  targetCommitish: CommitSchema,
  isDraft: z.literal(false),
  isPrerelease: z.literal(false),
  publishedAt: UtcTimestampSchema,
  assets: z.array(
    z.strictObject({
      name: z.string().min(1),
    }),
  ),
});

const PublishedDeploymentIdentitySchema = z.strictObject({
  releaseId: DecimalIdSchema,
  releaseTag: z.string().min(1),
  sourceCommit: CommitSchema,
  publishedAt: UtcTimestampSchema,
  imageName: z.literal(IMAGE_NAME),
  imageDigest: ImageDigestSchema,
  provenanceBundleSha256: Sha256Schema,
});

const PublishedApplicationIdentitySchema =
  PublishedDeploymentIdentitySchema.extend({
    releaseTag: z.string().regex(DEPLOY_TAG_PATTERN),
  });

type PublishedDeploymentIdentity = z.infer<
  typeof PublishedDeploymentIdentitySchema
>;

function assertProvenanceBundleIdentity(
  expectedSha256: string,
  provenanceBundle: string,
): void {
  if (expectedSha256 !== sha256(provenanceBundle)) {
    throw new TypeError(
      'published deployment identity does not match provenance bytes',
    );
  }
}

const RollbackDraftReleaseSchema = z.strictObject({
  tagName: z.string().min(1),
  targetCommitish: CommitSchema,
  isDraft: z.literal(true),
  isPrerelease: z.literal(false),
  assets: z.array(
    z.strictObject({
      name: z.string().min(1),
    }),
  ),
});
const RollbackVerificationInputSchema = z.strictObject({
  release: z.unknown(),
  tagCommit: CommitSchema,
  provenanceBundle: z.string().min(1),
  sourceIdentity: z.unknown(),
});

interface RollbackReleaseEvidence {
  tagName: string;
  targetCommitish: string;
  assets: Array<{ name: string }>;
}

function verifyRollbackReleaseEvidence(
  release: RollbackReleaseEvidence,
  tagCommit: string,
  provenanceBundle: string,
  sourceIdentityValue: unknown,
): z.infer<typeof PublishedApplicationIdentitySchema> {
  const sourceIdentity = PublishedApplicationIdentitySchema.parse(
    sourceIdentityValue,
  );
  assertProvenanceBundleIdentity(
    sourceIdentity.provenanceBundleSha256,
    provenanceBundle,
  );
  const tag = resolveDeploymentReleaseTag(release.tagName);
  if (
    tag.action !== 'rollback' ||
    release.targetCommitish !== tagCommit ||
    tag.sourceTag !== sourceIdentity.releaseTag ||
    tag.imageDigest !== sourceIdentity.imageDigest ||
    release.assets.length !== 1 ||
    release.assets[0]?.name !== 'provenance-attestation.sigstore.json'
  ) {
    throw new TypeError(
      'rollback release does not match its source evidence',
    );
  }
  return sourceIdentity;
}

export function verifyRollbackDraftRelease(input: unknown): void {
  const value = RollbackVerificationInputSchema.parse(input);
  verifyRollbackReleaseEvidence(
    RollbackDraftReleaseSchema.parse(value.release),
    value.tagCommit,
    value.provenanceBundle,
    value.sourceIdentity,
  );
}

export function decodePublishedDeploymentIdentity(
  value: unknown,
  provenanceBundle: string,
): PublishedDeploymentIdentity & {
  action: 'deploy' | 'rollback';
} {
  const identity = PublishedDeploymentIdentitySchema.parse(value);
  const tag = resolveDeploymentReleaseTag(identity.releaseTag);
  if (
    tag.action === 'rollback' &&
    tag.imageDigest !== identity.imageDigest
  ) {
    throw new TypeError('rollback identity must bind its image digest');
  }
  assertProvenanceBundleIdentity(
    identity.provenanceBundleSha256,
    provenanceBundle,
  );
  return {
    ...identity,
    action: tag.action,
  };
}

export function verifyPublishedRollbackRelease(input: unknown): {
  releaseId: string;
  releaseTag: string;
  sourceCommit: string;
  publishedAt: string;
  imageName: typeof IMAGE_NAME;
  imageDigest: string;
  provenanceBundleSha256: string;
} {
  const value = RollbackVerificationInputSchema.parse(input);
  const release = PublishedRollbackReleaseSchema.parse(value.release);
  const sourceIdentity = verifyRollbackReleaseEvidence(
    release,
    value.tagCommit,
    value.provenanceBundle,
    value.sourceIdentity,
  );
  return {
    releaseId: String(release.databaseId),
    releaseTag: release.tagName,
    sourceCommit: sourceIdentity.sourceCommit,
    publishedAt: release.publishedAt,
    imageName: sourceIdentity.imageName,
    imageDigest: sourceIdentity.imageDigest,
    provenanceBundleSha256:
      sourceIdentity.provenanceBundleSha256,
  };
}

const FailureCodeSchema = z.enum([
  'invalid_request',
  'request_too_large',
  'authorization_invalid',
  'provenance_invalid',
  'identity_mismatch',
  'replay_rejected',
  'rollback_not_accepted',
  'busy',
  'recovery_required',
  'state_drift',
  'apply_failed_rolled_back',
  'rollback_failed',
  'verification_failed',
  'internal_error',
]);

const AdapterResultSchema = z.strictObject({
  event: z.literal('k8s_yaml_assistant_deployment'),
  action: z.enum(['deploy', 'rollback']).nullable(),
  releaseId: DecimalIdSchema.nullable(),
  releaseTag: z.string().nullable(),
  sourceCommit: CommitSchema.nullable(),
  workflowRunId: DecimalIdSchema.nullable(),
  workflowRunAttempt: DecimalIdSchema.nullable(),
  previousDigest: ImageDigestSchema.nullable(),
  targetDigest: ImageDigestSchema.nullable(),
  result: z.enum(['success', 'already_applied', 'failure']),
  failureCode: FailureCodeSchema.nullable(),
  durationMs: z.number().int().nonnegative(),
});

const ResultInputSchema = z.strictObject({
  resultBase64: z.string(),
  requestBase64: z.string().min(1),
  jobResult: z.enum(['success', 'failure', 'cancelled', 'skipped']),
});

export interface DeploymentStatusDecision {
  state: 'success' | 'failure';
  description: string;
}

function decodeCanonicalBase64(
  value: string,
  maxBytes: number,
  label: string,
): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError(`${label} must be canonical Base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.length === 0 ||
    bytes.length > maxBytes ||
    bytes.toString('base64') !== value
  ) {
    throw new TypeError(
      `${label} is empty, oversized or non-canonical`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${label} must be UTF-8`);
  }
}

export function resolveAdapterResult(input: unknown): DeploymentStatusDecision {
  const value = ResultInputSchema.parse(input);
  const authorization = decodeDeploymentRequestBase64(
    value.requestBase64,
  );
  if (value.resultBase64.length === 0) {
    if (value.jobResult === 'success') {
      throw new TypeError('successful production job must return a result');
    }
    return {
      state: 'failure',
      description: 'Production runner or adapter failed.',
    };
  }
  const result = AdapterResultSchema.parse(
    parseJsonObject(
      decodeCanonicalBase64(
        value.resultBase64,
        RESULT_MAX_BYTES,
        'adapter result',
      ),
      'adapter result',
    ),
  );
  const expected = {
    action: authorization.action,
    releaseId: authorization.releaseId,
    releaseTag: authorization.releaseTag,
    sourceCommit: authorization.sourceCommit,
    workflowRunId: authorization.workflowRunId,
    workflowRunAttempt: authorization.workflowRunAttempt,
    targetDigest: authorization.imageDigest,
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (result[field as keyof typeof result] !== expectedValue) {
      throw new TypeError(`adapter result ${field} does not match authorization`);
    }
  }
  if (
    value.jobResult === 'success' &&
    (result.result === 'success' || result.result === 'already_applied') &&
    result.failureCode === null
  ) {
    return {
      state: 'success',
      description: 'Deployment adapter completed successfully.',
    };
  }
  if (value.jobResult !== 'success' && result.result === 'failure') {
    return {
      state: 'failure',
      description: `Deployment adapter failed: ${result.failureCode ?? 'internal_error'}.`,
    };
  }
  throw new TypeError('production job and adapter result states disagree');
}
