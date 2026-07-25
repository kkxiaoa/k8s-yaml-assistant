import assert from 'node:assert/strict';
import test from 'node:test';
import type { RetrievalTrace } from '../retrieval/trace';
import type { ServingObservationConfig } from './config';
import type { LocalObservationSink } from './local-sink';
import {
  createServingObservationRecorder,
  type ServingObservationRecorderDependencies,
} from './recorder';
import {
  ServingRedactionError,
  type RedactedServingQuestion,
} from './redaction';
import type { ServingRetrievalObservation } from './serving-observation';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const OBSERVATION_ID = '22222222-2222-4222-8222-222222222222';
const RAW_SECRET = 'TestRecorderRawSecret123';
const FIXED_NOW = new Date('2026-07-21T12:34:56.000Z');

const LOCAL_CONFIG: ServingObservationConfig = {
  mode: 'local',
  sampleRate: 1,
  maxFileBytes: 4096,
  maxTotalBytes: 16_384,
  retentionDays: 7,
  maxInputBytes: 4096,
  maxTextBytes: 2048,
};

function trace(overrides: Partial<RetrievalTrace> = {}): RetrievalTrace {
  return {
    question: `password=${RAW_SECRET}`,
    mode: 'free',
    queryText: RAW_SECRET,
    path: 'search',
    coarseHits: [],
    rerankHits: [],
    finalHits: [],
    latencyMs: { total: 3 },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function collectingSink(values: unknown[]): LocalObservationSink {
  return {
    append(value) {
      values.push(value);
      return { ok: true };
    },
  };
}

function dependencies(
  sink: LocalObservationSink,
  overrides: Partial<ServingObservationRecorderDependencies> = {},
): ServingObservationRecorderDependencies {
  return {
    clock: () => FIXED_NOW,
    idFactory: () => OBSERVATION_ID,
    sampler: () => true,
    sink,
    ...overrides,
  };
}

test('records synchronously only after redaction, allowlist projection, and strict decode', () => {
  const values: unknown[] = [];
  const events: string[] = [];
  const sink: LocalObservationSink = {
    append(value) {
      events.push('sink');
      values.push(value);
      return { ok: true };
    },
  };
  const recorder = createServingObservationRecorder(
    LOCAL_CONFIG,
    dependencies(sink),
  );

  events.push('before');
  const result = recorder.record(REQUEST_ID, trace());
  events.push('after');

  assert.deepEqual(result, { status: 'written' });
  assert.equal(result instanceof Promise, false);
  assert.deepEqual(events, ['before', 'sink', 'after']);
  assert.equal(values.length, 1);
  const written = values[0] as ServingRetrievalObservation;
  assert.equal(written.observationId, OBSERVATION_ID);
  assert.equal(written.requestId, REQUEST_ID);
  assert.equal(written.createdAt, FIXED_NOW.toISOString());
  assert.deepEqual(written.query, {
    disposition: 'redacted',
    text: 'password=[REDACTED]',
    redactionVersion: 'serving-redaction/v1',
    redactionLabels: ['credential_assignment'],
  });
  const serialized = JSON.stringify(written);
  assert.equal(serialized.includes(RAW_SECRET), false);
  assert.equal(serialized.includes('queryText'), false);
});

test('sampled-out and off modes touch no content-processing dependency or sink', () => {
  const sampledEvents: string[] = [];
  const sampledRecorder = createServingObservationRecorder(
    { ...LOCAL_CONFIG, sampleRate: 0.5 },
    dependencies(
      {
        append() {
          sampledEvents.push('sink');
          return { ok: true };
        },
      },
      {
        sampler(requestId, sampleRate) {
          sampledEvents.push(`sample:${requestId}:${sampleRate}`);
          return false;
        },
        redactor() {
          sampledEvents.push('redactor');
          throw new Error('must not run');
        },
        projector() {
          sampledEvents.push('projector');
          throw new Error('must not run');
        },
        decoder() {
          sampledEvents.push('decoder');
          throw new Error('must not run');
        },
      },
    ),
  );

  assert.deepEqual(sampledRecorder.record(REQUEST_ID, trace()), {
    status: 'sampled_out',
  });
  assert.deepEqual(sampledEvents, [`sample:${REQUEST_ID}:0.5`]);

  const offRecorder = createServingObservationRecorder(
    { mode: 'off' },
    dependencies(
      {
        append() {
          throw new Error('must not run');
        },
      },
      {
        sampler() {
          throw new Error('must not run');
        },
      },
    ),
  );
  assert.deepEqual(offRecorder.record(REQUEST_ID, trace()), {
    status: 'disabled',
  });
});

test('expected dropped question dispositions remain writable observations', () => {
  const values: unknown[] = [];
  const recorder = createServingObservationRecorder(
    { ...LOCAL_CONFIG, maxInputBytes: 32, maxTextBytes: 16 },
    dependencies(collectingSink(values)),
  );

  const result = recorder.record(
    REQUEST_ID,
    trace({ question: 'x'.repeat(33) }),
  );

  assert.deepEqual(result, { status: 'written' });
  assert.deepEqual((values[0] as ServingRetrievalObservation).query, {
    disposition: 'dropped_invalid',
    redactionVersion: 'serving-redaction/v1',
    redactionLabels: [],
  });
});

test('maps sampler and redactor exceptions to safe statuses without writing', () => {
  const values: unknown[] = [];
  const sink = collectingSink(values);
  const samplingRecorder = createServingObservationRecorder(
    LOCAL_CONFIG,
    dependencies(sink, {
      sampler() {
        throw new Error(RAW_SECRET);
      },
    }),
  );
  const samplingResult = samplingRecorder.record(REQUEST_ID, trace());
  assert.deepEqual(samplingResult, {
    status: 'sampling_failed',
    errorCode: 'sampling_internal',
  });
  assert.equal(JSON.stringify(samplingResult).includes(RAW_SECRET), false);

  const redactionRecorder = createServingObservationRecorder(
    LOCAL_CONFIG,
    dependencies(sink, {
      redactor() {
        throw new ServingRedactionError('verification_failed');
      },
    }),
  );
  const redactionResult = redactionRecorder.record(REQUEST_ID, trace());
  assert.deepEqual(redactionResult, {
    status: 'redaction_failed',
    errorCode: 'verification_failed',
  });
  assert.equal(values.length, 0);
});

test('maps clock, ID, projection, and strict decode failures to projection_failed', () => {
  const values: unknown[] = [];
  const sink = collectingSink(values);
  const cases: Partial<ServingObservationRecorderDependencies>[] = [
    {
      clock() {
        throw new Error(RAW_SECRET);
      },
    },
    {
      idFactory() {
        throw new Error(RAW_SECRET);
      },
    },
    {
      projector() {
        throw new Error(RAW_SECRET);
      },
    },
    {
      decoder() {
        throw new Error(RAW_SECRET);
      },
    },
  ];

  for (const dependencyOverrides of cases) {
    const recorder = createServingObservationRecorder(
      LOCAL_CONFIG,
      dependencies(sink, dependencyOverrides),
    );
    const result = recorder.record(REQUEST_ID, trace());

    assert.deepEqual(result, {
      status: 'projection_failed',
      errorCode: 'projection_internal',
    });
    assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
  }
  assert.equal(values.length, 0);
});

test('maps sink rejection, thrown sink errors, and missing sink to write_failed', () => {
  const rejectedRecorder = createServingObservationRecorder(
    LOCAL_CONFIG,
    dependencies({
      append() {
        return {
          ok: false,
          error: { code: 'observation_too_large' },
        };
      },
    }),
  );
  assert.deepEqual(rejectedRecorder.record(REQUEST_ID, trace()), {
    status: 'write_failed',
    errorCode: 'observation_too_large',
  });

  const thrownRecorder = createServingObservationRecorder(
    LOCAL_CONFIG,
    dependencies({
      append() {
        throw new Error(RAW_SECRET);
      },
    }),
  );
  const thrownResult = thrownRecorder.record(REQUEST_ID, trace());
  assert.deepEqual(thrownResult, {
    status: 'write_failed',
    errorCode: 'sink_internal',
  });
  assert.equal(JSON.stringify(thrownResult).includes(RAW_SECRET), false);

  const missingSinkRecorder = createServingObservationRecorder(LOCAL_CONFIG, {
    ...dependencies(collectingSink([])),
    sink: undefined,
  });
  assert.deepEqual(missingSinkRecorder.record(REQUEST_ID, trace()), {
    status: 'write_failed',
    errorCode: 'sink_unavailable',
  });
});

test('traceSink is a synchronous void adapter that never throws into the pipeline', () => {
  const recorder = createServingObservationRecorder(
    LOCAL_CONFIG,
    dependencies({
      append() {
        throw new Error(RAW_SECRET);
      },
    }),
  );
  const traceSink = recorder.traceSink(REQUEST_ID);

  assert.doesNotThrow(() => {
    const result = traceSink(trace());
    assert.equal(result, undefined);
    assert.equal((result as unknown) instanceof Promise, false);
  });
});

test('traceSink reports only the structured result and ignores reporter failures', () => {
  const recorder = createServingObservationRecorder(
    LOCAL_CONFIG,
    dependencies({
      append() {
        throw new Error(RAW_SECRET);
      },
    }),
  );
  const results: unknown[] = [];

  assert.doesNotThrow(() => {
    recorder.traceSink(REQUEST_ID, (result) => results.push(result))(trace());
  });
  assert.deepEqual(results, [
    { status: 'write_failed', errorCode: 'sink_internal' },
  ]);
  assert.equal(JSON.stringify(results).includes(RAW_SECRET), false);

  assert.doesNotThrow(() => {
    recorder.traceSink(REQUEST_ID, () => {
      throw new Error(RAW_SECRET);
    })(trace());
  });
});

test('decoder receives the projector output before the sink can report written', () => {
  const values: unknown[] = [];
  const redactedQuestion: RedactedServingQuestion = {
    disposition: 'redacted',
    text: 'safe',
    redactionVersion: 'serving-redaction/v1',
    redactionLabels: [],
  };
  const projected = observationForDependencyTest(redactedQuestion);
  const events: string[] = [];
  const recorder = createServingObservationRecorder(
    LOCAL_CONFIG,
    dependencies(collectingSink(values), {
      redactor() {
        events.push('redactor');
        return redactedQuestion;
      },
      projector() {
        events.push('projector');
        return projected;
      },
      decoder(value) {
        events.push('decoder');
        assert.equal(value, projected);
        return projected;
      },
    }),
  );

  assert.deepEqual(recorder.record(REQUEST_ID, trace()), {
    status: 'written',
  });
  assert.deepEqual(events, ['redactor', 'projector', 'decoder']);
  assert.equal(values[0], projected);
});

function observationForDependencyTest(
  question: RedactedServingQuestion,
): ServingRetrievalObservation {
  return {
    schemaVersion: 'serving-observation/v2',
    observationId: OBSERVATION_ID,
    requestId: REQUEST_ID,
    createdAt: FIXED_NOW.toISOString(),
    kind: 'retrieval',
    route: { mode: 'free', path: 'search' },
    query: question,
    ranking: { coarse: [], rerank: [], final: [] },
    latencyMs: { total: 3 },
  };
}
