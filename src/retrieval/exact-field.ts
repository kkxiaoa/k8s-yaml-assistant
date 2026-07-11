import type { Chunk } from '../knowledge/corpus';
import { chunkPaths, chunkResources } from '../knowledge/chunk';

export function findExactFieldChunks(
  chunks: readonly Chunk[],
  resource: string | undefined,
  fieldPath: string | undefined,
  k: number,
): Chunk[] {
  if (!resource || !fieldPath) return [];
  return chunks
    .filter(
      (chunk) =>
        chunkResources(chunk).includes(resource) &&
        chunkPaths(chunk).includes(fieldPath),
    )
    .slice(0, k);
}
