import type { Chunk, SourceType } from './chunk';
import { loadKubernetesDocsProviderSnapshot } from './docs-corpus';
import { loadKubernetesExamplesProviderSnapshot } from './example-corpus';
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
  'docs',
  'example',
] as const satisfies readonly SourceType[];

function createCorpusProvider(
  providerId: string,
  sourceType: SourceType,
  buildSource: () => Chunk[],
  metadata: Pick<CorpusProvider, 'version' | 'generatedAt'> = {},
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
    ...metadata,
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

const KUBERNETES_DOCS_SNAPSHOT = loadKubernetesDocsProviderSnapshot();

const KUBERNETES_DOCS_CORPUS_PROVIDER = createCorpusProvider(
  KUBERNETES_DOCS_SNAPSHOT.providerId,
  'docs',
  () => KUBERNETES_DOCS_SNAPSHOT.chunks,
  {
    version: KUBERNETES_DOCS_SNAPSHOT.version,
    generatedAt: KUBERNETES_DOCS_SNAPSHOT.generatedAt,
  },
);

const KUBERNETES_EXAMPLES_SNAPSHOT =
  loadKubernetesExamplesProviderSnapshot();

const KUBERNETES_EXAMPLES_CORPUS_PROVIDER = createCorpusProvider(
  KUBERNETES_EXAMPLES_SNAPSHOT.providerId,
  'example',
  () => KUBERNETES_EXAMPLES_SNAPSHOT.chunks,
  {
    version: KUBERNETES_EXAMPLES_SNAPSHOT.version,
    generatedAt: KUBERNETES_EXAMPLES_SNAPSHOT.generatedAt,
  },
);

const CORPUS_PROVIDERS = new Map<SourceType, CorpusProvider>(
  [
    SCHEMA_CORPUS_PROVIDER,
    POLICY_CORPUS_PROVIDER,
    KUBERNETES_DOCS_CORPUS_PROVIDER,
    KUBERNETES_EXAMPLES_CORPUS_PROVIDER,
  ].map((provider) => [provider.sourceType, provider]),
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
