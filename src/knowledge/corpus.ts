import { createHash } from 'node:crypto';
import type { Chunk, SourceType } from './chunk';
import { buildSchemaCorpus } from './schema-corpus';
import { buildPolicyCorpus } from './policy-corpus';

export type { Chunk } from './chunk';

export interface SourceManifest {
  sourceType: SourceType;
  count: number;
  hash: string;
}

export interface CorpusManifest {
  sources: SourceManifest[];
  count: number;
  hash: string;
}

export interface CorpusProvider {
  sourceType: SourceType;
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

export function hashCorpusChunks(
  chunks: readonly Pick<Chunk, 'id' | 'text'>[],
): string {
  const h = createHash('sha256');
  for (const c of [...chunks].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(c.id);
    h.update('\n');
    h.update(c.text);
    h.update('\n');
  }
  return h.digest('hex');
}

function sourceManifest(
  sourceType: SourceType,
  chunks: readonly Chunk[],
): SourceManifest {
  return {
    sourceType,
    count: chunks.length,
    hash: hashCorpusChunks(chunks),
  };
}

function createCorpusProvider(
  sourceType: SourceType,
  buildSource: () => Chunk[],
): CorpusProvider {
  let cached: Chunk[] | undefined;
  const build = (): Chunk[] => {
    cached ??= buildSource();
    return cached;
  };
  return {
    sourceType,
    build,
    manifest: () => sourceManifest(sourceType, build()),
  };
}

export const SCHEMA_CORPUS_PROVIDER = createCorpusProvider(
  'schema',
  buildSchemaCorpus,
);

export const POLICY_CORPUS_PROVIDER = createCorpusProvider(
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
  const sources = providers.map((provider) => provider.manifest());
  const chunks = providers.flatMap((provider) => provider.build());
  return {
    sources,
    count: chunks.length,
    hash: hashCorpusChunks(chunks),
  };
}

export const CORPUS = buildCorpus({ sources: DEFAULT_CORPUS_SOURCES });
