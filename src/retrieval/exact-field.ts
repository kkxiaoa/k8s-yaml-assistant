import type { Chunk } from '../knowledge/corpus';

export function findExactFieldChunks(
  chunks: readonly Chunk[],
  resource: string | undefined,
  fieldPath: string | undefined,
  apiVersion?: string,
): Chunk[] {
  if (!resource || !fieldPath) return [];
  return chunks
    .filter(
      (chunk) =>
        chunk.targets.some(
          (target) =>
            target.kind === resource &&
            target.path === fieldPath &&
            (!apiVersion ||
              !target.apiVersion ||
              target.apiVersion === apiVersion),
        ),
    );
}
