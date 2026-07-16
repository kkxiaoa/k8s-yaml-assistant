import { z } from 'zod';
import {
  canonicalTargets,
  type KnowledgeTarget,
} from './identity';

export type { KnowledgeTarget } from './identity';

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

export const KnowledgeTargetSchema = z.unknown().transform(
  (value, context): KnowledgeTarget => {
    try {
      const [target] = canonicalTargets([value as KnowledgeTarget]);
      if (!target) throw new TypeError('knowledge target is missing');
      return target;
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  },
);

export const KnowledgeChunkSchema = z
  .strictObject({
    id: NonEmptyTrimmedStringSchema,
    title: NonEmptyTrimmedStringSchema,
    text: z.string().min(1),
    sourceType: SourceTypeSchema,
    provenance: ProvenanceSchema,
    targets: z.array(KnowledgeTargetSchema),
  })
  .transform((chunk) => ({
    ...chunk,
    targets: canonicalTargets(chunk.targets),
  }));

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
