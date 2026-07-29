export const DEEPSEEK_CLIENT_POLICY = {
  timeout: 60_000,
  maxRetries: 0,
} as const;

export const VOYAGE_REQUEST_TIMEOUT_MS = 30_000;

const MODEL_REQUEST_MAX_BYTES = 256 * 1024;

export class ModelInputBudgetError extends Error {
  constructor() {
    super('model input exceeds the request byte budget');
    this.name = 'ModelInputBudgetError';
  }
}

export function assertModelInputByteBudget(request: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  if (bytes > MODEL_REQUEST_MAX_BYTES) {
    throw new ModelInputBudgetError();
  }
}

export function voyageRequestSignal(): AbortSignal {
  return AbortSignal.timeout(VOYAGE_REQUEST_TIMEOUT_MS);
}
