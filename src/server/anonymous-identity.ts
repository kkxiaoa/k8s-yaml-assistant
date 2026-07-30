import { cookies } from 'next/headers';
import { APPLICATION_BASE_PATH } from '../shared/application-path.mjs';
import {
  issueAnonymousTrialToken,
  verifyAnonymousTrialToken,
} from './anonymous-token';
import { ANONYMOUS_TRIAL_DURATION_MS } from './experience-control';
import { decodeBase64Key } from './secret-key';

const COOKIE_NAME = 'kya-anonymous-trial';

export interface AnonymousIdentity {
  id: string;
  expiresAt: number;
}

export async function getAnonymousIdentity(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now = Date.now(),
): Promise<AnonymousIdentity> {
  const key = decodeBase64Key(environment.CONTROL_SUBJECT_HMAC_KEY);
  const cookieStore = await cookies();
  const existing = cookieStore.get(COOKIE_NAME)?.value;
  const verified =
    existing === undefined
      ? null
      : verifyAnonymousTrialToken(existing, key, now);
  const token = verified ?? issueAnonymousTrialToken(key, now);
  if (verified === null) {
    cookieStore.set(COOKIE_NAME, token.value, {
      httpOnly: true,
      secure: environment.NODE_ENV === 'production',
      sameSite: 'lax',
      path: APPLICATION_BASE_PATH,
      maxAge: ANONYMOUS_TRIAL_DURATION_MS / 1_000,
    });
  }
  return { id: token.id, expiresAt: token.expiresAt };
}
