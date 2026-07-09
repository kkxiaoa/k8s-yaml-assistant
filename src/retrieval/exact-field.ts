import type { Chunk } from '../knowledge/corpus';

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
        chunk.resource === resource &&
        chunk.path === fieldPath,
    )
    .slice(0, k);
}
