import type { Chunk, SourceType } from './chunk';
import { buildSchemaCorpus } from './schema-corpus';
import { buildPolicyCorpus } from './policy-corpus';
import {
  buildCorpusIdentity,
  buildSourceManifest,
  type CorpusManifest,
  type SourceManifest,
} from './identity';

export type { Chunk } from './chunk';
export type { CorpusManifest, SourceManifest } from './identity';

export interface CorpusProvider {
  providerId: string;
  sourceType: SourceType;
  version?: string;
  generatedAt?: string;
  build(): Chunk[];
  manifest(): SourceManifest;
}

export interface BuildCorpusOptions {
  sources?: readonly SourceType[];
}

export const DEFAULT_CORPUS_SOURCES = [
  'schema',
  'policy',
] as const satisfies readonly SourceType[];

function createCorpusProvider(
  providerId: string,
  sourceType: SourceType,
  buildSource: () => Chunk[],
): CorpusProvider {
  let cached: Chunk[] | undefined;
  let cachedManifest: SourceManifest | undefined;
  const build = (): Chunk[] => {
    cached ??= buildSource();
    return cached;
  };
  return {
    providerId,
    sourceType,
    build,
    manifest: () =>
      (cachedManifest ??= buildSourceManifest({
        providerId,
        sourceType,
        chunks: build(),
      })),
  };
}

export const SCHEMA_CORPUS_PROVIDER = createCorpusProvider(
  'schema.curated-openapi',
  'schema',
  buildSchemaCorpus,
);

export const POLICY_CORPUS_PROVIDER = createCorpusProvider(
  'policy.organization',
  'policy',
  buildPolicyCorpus,
);

const CORPUS_PROVIDERS = new Map<SourceType, CorpusProvider>(
  [SCHEMA_CORPUS_PROVIDER, POLICY_CORPUS_PROVIDER].map((provider) => [
    provider.sourceType,
    provider,
  ]),
);

export function getCorpusProviders(
  sources: readonly SourceType[] = DEFAULT_CORPUS_SOURCES,
): CorpusProvider[] {
  return sources.map((sourceType) => {
    const provider = CORPUS_PROVIDERS.get(sourceType);
    if (!provider) throw new Error(`未注册 corpus provider: ${sourceType}`);
    return provider;
  });
}

export function buildCorpus(options: BuildCorpusOptions = {}): Chunk[] {
  return getCorpusProviders(options.sources).flatMap((provider) =>
    provider.build(),
  );
}

export function buildCorpusManifest(
  options: BuildCorpusOptions = {},
): CorpusManifest {
  const providers = getCorpusProviders(options.sources);
  return buildCorpusIdentity(
    providers.map((provider) => ({
      providerId: provider.providerId,
      sourceType: provider.sourceType,
      ...(provider.version === undefined ? {} : { version: provider.version }),
      ...(provider.generatedAt === undefined
        ? {}
        : { generatedAt: provider.generatedAt }),
      chunks: provider.build(),
    })),
  );
}

export const CORPUS = buildCorpus({ sources: DEFAULT_CORPUS_SOURCES });
