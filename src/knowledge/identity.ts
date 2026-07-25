import { z } from 'zod';
import { canonicalHash } from '../shared/json';
import {
  canonicalTargets,
  KnowledgeChunkSchema,
  SourceTypeSchema,
  type KnowledgeChunk,
  type KnowledgeTarget,
  type SourceType,
} from './chunk';

export { canonicalHash, canonicalJson } from '../shared/json';
export { canonicalTargets, type KnowledgeTarget } from './chunk';

export const KNOWLEDGE_IDENTITY_VERSION = 2 as const;

export interface SourceManifest {
  providerId: string;
  sourceType: SourceType;
  version?: string;
  generatedAt?: string;
  count: number;
  manifestHash: string;
}

export interface CorpusManifest {
  identityVersion: typeof KNOWLEDGE_IDENTITY_VERSION;
  providers: SourceManifest[];
  count: number;
  manifestHash: string;
}

export interface KnowledgeProviderSnapshot {
  sourceType: SourceType;
  providerId: string;
  version?: string;
  generatedAt?: string;
  chunks: readonly KnowledgeChunk[];
}

const ID_SEPARATOR = '::';
const NonEmptyTrimmedStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, 'must be trimmed');
const KnowledgeProviderSnapshotSchema = z.strictObject({
  providerId: NonEmptyTrimmedStringSchema,
  sourceType: SourceTypeSchema,
  version: NonEmptyTrimmedStringSchema.optional(),
  generatedAt: z.iso.datetime({ offset: true }).optional(),
  chunks: z.array(KnowledgeChunkSchema),
});

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalizeProviderChunks(
  provider: z.infer<typeof KnowledgeProviderSnapshotSchema>,
): KnowledgeChunk[] {
  const seen = new Set<string>();
  for (const chunk of provider.chunks) {
    if (chunk.sourceType !== provider.sourceType) {
      throw new TypeError(
        `knowledge chunk ${chunk.id} sourceType ${chunk.sourceType} does not match provider sourceType ${provider.sourceType}`,
      );
    }
    if (seen.has(chunk.id)) {
      throw new Error(
        `duplicate knowledge chunk ID ${chunk.id} in provider ${provider.providerId}`,
      );
    }
    seen.add(chunk.id);
  }
  return provider.chunks.toSorted((left, right) =>
    compareStrings(left.id, right.id),
  );
}

function createSourceManifest(
  provider: z.infer<typeof KnowledgeProviderSnapshotSchema>,
  chunks: readonly KnowledgeChunk[],
): SourceManifest {
  return {
    providerId: provider.providerId,
    sourceType: provider.sourceType,
    ...(provider.version === undefined ? {} : { version: provider.version }),
    ...(provider.generatedAt === undefined
      ? {}
      : { generatedAt: provider.generatedAt }),
    count: chunks.length,
    manifestHash: canonicalHash({
      providerId: provider.providerId,
      sourceType: provider.sourceType,
      ...(provider.version === undefined ? {} : { version: provider.version }),
      chunks,
    }),
  };
}

export function buildSourceManifest(
  provider: KnowledgeProviderSnapshot,
): SourceManifest {
  const decoded = KnowledgeProviderSnapshotSchema.parse(provider);
  return createSourceManifest(
    decoded,
    canonicalizeProviderChunks(decoded),
  );
}

export function buildCorpusIdentity(
  snapshots: readonly KnowledgeProviderSnapshot[],
): CorpusManifest {
  const decodedSnapshots = z
    .array(KnowledgeProviderSnapshotSchema)
    .parse(snapshots);

  const providerIds = new Set<string>();
  const chunkOwners = new Map<string, string>();
  const canonicalProviders = decodedSnapshots.map((snapshot) => {
    if (providerIds.has(snapshot.providerId)) {
      throw new Error(`duplicate knowledge provider ID ${snapshot.providerId}`);
    }
    providerIds.add(snapshot.providerId);

    const chunks = canonicalizeProviderChunks(snapshot);
    for (const chunk of chunks) {
      const owner = chunkOwners.get(chunk.id);
      if (owner !== undefined) {
        throw new Error(
          `duplicate knowledge chunk ID ${chunk.id} across providers ${owner} and ${snapshot.providerId}`,
        );
      }
      chunkOwners.set(chunk.id, snapshot.providerId);
    }
    return createSourceManifest(snapshot, chunks);
  });
  canonicalProviders.sort((left, right) =>
    compareStrings(left.providerId, right.providerId),
  );

  const providers = canonicalProviders;
  return {
    identityVersion: KNOWLEDGE_IDENTITY_VERSION,
    providers,
    count: providers.reduce((count, provider) => count + provider.count, 0),
    manifestHash: canonicalHash(
      providers.map(({ manifestHash }) => manifestHash),
    ),
  };
}

function assertIdComponent(value: string, field: keyof KnowledgeTarget): void {
  if (value.includes(ID_SEPARATOR)) {
    throw new TypeError(
      `knowledge target ${field} cannot contain ${ID_SEPARATOR}`,
    );
  }
}

export function schemaChunkId(target: KnowledgeTarget): string {
  const [canonical] = canonicalTargets([target]);
  if (!canonical?.apiVersion) {
    throw new TypeError('schema chunk target requires apiVersion');
  }
  if (!canonical.path) {
    throw new TypeError('schema chunk target requires path');
  }

  assertIdComponent(canonical.apiVersion, 'apiVersion');
  assertIdComponent(canonical.kind, 'kind');
  assertIdComponent(canonical.path, 'path');
  return `schema::${canonical.apiVersion}::${canonical.kind}::${canonical.path}`;
}
