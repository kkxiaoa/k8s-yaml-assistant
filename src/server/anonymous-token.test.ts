import assert from 'node:assert/strict';
import test from 'node:test';
import {
  issueAnonymousTrialToken,
  verifyAnonymousTrialToken,
} from './anonymous-token';
import { ANONYMOUS_TRIAL_DURATION_MS } from './experience-control';

const NOW = Date.parse('2026-07-29T04:00:00.000Z');
const KEY = Buffer.alloc(32, 9);
const ID = Buffer.alloc(16, 3).toString('base64url');

test('匿名体验令牌可验证且到期、篡改或换密钥后失效', () => {
  const token = issueAnonymousTrialToken(KEY, NOW, ID);
  assert.deepEqual(verifyAnonymousTrialToken(token.value, KEY, NOW), token);
  assert.equal(
    verifyAnonymousTrialToken(
      token.value,
      KEY,
      NOW + ANONYMOUS_TRIAL_DURATION_MS,
    ),
    null,
  );
  assert.equal(
    verifyAnonymousTrialToken(
      `${token.value.slice(0, -1)}${
        token.value.endsWith('x') ? 'y' : 'x'
      }`,
      KEY,
      NOW,
    ),
    null,
  );
  assert.equal(
    verifyAnonymousTrialToken(token.value, Buffer.alloc(32, 8), NOW),
    null,
  );
});
