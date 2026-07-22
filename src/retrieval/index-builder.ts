import type { KnowledgeChunk } from '../knowledge/chunk';
import { embed } from './embeddings';

export interface IndexBuildChunk extends KnowledgeChunk {
  embedding: number[];
}

export type DocumentEmbeddingSupplier = (
  texts: string[],
  model: string,
) => Promise<number[][]>;

const voyageDocumentEmbeddings: DocumentEmbeddingSupplier = (texts, model) =>
  embed(texts, 'document', model);

export async function buildIndexInput(
  chunks: readonly KnowledgeChunk[],
  embeddingModel: string,
  supplyEmbeddings: DocumentEmbeddingSupplier = voyageDocumentEmbeddings,
): Promise<IndexBuildChunk[]> {
  const embeddings = await supplyEmbeddings(
    chunks.map((chunk) => chunk.text),
    embeddingModel,
  );
  if (embeddings.length !== chunks.length) {
    throw new Error(
      `document embedding count ${embeddings.length} does not match chunk count ${chunks.length}`,
    );
  }
  return chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings[index]!,
  }));
}
