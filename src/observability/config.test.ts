import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SERVING_OBSERVATION_HARD_LIMITS,
  decodeServingObservationConfig,
} from './config';

const LOCAL_ENV = {
  SERVING_OBSERVATION_MODE: 'local',
  SERVING_OBSERVATION_SAMPLE_RATE: '0.25',
  SERVING_OBSERVATION_MAX_FILE_BYTES: String(16 * 1024 * 1024),
  SERVING_OBSERVATION_MAX_TOTAL_BYTES: String(128 * 1024 * 1024),
  SERVING_OBSERVATION_RETENTION_DAYS: '7',
  SERVING_OBSERVATION_MAX_INPUT_BYTES: String(64 * 1024),
  SERVING_OBSERVATION_MAX_TEXT_BYTES: String(8 * 1024),
} as const;

const LOCAL_NUMERIC_ENV_KEYS = [
  'SERVING_OBSERVATION_SAMPLE_RATE',
  'SERVING_OBSERVATION_MAX_FILE_BYTES',
  'SERVING_OBSERVATION_MAX_TOTAL_BYTES',
  'SERVING_OBSERVATION_RETENTION_DAYS',
  'SERVING_OBSERVATION_MAX_INPUT_BYTES',
  'SERVING_OBSERVATION_MAX_TEXT_BYTES',
] as const;

function decode(overrides: Record<string, string | undefined> = {}) {
  return decodeServingObservationConfig({ ...LOCAL_ENV, ...overrides });
}

function assertRejectedWithoutRawValue(
  env: Record<string, string | undefined>,
  rawValue: string,
) {
  const result = decodeServingObservationConfig(env);

  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(rawValue), false);
}

test('defaults to an off-only snapshot when the mode is absent', () => {
  assert.deepEqual(
    decodeServingObservationConfig({
      DEEPSEEK_API_KEY: 'TestUnrelatedSecretValue',
      NODE_ENV: 'production',
    }),
    {
      ok: true,
      config: { mode: 'off' },
    },
  );
});

test('explicit off remains an emergency stop despite stale local values', () => {
  assert.deepEqual(
    decodeServingObservationConfig({
      SERVING_OBSERVATION_MODE: 'off',
      SERVING_OBSERVATION_SAMPLE_RATE: 'not-a-number',
      SERVING_OBSERVATION_MAX_FILE_BYTES: '-1',
    }),
    {
      ok: true,
      config: { mode: 'off' },
    },
  );
});

test('rejects an unknown mode without returning the raw value', () => {
  const rawMode = 'local-TestModeCredential123';

  assertRejectedWithoutRawValue(
    { SERVING_OBSERVATION_MODE: rawMode },
    rawMode,
  );
});

test('requires every numeric field in local mode without hidden defaults', () => {
  for (const field of LOCAL_NUMERIC_ENV_KEYS) {
    const result = decode({ [field]: undefined });

    assert.deepEqual(result, {
      ok: false,
      error: { code: 'missing_value', field },
    });
  }
});

test('rejects non-finite, malformed, and out-of-range sample rates', () => {
  for (const value of [
    'NaN',
    'Infinity',
    '-Infinity',
    '',
    ' 0.5 ',
    '.5',
    '1e-1',
    '-0.1',
    '1.1',
  ]) {
    const result = decode({ SERVING_OBSERVATION_SAMPLE_RATE: value });

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: 'invalid_value',
        field: 'SERVING_OBSERVATION_SAMPLE_RATE',
      },
    });
  }
});

test('accepts sample-rate boundaries zero and one', () => {
  for (const value of ['0', '1']) {
    const result = decode({ SERVING_OBSERVATION_SAMPLE_RATE: value });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.mode, 'local');
      if (result.config.mode === 'local') {
        assert.equal(result.config.sampleRate, Number(value));
      }
    }
  }
});

test('rejects nonpositive, fractional, and unsafe integer fields', () => {
  for (const field of LOCAL_NUMERIC_ENV_KEYS.slice(1)) {
    for (const value of ['0', '-1', '1.5', '1e3', '9007199254740992']) {
      const result = decode({ [field]: value });

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, 'invalid_value');
        assert.equal(result.error.field, field);
      }
    }
  }
});

test('rejects every configured hard-cap violation', () => {
  const cases = [
    [
      'SERVING_OBSERVATION_MAX_FILE_BYTES',
      SERVING_OBSERVATION_HARD_LIMITS.maxFileBytes,
    ],
    [
      'SERVING_OBSERVATION_MAX_TOTAL_BYTES',
      SERVING_OBSERVATION_HARD_LIMITS.maxTotalBytes,
    ],
    [
      'SERVING_OBSERVATION_RETENTION_DAYS',
      SERVING_OBSERVATION_HARD_LIMITS.retentionDays,
    ],
    [
      'SERVING_OBSERVATION_MAX_INPUT_BYTES',
      SERVING_OBSERVATION_HARD_LIMITS.maxInputBytes,
    ],
    [
      'SERVING_OBSERVATION_MAX_TEXT_BYTES',
      SERVING_OBSERVATION_HARD_LIMITS.maxTextBytes,
    ],
  ] as const;

  for (const [field, limit] of cases) {
    const result = decode({ [field]: String(limit + 1) });

    assert.deepEqual(result, {
      ok: false,
      error: { code: 'hard_cap_exceeded', field },
    });
  }
});

test('rejects file/total and text/input relationship violations', () => {
  assert.deepEqual(
    decode({
      SERVING_OBSERVATION_MAX_FILE_BYTES: String(2 * 1024 * 1024),
      SERVING_OBSERVATION_MAX_TOTAL_BYTES: String(1024 * 1024),
    }),
    {
      ok: false,
      error: {
        code: 'invalid_relationship',
        field: 'SERVING_OBSERVATION_MAX_FILE_BYTES',
      },
    },
  );

  assert.deepEqual(
    decode({
      SERVING_OBSERVATION_MAX_INPUT_BYTES: String(4 * 1024),
      SERVING_OBSERVATION_MAX_TEXT_BYTES: String(8 * 1024),
    }),
    {
      ok: false,
      error: {
        code: 'invalid_relationship',
        field: 'SERVING_OBSERVATION_MAX_TEXT_BYTES',
      },
    },
  );
});

test('returns only the reviewed local configuration snapshot', () => {
  const result = decodeServingObservationConfig({
    ...LOCAL_ENV,
    DEEPSEEK_API_KEY: 'TestSnapshotSecretValue',
    INDEX_DIR: '/tmp/unrelated-index',
  });

  assert.deepEqual(result, {
    ok: true,
    config: {
      mode: 'local',
      sampleRate: 0.25,
      maxFileBytes: 16 * 1024 * 1024,
      maxTotalBytes: 128 * 1024 * 1024,
      retentionDays: 7,
      maxInputBytes: 64 * 1024,
      maxTextBytes: 8 * 1024,
    },
  });
  assert.equal(JSON.stringify(result).includes('TestSnapshotSecretValue'), false);
  assert.equal(JSON.stringify(result).includes('/tmp/unrelated-index'), false);
});

test('does not expose malformed values or thrown environment details', () => {
  const rawValue = 'TestInvalidConfigCredential123';
  assertRejectedWithoutRawValue(
    { ...LOCAL_ENV, SERVING_OBSERVATION_MAX_FILE_BYTES: rawValue },
    rawValue,
  );

  const env = {} as Record<string, string | undefined>;
  Object.defineProperty(env, 'SERVING_OBSERVATION_MODE', {
    get() {
      throw new Error(rawValue);
    },
  });
  const result = decodeServingObservationConfig(env);

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'config_internal' },
  });
  assert.equal(JSON.stringify(result).includes(rawValue), false);
});
