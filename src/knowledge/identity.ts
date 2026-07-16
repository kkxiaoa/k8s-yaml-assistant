import {
  canonicalHash,
  canonicalJson,
} from '../shared/json';
import type { KnowledgeChunk, SourceType } from './chunk';

export { canonicalHash, canonicalJson } from '../shared/json';

export interface KnowledgeTarget {
  apiVersion?: string;
  kind: string;
  path?: string;
}

export interface SourceManifest {
  sourceType: SourceType;
  providerId: string;
  version?: string;
  generatedAt?: string;
  count: number;
  contentHash: string;
  manifestHash: string;
}

export interface CorpusManifest {
  providers: SourceManifest[];
  count: number;
  contentHash: string;
  manifestHash: string;
}

export interface KnowledgeProviderSnapshot {
  sourceType: SourceType;
  providerId: string;
  version?: string;
  generatedAt?: string;
  chunks: readonly KnowledgeChunk[];
}

const TARGET_KEYS = new Set(['apiVersion', 'kind', 'path']);
const ID_SEPARATOR = '::';

function assertIdentityString(
  value: unknown,
  field: keyof KnowledgeTarget,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError(`knowledge target ${field} must be a non-empty trimmed string`);
  }
}

function canonicalTarget(value: KnowledgeTarget, index: number): KnowledgeTarget {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`knowledge target[${index}] must be an object`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`knowledge target[${index}] must be a plain object`);
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !TARGET_KEYS.has(key)) {
      throw new TypeError(`knowledge target[${index}] contains unknown field ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError(`knowledge target[${index}].${key} must be an enumerable data property`);
    }
  }

  assertIdentityString(value.kind, 'kind');
  if (value.apiVersion !== undefined) {
    assertIdentityString(value.apiVersion, 'apiVersion');
  }
  if (value.path !== undefined) {
    assertIdentityString(value.path, 'path');
  }

  return {
    ...(value.apiVersion === undefined ? {} : { apiVersion: value.apiVersion }),
    kind: value.kind,
    ...(value.path === undefined ? {} : { path: value.path }),
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertManifestString(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
}

function canonicalChunk(
  chunk: KnowledgeChunk,
  sourceType: SourceType,
  index: number,
): KnowledgeChunk {
  if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) {
    throw new TypeError(`knowledge chunk[${index}] must be an object`);
  }
  assertManifestString(chunk.id, `knowledge chunk[${index}].id`);
  assertManifestString(chunk.title, `knowledge chunk[${index}].title`);
  assertManifestString(chunk.text, `knowledge chunk[${index}].text`);
  if (chunk.sourceType !== sourceType) {
    throw new TypeError(
      `knowledge chunk ${chunk.id} sourceType ${chunk.sourceType} does not match provider sourceType ${sourceType}`,
    );
  }

  return {
    id: chunk.id,
    title: chunk.title,
    text: chunk.text,
    sourceType: chunk.sourceType,
    provenance: {
      authority: chunk.provenance.authority,
      ...(chunk.provenance.sourceUri === undefined
        ? {}
        : { sourceUri: chunk.provenance.sourceUri }),
      ...(chunk.provenance.version === undefined
        ? {}
        : { version: chunk.provenance.version }),
    },
    targets: canonicalTargets(chunk.targets),
  };
}

function canonicalProviderChunks(
  provider: KnowledgeProviderSnapshot,
): KnowledgeChunk[] {
  if (!Array.isArray(provider.chunks)) {
    throw new TypeError(`provider ${provider.providerId} chunks must be an array`);
  }

  const seen = new Set<string>();
  const chunks = provider.chunks.map((chunk, index) => {
    const canonical = canonicalChunk(chunk, provider.sourceType, index);
    if (seen.has(canonical.id)) {
      throw new Error(
        `duplicate knowledge chunk ID ${canonical.id} in provider ${provider.providerId}`,
      );
    }
    seen.add(canonical.id);
    return canonical;
  });
  return chunks.sort((left, right) => compareStrings(left.id, right.id));
}

function contentHash(chunks: readonly KnowledgeChunk[]): string {
  return canonicalHash(
    chunks
      .map(({ id, text }) => ({ id, text }))
      .sort((left, right) => compareStrings(left.id, right.id)),
  );
}

function sourceManifestIdentity(manifest: SourceManifest): object {
  return {
    providerId: manifest.providerId,
    sourceType: manifest.sourceType,
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    count: manifest.count,
    contentHash: manifest.contentHash,
    manifestHash: manifest.manifestHash,
  };
}

export function buildSourceManifest(
  provider: KnowledgeProviderSnapshot,
): SourceManifest {
  assertManifestString(provider.providerId, 'providerId');
  if (provider.version !== undefined) {
    assertManifestString(provider.version, 'provider version');
  }
  if (provider.generatedAt !== undefined) {
    assertManifestString(provider.generatedAt, 'provider generatedAt');
  }

  const chunks = canonicalProviderChunks(provider);
  return {
    sourceType: provider.sourceType,
    providerId: provider.providerId,
    ...(provider.version === undefined ? {} : { version: provider.version }),
    ...(provider.generatedAt === undefined
      ? {}
      : { generatedAt: provider.generatedAt }),
    count: chunks.length,
    contentHash: contentHash(chunks),
    manifestHash: canonicalHash({
      providerId: provider.providerId,
      sourceType: provider.sourceType,
      ...(provider.version === undefined ? {} : { version: provider.version }),
      chunks,
    }),
  };
}

export function buildCorpusIdentity(
  snapshots: readonly KnowledgeProviderSnapshot[],
): CorpusManifest {
  if (!Array.isArray(snapshots)) {
    throw new TypeError('knowledge providers must be an array');
  }

  const providerIds = new Set<string>();
  const chunkOwners = new Map<string, string>();
  const canonicalProviders = snapshots.map((snapshot) => {
    if (providerIds.has(snapshot.providerId)) {
      throw new Error(`duplicate knowledge provider ID ${snapshot.providerId}`);
    }
    providerIds.add(snapshot.providerId);

    const chunks = canonicalProviderChunks(snapshot);
    for (const chunk of chunks) {
      const owner = chunkOwners.get(chunk.id);
      if (owner !== undefined) {
        throw new Error(
          `duplicate knowledge chunk ID ${chunk.id} across providers ${owner} and ${snapshot.providerId}`,
        );
      }
      chunkOwners.set(chunk.id, snapshot.providerId);
    }
    return {
      chunks,
      manifest: buildSourceManifest(snapshot),
    };
  });
  canonicalProviders.sort((left, right) =>
    compareStrings(left.manifest.providerId, right.manifest.providerId),
  );

  const providers = canonicalProviders.map(({ manifest }) => manifest);
  const chunks = canonicalProviders.flatMap((provider) => provider.chunks);
  return {
    providers,
    count: chunks.length,
    contentHash: contentHash(chunks),
    manifestHash: canonicalHash({
      providers: providers.map(sourceManifestIdentity),
    }),
  };
}

function compareTargets(left: KnowledgeTarget, right: KnowledgeTarget): number {
  return (
    compareStrings(left.apiVersion ?? '', right.apiVersion ?? '') ||
    compareStrings(left.kind, right.kind) ||
    compareStrings(left.path ?? '', right.path ?? '')
  );
}

export function canonicalTargets(
  targets: readonly KnowledgeTarget[],
): KnowledgeTarget[] {
  if (!Array.isArray(targets)) {
    throw new TypeError('knowledge targets must be an array');
  }

  const unique = new Map<string, KnowledgeTarget>();
  targets.forEach((target, index) => {
    const canonical = canonicalTarget(target, index);
    unique.set(canonicalJson(canonical), canonical);
  });
  return [...unique.values()].sort(compareTargets);
}

function assertIdComponent(value: string, field: keyof KnowledgeTarget): void {
  if (value.includes(ID_SEPARATOR)) {
    throw new TypeError(`knowledge target ${field} cannot contain ${ID_SEPARATOR}`);
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
