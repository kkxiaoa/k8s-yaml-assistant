import { z } from 'zod';
import { canonicalJson } from '../shared/json';

const NonEmptyTrimmedStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, 'must be trimmed');

export const SourceTypeSchema = z.enum([
  'schema',
  'policy',
  'docs',
  'example',
]);

export const SourceAuthoritySchema = z.enum([
  'kubernetes_official',
  'cluster_api',
  'extension_provider',
  'organization',
  'curated',
]);

export const ProvenanceSchema = z.strictObject({
  authority: SourceAuthoritySchema,
  sourceUri: NonEmptyTrimmedStringSchema.optional(),
  version: NonEmptyTrimmedStringSchema.optional(),
});

export const KnowledgeTargetSchema = z.strictObject({
  apiVersion: NonEmptyTrimmedStringSchema.optional(),
  kind: NonEmptyTrimmedStringSchema,
  path: NonEmptyTrimmedStringSchema.optional(),
});

export type KnowledgeTarget = z.infer<typeof KnowledgeTargetSchema>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTargets(left: KnowledgeTarget, right: KnowledgeTarget): number {
  return (
    compareStrings(left.apiVersion ?? '', right.apiVersion ?? '') ||
    compareStrings(left.kind, right.kind) ||
    compareStrings(left.path ?? '', right.path ?? '')
  );
}

function canonicalDecodedTargets(
  targets: readonly KnowledgeTarget[],
): KnowledgeTarget[] {
  const unique = new Map<string, KnowledgeTarget>();
  for (const target of targets) {
    unique.set(canonicalJson(target), target);
  }
  return [...unique.values()].sort(compareTargets);
}

export function canonicalTargets(
  targets: readonly unknown[],
): KnowledgeTarget[] {
  return canonicalDecodedTargets(z.array(KnowledgeTargetSchema).parse(targets));
}

export const KnowledgeChunkSchema = z.strictObject({
  id: NonEmptyTrimmedStringSchema,
  title: NonEmptyTrimmedStringSchema,
  text: z.string().min(1),
  sourceType: SourceTypeSchema,
  provenance: ProvenanceSchema,
  targets: z.array(KnowledgeTargetSchema).transform(canonicalDecodedTargets),
});

export type SourceType = z.infer<typeof SourceTypeSchema>;
export type SourceAuthority = z.infer<typeof SourceAuthoritySchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;
export type Chunk = KnowledgeChunk;

export type ChunkLocator = Pick<KnowledgeChunk, 'targets'>;

export function decodeKnowledgeChunk(value: unknown): KnowledgeChunk {
  return KnowledgeChunkSchema.parse(value);
}

function unique(values: Array<string | undefined>): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== undefined)),
  ];
}

export function chunkResources(chunk: ChunkLocator): string[] {
  return unique(chunk.targets.map((target) => target.kind));
}

export function chunkPaths(chunk: ChunkLocator): string[] {
  return unique(chunk.targets.map((target) => target.path));
}

export function primaryResource(chunk: ChunkLocator): string | undefined {
  return chunk.targets[0]?.kind;
}

export function primaryPath(chunk: ChunkLocator): string | undefined {
  return chunk.targets[0]?.path;
}
