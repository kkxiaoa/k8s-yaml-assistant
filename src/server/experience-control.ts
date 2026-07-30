export type ExperienceMode = 'normal' | 'interview' | 'sleep';
export type ModelRoute = 'ask' | 'generate' | 'fix';

export type ExperienceQuota =
  | {
      kind: 'anonymous_trial';
      limit: number;
      remaining: number;
      expiresAt: string;
    }
  | {
      kind: 'daily';
      limit: number;
      remaining: number;
      resetsAt: string;
    }
  | { kind: 'unlimited' };

export type ModelUnavailableReason =
  | 'model_access_disabled'
  | 'control_state_unavailable'
  | 'sleep_mode'
  | 'global_budget_exhausted'
  | 'runtime_config_invalid'
  | 'quota_exhausted';

export interface ExperienceResponse {
  authenticated: boolean;
  user: null | { login: string; admin: boolean };
  mode: ExperienceMode;
  quota: ExperienceQuota | null;
  model: Record<
    ModelRoute,
    {
      enabled: boolean;
      reason: ModelUnavailableReason | null;
    }
  >;
}

export interface AdminExperienceResponse {
  mode: ExperienceMode;
  interviewExpiresAt: string | null;
}

export type AdminExperienceRequest =
  | { mode: 'normal' }
  | { mode: 'sleep' }
  | { mode: 'interview'; durationHours: 1 | 4 | 8 };

export const MODEL_ROUTE_CREDITS: Readonly<Record<ModelRoute, number>> = {
  ask: 1,
  generate: 3,
  fix: 3,
};

export function resolveModelRouteAvailability(
  sharedReason: ModelUnavailableReason | null,
  remainingCredits: number | null,
  runtime: { deepseek: boolean; retrieval: boolean },
): ExperienceResponse['model'] {
  const status = (
    route: ModelRoute,
    runtimeAvailable: boolean,
  ): ExperienceResponse['model'][ModelRoute] => {
    const reason =
      sharedReason ??
      (runtimeAvailable ? null : 'runtime_config_invalid') ??
      (remainingCredits !== null &&
      remainingCredits < MODEL_ROUTE_CREDITS[route]
        ? 'quota_exhausted'
        : null);
    return { enabled: reason === null, reason };
  };
  return {
    ask: status('ask', runtime.deepseek && runtime.retrieval),
    generate: status('generate', runtime.deepseek),
    fix: status('fix', runtime.deepseek),
  };
}

export const MODEL_ROUTE_RESERVE_MICROUSD: Readonly<
  Record<ModelRoute, number>
> = {
  ask: 100_000,
  generate: 250_000,
  fix: 250_000,
};

export const MODEL_ROUTE_LEASE_MS: Readonly<Record<ModelRoute, number>> = {
  ask: 3 * 60_000,
  generate: 10 * 60_000,
  fix: 10 * 60_000,
};

export const NORMAL_DAILY_CREDITS = 10;
export const INTERVIEW_DAILY_CREDITS = 50;
export const ANONYMOUS_TRIAL_CREDITS = 7;
export const ANONYMOUS_TRIAL_DURATION_MS = 30 * 24 * 60 * 60_000;
export const GLOBAL_DAILY_BUDGET_MICROUSD = 1_000_000;
export const GLOBAL_MONTHLY_BUDGET_MICROUSD = 20_000_000;
