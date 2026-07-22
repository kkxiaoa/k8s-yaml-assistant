import {
  SERVING_REDACTION_HARD_MAX_INPUT_BYTES,
  SERVING_REDACTION_HARD_MAX_TEXT_BYTES,
} from './redaction';

export const SERVING_OBSERVATION_HARD_LIMITS = Object.freeze({
  maxFileBytes: 128 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  retentionDays: 30,
  maxInputBytes: SERVING_REDACTION_HARD_MAX_INPUT_BYTES,
  maxTextBytes: SERVING_REDACTION_HARD_MAX_TEXT_BYTES,
});

const MODE_ENV = 'SERVING_OBSERVATION_MODE' as const;
const SAMPLE_RATE_ENV = 'SERVING_OBSERVATION_SAMPLE_RATE' as const;
const MAX_FILE_BYTES_ENV = 'SERVING_OBSERVATION_MAX_FILE_BYTES' as const;
const MAX_TOTAL_BYTES_ENV = 'SERVING_OBSERVATION_MAX_TOTAL_BYTES' as const;
const RETENTION_DAYS_ENV = 'SERVING_OBSERVATION_RETENTION_DAYS' as const;
const MAX_INPUT_BYTES_ENV = 'SERVING_OBSERVATION_MAX_INPUT_BYTES' as const;
const MAX_TEXT_BYTES_ENV = 'SERVING_OBSERVATION_MAX_TEXT_BYTES' as const;

type ServingObservationLocalConfig = {
  mode: 'local';
  sampleRate: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  retentionDays: number;
  maxInputBytes: number;
  maxTextBytes: number;
};

export type ServingObservationConfig =
  | { mode: 'off' }
  | ServingObservationLocalConfig;

export type ServingObservationConfigField =
  | typeof MODE_ENV
  | typeof SAMPLE_RATE_ENV
  | typeof MAX_FILE_BYTES_ENV
  | typeof MAX_TOTAL_BYTES_ENV
  | typeof RETENTION_DAYS_ENV
  | typeof MAX_INPUT_BYTES_ENV
  | typeof MAX_TEXT_BYTES_ENV;

export type ServingObservationConfigError =
  | {
      code:
        | 'invalid_mode'
        | 'missing_value'
        | 'invalid_value'
        | 'hard_cap_exceeded'
        | 'invalid_relationship';
      field: ServingObservationConfigField;
    }
  | { code: 'config_internal' };

export type ServingObservationConfigResult =
  | { ok: true; config: ServingObservationConfig }
  | { ok: false; error: ServingObservationConfigError };

type EnvironmentSnapshot = Readonly<Record<string, string | undefined>>;

function rejected(
  code: Exclude<ServingObservationConfigError['code'], 'config_internal'>,
  field: ServingObservationConfigField,
): ServingObservationConfigResult {
  return { ok: false, error: { code, field } };
}

function parseSampleRate(
  rawValue: string | undefined,
): number | ServingObservationConfigResult {
  if (rawValue === undefined) return rejected('missing_value', SAMPLE_RATE_ENV);
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(rawValue)) {
    return rejected('invalid_value', SAMPLE_RATE_ENV);
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return rejected('invalid_value', SAMPLE_RATE_ENV);
  }
  return value;
}

function parsePositiveInteger(
  rawValue: string | undefined,
  field: Exclude<
    ServingObservationConfigField,
    typeof MODE_ENV | typeof SAMPLE_RATE_ENV
  >,
  hardLimit: number,
): number | ServingObservationConfigResult {
  if (rawValue === undefined) return rejected('missing_value', field);
  if (!/^[1-9]\d*$/u.test(rawValue)) {
    return rejected('invalid_value', field);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return rejected('invalid_value', field);
  }
  if (value > hardLimit) return rejected('hard_cap_exceeded', field);
  return value;
}

function isRejected(
  value: number | ServingObservationConfigResult,
): value is ServingObservationConfigResult {
  return typeof value !== 'number';
}

export function decodeServingObservationConfig(
  env: EnvironmentSnapshot,
): ServingObservationConfigResult {
  try {
    const mode = env[MODE_ENV];
    if (mode === undefined || mode === 'off') {
      return { ok: true, config: { mode: 'off' } };
    }
    if (mode !== 'local') return rejected('invalid_mode', MODE_ENV);

    const sampleRate = parseSampleRate(env[SAMPLE_RATE_ENV]);
    if (isRejected(sampleRate)) return sampleRate;

    const maxFileBytes = parsePositiveInteger(
      env[MAX_FILE_BYTES_ENV],
      MAX_FILE_BYTES_ENV,
      SERVING_OBSERVATION_HARD_LIMITS.maxFileBytes,
    );
    if (isRejected(maxFileBytes)) return maxFileBytes;

    const maxTotalBytes = parsePositiveInteger(
      env[MAX_TOTAL_BYTES_ENV],
      MAX_TOTAL_BYTES_ENV,
      SERVING_OBSERVATION_HARD_LIMITS.maxTotalBytes,
    );
    if (isRejected(maxTotalBytes)) return maxTotalBytes;

    const retentionDays = parsePositiveInteger(
      env[RETENTION_DAYS_ENV],
      RETENTION_DAYS_ENV,
      SERVING_OBSERVATION_HARD_LIMITS.retentionDays,
    );
    if (isRejected(retentionDays)) return retentionDays;

    const maxInputBytes = parsePositiveInteger(
      env[MAX_INPUT_BYTES_ENV],
      MAX_INPUT_BYTES_ENV,
      SERVING_OBSERVATION_HARD_LIMITS.maxInputBytes,
    );
    if (isRejected(maxInputBytes)) return maxInputBytes;

    const maxTextBytes = parsePositiveInteger(
      env[MAX_TEXT_BYTES_ENV],
      MAX_TEXT_BYTES_ENV,
      SERVING_OBSERVATION_HARD_LIMITS.maxTextBytes,
    );
    if (isRejected(maxTextBytes)) return maxTextBytes;

    if (maxFileBytes > maxTotalBytes) {
      return rejected('invalid_relationship', MAX_FILE_BYTES_ENV);
    }
    if (maxTextBytes > maxInputBytes) {
      return rejected('invalid_relationship', MAX_TEXT_BYTES_ENV);
    }

    return {
      ok: true,
      config: {
        mode: 'local',
        sampleRate,
        maxFileBytes,
        maxTotalBytes,
        retentionDays,
        maxInputBytes,
        maxTextBytes,
      },
    };
  } catch {
    return { ok: false, error: { code: 'config_internal' } };
  }
}
