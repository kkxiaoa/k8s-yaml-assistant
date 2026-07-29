import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ANONYMOUS_TRIAL_DURATION_MS } from './experience-control';

const TOKEN_VERSION = 'v1';
const TOKEN_ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

export interface AnonymousTrialToken {
  id: string;
  expiresAt: number;
  value: string;
}

function signature(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
}

export function issueAnonymousTrialToken(
  key: Buffer,
  now = Date.now(),
  id = randomBytes(16).toString('base64url'),
): AnonymousTrialToken {
  if (
    key.length !== 32 ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !TOKEN_ID.test(id)
  ) {
    throw new Error('anonymous trial token input invalid');
  }
  const payload = `${TOKEN_VERSION}.${now}.${id}`;
  return {
    id,
    expiresAt: now + ANONYMOUS_TRIAL_DURATION_MS,
    value: `${payload}.${signature(payload, key)}`,
  };
}

export function verifyAnonymousTrialToken(
  value: string,
  key: Buffer,
  now = Date.now(),
): AnonymousTrialToken | null {
  if (key.length !== 32 || !Number.isSafeInteger(now) || now <= 0) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [version, issuedAtText, id, receivedSignature] = parts;
  if (
    version !== TOKEN_VERSION ||
    issuedAtText === undefined ||
    id === undefined ||
    receivedSignature === undefined ||
    !/^[1-9][0-9]{0,15}$/.test(issuedAtText) ||
    !TOKEN_ID.test(id) ||
    !TOKEN_SIGNATURE.test(receivedSignature)
  ) {
    return null;
  }
  const issuedAt = Number(issuedAtText);
  const expiresAt = issuedAt + ANONYMOUS_TRIAL_DURATION_MS;
  if (
    !Number.isSafeInteger(issuedAt) ||
    issuedAt > now ||
    expiresAt <= now
  ) {
    return null;
  }
  const payload = `${version}.${issuedAtText}.${id}`;
  const expected = Buffer.from(signature(payload, key), 'ascii');
  const received = Buffer.from(receivedSignature, 'ascii');
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    return null;
  }
  return { id, expiresAt, value };
}
