import assert from 'node:assert/strict';
import test from 'node:test';
import { requestIdSamplingBucket, shouldSample } from './sampling';

const VECTORS = [
  {
    requestId: '00000000-0000-4000-8000-000000000000',
    first64: 0xdb8055e0e0307d5an,
    below: 0.857,
    above: 0.858,
  },
  {
    requestId: '11111111-1111-4111-8111-111111111111',
    first64: 0xbd7662a5eeb41614n,
    below: 0.74,
    above: 0.741,
  },
  {
    requestId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
    first64: 0x66c6a0d124855ac0n,
    below: 0.401,
    above: 0.402,
  },
] as const;

test('sample-rate boundaries select none or all', () => {
  for (const { requestId } of VECTORS) {
    assert.equal(shouldSample(requestId, 0), false);
    assert.equal(shouldSample(requestId, 1), true);
  }
});

test('same request ID produces a stable decision', () => {
  const requestId = VECTORS[1].requestId;
  const decisions = Array.from({ length: 100 }, () =>
    shouldSample(requestId, 0.75),
  );

  assert.deepEqual(new Set(decisions), new Set([true]));
});

test('matches manually calculated SHA-256 first-64-bit vectors', () => {
  for (const { requestId, first64, below, above } of VECTORS) {
    assert.equal(requestIdSamplingBucket(requestId), first64);
    assert.equal(shouldSample(requestId, below), false);
    assert.equal(shouldSample(requestId, above), true);
  }
});

test('rejects invalid sample rates before hashing', () => {
  for (const rate of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01]) {
    assert.throws(
      () => shouldSample('TestInputMustNotAppearInErrors', rate),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, 'invalid serving observation sample rate');
        assert.equal(
          error.message.includes('TestInputMustNotAppearInErrors'),
          false,
        );
        return true;
      },
    );
  }
});
