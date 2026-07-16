import type {
  KnowledgeChunk,
  Provenance,
} from '../knowledge/chunk';
import {
  CONFLICT_RULES,
  sourceAuthorityLabel,
  sourceLabel,
} from './source-policy';

export type SourceInput = KnowledgeChunk;

export interface Source
  extends Pick<
    KnowledgeChunk,
    'id' | 'title' | 'sourceType' | 'provenance' | 'targets'
  > {
  n: number;
}

export { CONFLICT_RULES };

export interface ContextSelectionOptions {
  k: number;
  taskType?: 'ask' | 'faith' | 'generation' | 'fix' | string;
}

export function selectContextHits<T>(
  hits: readonly T[],
  options: ContextSelectionOptions,
): T[] {
  return hits.slice(0, options.k);
}

export function extractSourceUri(text: string): string | undefined {
  const match = text.match(/More info:\s*(https?:\/\/[^\s。,，]+)/);
  return match?.[1]?.replace(/[.,]+$/, '');
}

function sourceProvenance(chunk: SourceInput): Provenance {
  const sourceUri = chunk.provenance.sourceUri ?? extractSourceUri(chunk.text);
  return {
    ...chunk.provenance,
    ...(sourceUri === undefined ? {} : { sourceUri }),
  };
}

export function formatSources(chunks: SourceInput[]): {
  context: string;
  sources: Source[];
} {
  const sources = chunks.map((chunk, index): Source => ({
    n: index + 1,
    id: chunk.id,
    title: chunk.title,
    sourceType: chunk.sourceType,
    provenance: sourceProvenance(chunk),
    targets: chunk.targets,
  }));
  const context = chunks
    .map(
      (chunk, index) =>
        `[S${index + 1}][${chunk.sourceType}][${sourceLabel(chunk.sourceType)}][${sourceAuthorityLabel(chunk.provenance.authority)}] ${chunk.title}\n${chunk.text}`,
    )
    .join('\n\n');
  return { context, sources };
}
