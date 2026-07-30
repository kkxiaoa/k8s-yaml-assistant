const DEEPSEEK_INPUT_MICROUSD_PER_MILLION = 140_000;
const DEEPSEEK_OUTPUT_MICROUSD_PER_MILLION = 280_000;
const VOYAGE_EMBEDDING_MICROUSD_PER_MILLION = 60_000;
const VOYAGE_RERANK_MICROUSD_PER_MILLION = 50_000;
const ACCOUNTED_DEEPSEEK_MODEL = 'deepseek-v4-flash';
const ACCOUNTED_VOYAGE_EMBEDDING_MODEL = 'voyage-3';
const ACCOUNTED_VOYAGE_RERANK_MODEL = 'rerank-2.5';

type ProviderKind = 'deepseek' | 'voyage';

export interface ProviderRequestObserver {
  requestStarted(provider: ProviderKind): void;
  deepSeekUsage(
    model: unknown,
    inputTokens: unknown,
    outputTokens: unknown,
    cacheCreationInputTokens?: unknown,
    cacheReadInputTokens?: unknown,
  ): void;
  voyageEmbeddingUsage(model: unknown, totalTokens: unknown): void;
  voyageRerankUsage(model: unknown, totalTokens: unknown): void;
}

function tokenCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function optionalTokenCount(value: unknown): number | null {
  return value === undefined || value === null ? 0 : tokenCount(value);
}

function price(tokens: number, microUsdPerMillion: number): number {
  if (tokens === 0) return 0;
  return Math.ceil((tokens * microUsdPerMillion) / 1_000_000);
}

export class ModelUsageCollector implements ProviderRequestObserver {
  private started = false;
  private valid = true;
  private deepSeekInput = 0;
  private deepSeekOutput = 0;
  private voyageEmbedding = 0;
  private voyageRerank = 0;

  requestStarted(_provider: ProviderKind): void {
    this.started = true;
  }

  deepSeekUsage(
    model: unknown,
    inputTokens: unknown,
    outputTokens: unknown,
    cacheCreationInputTokens?: unknown,
    cacheReadInputTokens?: unknown,
  ): void {
    const input = tokenCount(inputTokens);
    const output = tokenCount(outputTokens);
    const cacheCreation = optionalTokenCount(cacheCreationInputTokens);
    const cacheRead = optionalTokenCount(cacheReadInputTokens);
    if (
      model !== ACCOUNTED_DEEPSEEK_MODEL ||
      input === null ||
      output === null ||
      cacheCreation === null ||
      cacheRead === null
    ) {
      this.valid = false;
      return;
    }
    this.deepSeekInput += input + cacheCreation + cacheRead;
    this.deepSeekOutput += output;
  }

  voyageEmbeddingUsage(model: unknown, totalTokens: unknown): void {
    const tokens = tokenCount(totalTokens);
    if (model !== ACCOUNTED_VOYAGE_EMBEDDING_MODEL || tokens === null) {
      this.valid = false;
      return;
    }
    this.voyageEmbedding += tokens;
  }

  voyageRerankUsage(model: unknown, totalTokens: unknown): void {
    const tokens = tokenCount(totalTokens);
    if (model !== ACCOUNTED_VOYAGE_RERANK_MODEL || tokens === null) {
      this.valid = false;
      return;
    }
    this.voyageRerank += tokens;
  }

  hasStartedRequest(): boolean {
    return this.started;
  }

  settledCostMicrousd(): number | null {
    if (!this.started || !this.valid) return null;
    return (
      price(
        this.deepSeekInput,
        DEEPSEEK_INPUT_MICROUSD_PER_MILLION,
      ) +
      price(
        this.deepSeekOutput,
        DEEPSEEK_OUTPUT_MICROUSD_PER_MILLION,
      ) +
      price(
        this.voyageEmbedding,
        VOYAGE_EMBEDDING_MICROUSD_PER_MILLION,
      ) +
      price(this.voyageRerank, VOYAGE_RERANK_MICROUSD_PER_MILLION)
    );
  }
}
