import type { IndexMissReason } from '../retrieval/index-store';

type MaybePromise<T> = T | Promise<T>;

export type ReadinessErrorCode =
  | 'runtime_config_invalid'
  | 'schema_invalid'
  | 'policy_invalid'
  | 'aliases_missing'
  | 'aliases_invalid'
  | 'index_missing'
  | 'index_identity_mismatch'
  | 'index_invalid';

export type LivenessStatus = { status: 'live' };
export type ReadinessStatus =
  | { status: 'ready' }
  | { status: 'not_ready'; code: ReadinessErrorCode };

export type AliasHealthResult =
  | { ok: true }
  | { ok: false; errorCode: 'aliases_missing' | 'aliases_invalid' };

export type IndexHealthResult =
  | { ok: true }
  | { ok: false; reason: IndexMissReason };

export interface HealthCheckDependencies {
  validateRuntimeConfig(): MaybePromise<void>;
  validateSchema(): MaybePromise<void>;
  validatePolicy(): MaybePromise<void>;
  loadAliases(): MaybePromise<AliasHealthResult>;
  loadIndex(): MaybePromise<IndexHealthResult>;
}

export interface HealthService {
  liveness(): LivenessStatus;
  readiness(): Promise<ReadinessStatus>;
}

const LIVE = Object.freeze({ status: 'live' } as const);

function notReady(code: ReadinessErrorCode): ReadinessStatus {
  return Object.freeze({ status: 'not_ready', code });
}

export function readinessCodeForIndexMiss(
  reason: IndexMissReason,
): ReadinessErrorCode {
  switch (reason) {
    case 'missing_files':
    case 'incomplete_files':
      return 'index_missing';
    case 'corpus_count_mismatch':
    case 'corpus_content_mismatch':
    case 'corpus_manifest_mismatch':
    case 'embedding_model_mismatch':
    case 'index_hash_mismatch':
      return 'index_identity_mismatch';
    case 'read_error':
    case 'format_mismatch':
    case 'invalid_manifest':
    case 'chunk_count_mismatch':
    case 'invalid_chunk':
    case 'duplicate_chunk_id':
    case 'embedding_dimension_mismatch':
    case 'invalid_embedding':
      return 'index_invalid';
  }
}

async function initializeReadiness(
  dependencies: HealthCheckDependencies,
): Promise<ReadinessStatus> {
  try {
    await dependencies.validateRuntimeConfig();
  } catch {
    return notReady('runtime_config_invalid');
  }

  try {
    await dependencies.validateSchema();
  } catch {
    return notReady('schema_invalid');
  }

  try {
    await dependencies.validatePolicy();
  } catch {
    return notReady('policy_invalid');
  }

  let aliases: AliasHealthResult;
  try {
    aliases = await dependencies.loadAliases();
  } catch {
    return notReady('aliases_invalid');
  }
  if (!aliases.ok) return notReady(aliases.errorCode);

  let index: IndexHealthResult;
  try {
    index = await dependencies.loadIndex();
  } catch {
    return notReady('index_invalid');
  }
  if (!index.ok) return notReady(readinessCodeForIndexMiss(index.reason));

  return Object.freeze({ status: 'ready' });
}

async function validateRuntimeConfig(): Promise<void> {
  const { getRuntimeConfig } = await import('./runtime-config');
  getRuntimeConfig();
}

export function createHealthService(
  dependencies: HealthCheckDependencies,
): HealthService {
  let readinessPromise: Promise<ReadinessStatus> | null = null;
  return {
    liveness: () => LIVE,
    readiness: () =>
      (readinessPromise ??= initializeReadiness(dependencies)),
  };
}

async function validateSchema(): Promise<void> {
  const [{ decodeKnowledgeChunk }, { buildSchemaCorpus }] = await Promise.all([
    import('../knowledge/chunk'),
    import('../knowledge/schema-corpus'),
  ]);
  const chunks = buildSchemaCorpus();
  if (chunks.length === 0) throw new Error('schema corpus is empty');
  chunks.forEach((chunk) => decodeKnowledgeChunk(chunk));
}

async function validatePolicy(): Promise<void> {
  const [{ decodeKnowledgeChunk }, { buildPolicyCorpus }] = await Promise.all([
    import('../knowledge/chunk'),
    import('../knowledge/policy-corpus'),
  ]);
  const chunks = buildPolicyCorpus();
  if (chunks.length === 0) throw new Error('policy corpus is empty');
  chunks.forEach((chunk) => decodeKnowledgeChunk(chunk));
}

async function loadAliases(): Promise<AliasHealthResult> {
  const { loadAliasRegistrySnapshot } = await import(
    '../retrieval/query-expansion-runtime'
  );
  const result = loadAliasRegistrySnapshot();
  return result.ok
    ? { ok: true }
    : { ok: false, errorCode: result.errorCode };
}

async function loadIndex(): Promise<IndexHealthResult> {
  const retrieval = await import('../retrieval/retrieve');
  try {
    const chunks = await retrieval.getCorpusIndex();
    return chunks.length > 0
      ? { ok: true }
      : { ok: false, reason: 'chunk_count_mismatch' };
  } catch (error) {
    if (error instanceof retrieval.CorpusIndexUnavailableError) {
      return { ok: false, reason: error.reason };
    }
    throw error;
  }
}

const productionHealth = createHealthService({
  validateRuntimeConfig,
  validateSchema,
  validatePolicy,
  loadAliases,
  loadIndex,
});

export function getLiveness(): LivenessStatus {
  return productionHealth.liveness();
}

export function getReadiness(): Promise<ReadinessStatus> {
  return productionHealth.readiness();
}
