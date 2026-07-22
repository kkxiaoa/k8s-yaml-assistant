export type RuntimeEnvironment = Readonly<
  Record<string, string | undefined>
>;

export const DEEPSEEK_ANSWER_MODEL = 'deepseek-v4-flash' as const;
export const VOYAGE_RERANK_MODEL = 'rerank-2.5' as const;

const RUNTIME_CONFIG_FIELDS = [
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_ANSWER_MODEL',
  'DEEPSEEK_API_KEY',
  'VOYAGE_EMBEDDING_URL',
  'VOYAGE_RERANK_URL',
  'VOYAGE_EMBEDDING_MODEL',
  'VOYAGE_RERANK_MODEL',
  'VOYAGE_API_KEY',
  'INDEX_DIR',
  'ENABLE_QUERY_EXPANSION',
] as const;

type RuntimeConfigField = (typeof RUNTIME_CONFIG_FIELDS)[number];

export type RuntimeConfigErrorCode =
  | 'missing_value'
  | 'invalid_value'
  | 'unknown_field';

export interface RuntimeConfigError {
  code: RuntimeConfigErrorCode;
  field: string;
}

export interface RuntimeConfig {
  deepseek: {
    baseUrl: string;
  };
  voyage: {
    embeddingUrl: string;
    rerankUrl: string;
    embeddingModel: string;
    rerankModel: string;
  };
  indexDir: string;
  queryExpansionEnabled: boolean;
}

export type RuntimeConfigResult =
  | { ok: true; config: RuntimeConfig }
  | { ok: false; error: RuntimeConfigError };

export type RuntimeCapability = 'deepseek' | 'voyage';
export type RuntimeAvailabilityErrorCode =
  | 'runtime_config_invalid'
  | 'deepseek_unavailable'
  | 'voyage_unavailable';

export type RuntimeCapabilityStatus =
  | { ok: true; config: RuntimeConfig }
  | { ok: false; code: RuntimeAvailabilityErrorCode };

const KNOWN_FIELDS = new Set<string>(RUNTIME_CONFIG_FIELDS);
const MODEL_NAME = /^[a-z0-9][a-z0-9.-]*$/;

function error(
  code: RuntimeConfigErrorCode,
  field: string,
): RuntimeConfigResult {
  return { ok: false, error: { code, field } };
}

function isRelevantField(field: string): boolean {
  return (
    field.startsWith('DEEPSEEK_') ||
    field.startsWith('VOYAGE_') ||
    field === 'INDEX_DIR' ||
    field === 'ENABLE_QUERY_EXPANSION'
  );
}

function required(
  environment: RuntimeEnvironment,
  field: RuntimeConfigField,
): string | RuntimeConfigResult {
  const value = environment[field];
  if (value === undefined || value.length === 0) {
    return error('missing_value', field);
  }
  if (value.trim() !== value || value.includes('\0')) {
    return error('invalid_value', field);
  }
  return value;
}

function supplierUrl(
  environment: RuntimeEnvironment,
  field: RuntimeConfigField,
): string | RuntimeConfigResult {
  const value = required(environment, field);
  if (typeof value !== 'string') return value;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return error('invalid_value', field);
    }
    return value;
  } catch {
    return error('invalid_value', field);
  }
}

function modelName(
  environment: RuntimeEnvironment,
  field: RuntimeConfigField,
  prefix: 'voyage-' | 'rerank-',
): string | RuntimeConfigResult {
  const value = required(environment, field);
  if (
    typeof value !== 'string' ||
    !MODEL_NAME.test(value) ||
    !value.startsWith(prefix)
  ) {
    return typeof value === 'string' ? error('invalid_value', field) : value;
  }
  return value;
}

function secretPresent(value: string | undefined): boolean {
  return value !== undefined && value.length > 0 && value.trim() === value;
}

export function decodeRuntimeConfig(
  environment: RuntimeEnvironment,
): RuntimeConfigResult {
  const unknownField = Object.keys(environment).find(
    (field) => isRelevantField(field) && !KNOWN_FIELDS.has(field),
  );
  if (unknownField) return error('unknown_field', unknownField);

  const deepseekBaseUrl = supplierUrl(environment, 'DEEPSEEK_BASE_URL');
  if (typeof deepseekBaseUrl !== 'string') return deepseekBaseUrl;

  const deepseekAnswerModel = required(environment, 'DEEPSEEK_ANSWER_MODEL');
  if (typeof deepseekAnswerModel !== 'string') return deepseekAnswerModel;
  if (deepseekAnswerModel !== DEEPSEEK_ANSWER_MODEL) {
    return error('invalid_value', 'DEEPSEEK_ANSWER_MODEL');
  }

  const embeddingUrl = supplierUrl(environment, 'VOYAGE_EMBEDDING_URL');
  if (typeof embeddingUrl !== 'string') return embeddingUrl;
  const rerankUrl = supplierUrl(environment, 'VOYAGE_RERANK_URL');
  if (typeof rerankUrl !== 'string') return rerankUrl;
  const embeddingModel = modelName(
    environment,
    'VOYAGE_EMBEDDING_MODEL',
    'voyage-',
  );
  if (typeof embeddingModel !== 'string') return embeddingModel;
  const rerankModel = modelName(
    environment,
    'VOYAGE_RERANK_MODEL',
    'rerank-',
  );
  if (typeof rerankModel !== 'string') return rerankModel;
  if (rerankModel !== VOYAGE_RERANK_MODEL) {
    return error('invalid_value', 'VOYAGE_RERANK_MODEL');
  }

  const indexDir = required(environment, 'INDEX_DIR');
  if (typeof indexDir !== 'string') return indexDir;
  if (indexDir === '/' || indexDir === '.') {
    return error('invalid_value', 'INDEX_DIR');
  }

  const queryExpansion = required(environment, 'ENABLE_QUERY_EXPANSION');
  if (typeof queryExpansion !== 'string') return queryExpansion;
  if (queryExpansion !== 'true' && queryExpansion !== 'false') {
    return error('invalid_value', 'ENABLE_QUERY_EXPANSION');
  }

  return {
    ok: true,
    config: {
      deepseek: {
        baseUrl: deepseekBaseUrl,
      },
      voyage: {
        embeddingUrl,
        rerankUrl,
        embeddingModel,
        rerankModel,
      },
      indexDir,
      queryExpansionEnabled: queryExpansion === 'true',
    },
  };
}

export function getRuntimeCapabilityStatus(
  capability: RuntimeCapability,
  environment: RuntimeEnvironment = process.env,
): RuntimeCapabilityStatus {
  const decoded = decodeRuntimeConfig(environment);
  if (!decoded.ok) return { ok: false, code: 'runtime_config_invalid' };
  const secret =
    capability === 'deepseek'
      ? environment.DEEPSEEK_API_KEY
      : environment.VOYAGE_API_KEY;
  if (!secretPresent(secret)) {
    return { ok: false, code: `${capability}_unavailable` };
  }
  return { ok: true, config: decoded.config };
}

export class RuntimeConfigFault extends Error {
  readonly code: RuntimeAvailabilityErrorCode;

  constructor(code: RuntimeAvailabilityErrorCode) {
    super('runtime configuration unavailable');
    this.name = 'RuntimeConfigFault';
    this.code = code;
  }
}

export function getRuntimeConfig(
  environment: RuntimeEnvironment = process.env,
): RuntimeConfig {
  const decoded = decodeRuntimeConfig(environment);
  if (!decoded.ok) throw new RuntimeConfigFault('runtime_config_invalid');
  return decoded.config;
}

export function requireRuntimeCapability(
  capability: RuntimeCapability,
  environment: RuntimeEnvironment = process.env,
): RuntimeConfig {
  const status = getRuntimeCapabilityStatus(capability, environment);
  if (!status.ok) throw new RuntimeConfigFault(status.code);
  return status.config;
}

export function getDeepSeekApiKey(
  environment: RuntimeEnvironment = process.env,
): string {
  requireRuntimeCapability('deepseek', environment);
  return environment.DEEPSEEK_API_KEY!;
}

export function getVoyageApiKey(
  environment: RuntimeEnvironment = process.env,
): string {
  requireRuntimeCapability('voyage', environment);
  return environment.VOYAGE_API_KEY!;
}
