// 持久化全量 corpus index。index 只保存向量与当时的 canonical chunks；
// 当前 corpus identity、embedding model 或文件结构任一不匹配时都视为 cache miss。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { decodeKnowledgeChunk, type KnowledgeChunk } from '../knowledge/chunk';
import type { CorpusManifest } from '../knowledge/identity';
import { canonicalHash, canonicalJson } from '../shared/json';
import type { IndexedChunk } from './retrieve';

export const INDEX_FORMAT_VERSION = 2 as const;

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'must be a SHA-256 hex digest');
const NonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, {
    message: 'must be trimmed',
  });

export const IndexManifestSchema = z.strictObject({
  formatVersion: z.literal(INDEX_FORMAT_VERSION),
  embeddingModel: NonEmptyStringSchema,
  dimension: z.int().positive(),
  count: z.int().positive(),
  corpusContentHash: Sha256Schema,
  corpusManifestHash: Sha256Schema,
  indexHash: Sha256Schema,
  createdAt: z.iso.datetime({ offset: true }),
});

export type IndexManifest = z.infer<typeof IndexManifestSchema>;

export interface IndexExpectation {
  corpusManifest: CorpusManifest;
  corpusChunks: readonly KnowledgeChunk[];
  embeddingModel: string;
}

export type IndexMissReason =
  // 文件层：
  | 'missing_files'
  | 'incomplete_files'
  | 'read_error'
  // Manifest 层：
  | 'format_mismatch'
  | 'invalid_manifest'
  // Identity 层：
  | 'corpus_count_mismatch'
  | 'corpus_content_mismatch'
  | 'corpus_manifest_mismatch'
  | 'embedding_model_mismatch'
  | 'index_hash_mismatch'
  // 持久化内容层：
  | 'chunk_count_mismatch'
  | 'invalid_chunk'
  | 'duplicate_chunk_id'
  | 'embedding_dimension_mismatch'
  | 'invalid_embedding';

export type IndexReadResult =
  | {
      status: 'hit';
      manifest: IndexManifest;
      chunks: IndexedChunk[];
    }
  | {
      status: 'miss';
      reason: IndexMissReason;
      detail?: string;
    };

interface IndexPaths {
  manifest: string;
  chunks: string;
  embeddings: string;
}

/** 索引目录:env INDEX_DIR 优先,默认 data/index。A/B 使用隔离目录。 */
export function resolveIndexDir(): string {
  return process.env.INDEX_DIR ?? join(process.cwd(), 'data', 'index');
}

export const INDEX_DIR = resolveIndexDir();

function indexPaths(dir: string): IndexPaths {
  return {
    manifest: join(dir, 'manifest.json'),
    chunks: join(dir, 'chunks.jsonl'),
    embeddings: join(dir, 'embeddings.f32'),
  };
}

function miss(reason: IndexMissReason, detail?: string): IndexReadResult {
  return {
    status: 'miss',
    reason,
    ...(detail === undefined ? {} : { detail }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertEmbeddingModel(value: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError('embeddingModel must be a non-empty trimmed string');
  }
}

export function decodeIndexManifest(value: unknown): IndexManifest {
  return IndexManifestSchema.parse(value);
}

export function computeIndexHash(
  corpusManifest: Pick<CorpusManifest, 'contentHash' | 'manifestHash'>,
  embeddingModel: string,
): string {
  assertEmbeddingModel(embeddingModel);
  return canonicalHash({
    formatVersion: INDEX_FORMAT_VERSION,
    embeddingModel,
    corpusContentHash: corpusManifest.contentHash,
    corpusManifestHash: corpusManifest.manifestHash,
  });
}

function canonicalChunk(chunk: IndexedChunk, index: number): KnowledgeChunk {
  try {
    return decodeKnowledgeChunk({
      id: chunk.id,
      title: chunk.title,
      text: chunk.text,
      sourceType: chunk.sourceType,
      provenance: chunk.provenance,
      targets: chunk.targets,
    });
  } catch (error) {
    throw new TypeError(
      `writeIndex: invalid canonical chunk at index ${index}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function canonicalExpectedChunks(
  expectation: IndexExpectation,
): Map<string, KnowledgeChunk> {
  if (expectation.corpusChunks.length !== expectation.corpusManifest.count) {
    throw new TypeError(
      `corpusChunks count ${expectation.corpusChunks.length} does not match corpus manifest count ${expectation.corpusManifest.count}`,
    );
  }

  const chunks = new Map<string, KnowledgeChunk>();
  expectation.corpusChunks.forEach((value, index) => {
    let chunk: KnowledgeChunk;
    try {
      chunk = decodeKnowledgeChunk(value);
    } catch (error) {
      throw new TypeError(
        `invalid expected corpus chunk at index ${index}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (chunks.has(chunk.id)) {
      throw new TypeError(`duplicate expected corpus chunk ID ${chunk.id}`);
    }
    chunks.set(chunk.id, chunk);
  });
  return chunks;
}

function chunkIdentityMismatch(
  chunks: readonly KnowledgeChunk[],
  expected: ReadonlyMap<string, KnowledgeChunk>,
): 'corpus_content_mismatch' | 'corpus_manifest_mismatch' | null {
  for (const chunk of chunks) {
    const current = expected.get(chunk.id);
    if (current === undefined || chunk.text !== current.text) {
      return 'corpus_content_mismatch';
    }
    if (canonicalJson(chunk) !== canonicalJson(current)) {
      return 'corpus_manifest_mismatch';
    }
  }
  return null;
}

function validateIndexForWrite(
  index: readonly IndexedChunk[],
  expectation: IndexExpectation,
): { chunks: KnowledgeChunk[]; embeddings: Float32Array; dimension: number } {
  const expectedChunks = canonicalExpectedChunks(expectation);
  if (index.length === 0) throw new Error('writeIndex: empty index');
  if (index.length !== expectation.corpusManifest.count) {
    throw new Error(
      `writeIndex: count ${index.length} does not match corpus count ${expectation.corpusManifest.count}`,
    );
  }

  const dimension = index[0]!.embedding.length;
  if (dimension === 0) throw new Error('writeIndex: embedding dimension is 0');
  const seen = new Set<string>();
  const chunks: KnowledgeChunk[] = [];
  const embeddings = new Float32Array(index.length * dimension);

  index.forEach((item, itemIndex) => {
    const chunk = canonicalChunk(item, itemIndex);
    if (seen.has(chunk.id)) {
      throw new Error(`writeIndex: duplicate chunk ID ${chunk.id}`);
    }
    seen.add(chunk.id);
    chunks.push(chunk);

    if (
      (!Array.isArray(item.embedding) &&
        !(item.embedding instanceof Float32Array)) ||
      item.embedding.length !== dimension
    ) {
      throw new Error(
        `writeIndex: embedding dimension mismatch at index ${itemIndex}`,
      );
    }
    item.embedding.forEach((value, valueIndex) => {
      if (!Number.isFinite(value)) {
        throw new Error(
          `writeIndex: embedding must contain finite numbers at index ${itemIndex}:${valueIndex}`,
        );
      }
    });
    embeddings.set(item.embedding, itemIndex * dimension);
  });

  for (let index = 0; index < embeddings.length; index++) {
    if (!Number.isFinite(embeddings[index])) {
      throw new Error(
        `writeIndex: Float32 embedding must remain finite at offset ${index}`,
      );
    }
  }
  const mismatch = chunkIdentityMismatch(chunks, expectedChunks);
  if (mismatch) {
    throw new Error(`writeIndex: ${mismatch}`);
  }
  return { chunks, embeddings, dimension };
}

export function writeIndex(
  index: readonly IndexedChunk[],
  expectation: IndexExpectation,
  dir: string = resolveIndexDir(),
): IndexManifest {
  assertEmbeddingModel(expectation.embeddingModel);
  const { chunks, embeddings, dimension } = validateIndexForWrite(
    index,
    expectation,
  );
  const manifest: IndexManifest = {
    formatVersion: INDEX_FORMAT_VERSION,
    embeddingModel: expectation.embeddingModel,
    dimension,
    count: chunks.length,
    corpusContentHash: expectation.corpusManifest.contentHash,
    corpusManifestHash: expectation.corpusManifest.manifestHash,
    indexHash: computeIndexHash(
      expectation.corpusManifest,
      expectation.embeddingModel,
    ),
    createdAt: new Date().toISOString(),
  };
  const paths = indexPaths(dir);

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    paths.chunks,
    `${chunks.map((chunk) => JSON.stringify(chunk)).join('\n')}\n`,
  );
  writeFileSync(
    paths.embeddings,
    Buffer.from(
      embeddings.buffer,
      embeddings.byteOffset,
      embeddings.byteLength,
    ),
  );
  writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function parseManifest(path: string): IndexReadResult | IndexManifest {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return miss('read_error', errorMessage(error));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return miss('invalid_manifest', errorMessage(error));
  }
  if (
    isRecord(value) &&
    Object.hasOwn(value, 'formatVersion') &&
    value.formatVersion !== INDEX_FORMAT_VERSION
  ) {
    return miss(
      'format_mismatch',
      `expected ${INDEX_FORMAT_VERSION}, received ${String(value.formatVersion)}`,
    );
  }
  const decoded = IndexManifestSchema.safeParse(value);
  return decoded.success
    ? decoded.data
    : miss('invalid_manifest', decoded.error.message);
}

function identityMismatch(
  manifest: IndexManifest,
  expectation: IndexExpectation,
): IndexReadResult | null {
  if (manifest.count !== expectation.corpusManifest.count) {
    return miss(
      'corpus_count_mismatch',
      `index=${manifest.count}, corpus=${expectation.corpusManifest.count}`,
    );
  }
  if (manifest.corpusContentHash !== expectation.corpusManifest.contentHash) {
    return miss('corpus_content_mismatch');
  }
  if (manifest.corpusManifestHash !== expectation.corpusManifest.manifestHash) {
    return miss('corpus_manifest_mismatch');
  }
  if (manifest.embeddingModel !== expectation.embeddingModel) {
    return miss(
      'embedding_model_mismatch',
      `index=${manifest.embeddingModel}, expected=${expectation.embeddingModel}`,
    );
  }
  const expectedIndexHash = computeIndexHash(
    expectation.corpusManifest,
    expectation.embeddingModel,
  );
  return manifest.indexHash === expectedIndexHash
    ? null
    : miss('index_hash_mismatch');
}

function readChunks(
  path: string,
  expectedCount: number,
): IndexReadResult | KnowledgeChunk[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return miss('read_error', errorMessage(error));
  }
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines =
    withoutTrailingNewline.length === 0
      ? []
      : withoutTrailingNewline.split('\n');
  if (lines.length !== expectedCount) {
    return miss(
      'chunk_count_mismatch',
      `chunks=${lines.length}, manifest=${expectedCount}`,
    );
  }

  const seen = new Set<string>();
  const chunks: KnowledgeChunk[] = [];
  for (let index = 0; index < lines.length; index++) {
    let chunk: KnowledgeChunk;
    try {
      chunk = decodeKnowledgeChunk(JSON.parse(lines[index]!));
    } catch (error) {
      return miss('invalid_chunk', `line ${index + 1}: ${errorMessage(error)}`);
    }
    if (seen.has(chunk.id)) {
      return miss('duplicate_chunk_id', chunk.id);
    }
    seen.add(chunk.id);
    chunks.push(chunk);
  }
  return chunks;
}

function readEmbeddings(
  path: string,
  manifest: IndexManifest,
): IndexReadResult | Float32Array {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    return miss('read_error', errorMessage(error));
  }
  const expectedBytes =
    manifest.count * manifest.dimension * Float32Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength !== expectedBytes) {
    return miss(
      'embedding_dimension_mismatch',
      `bytes=${buffer.byteLength}, expected=${expectedBytes}`,
    );
  }

  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  const embeddings = new Float32Array(arrayBuffer);
  for (let index = 0; index < embeddings.length; index++) {
    if (!Number.isFinite(embeddings[index])) {
      return miss('invalid_embedding', `offset ${index}`);
    }
  }
  return embeddings;
}

export function readIndex(
  expectation: IndexExpectation,
  dir: string = resolveIndexDir(),
): IndexReadResult {
  assertEmbeddingModel(expectation.embeddingModel);
  const expectedChunks = canonicalExpectedChunks(expectation);
  const paths = indexPaths(dir);
  const presence = Object.values(paths).map((path) => existsSync(path));
  if (presence.every((exists) => !exists)) return miss('missing_files');
  if (presence.some((exists) => !exists)) return miss('incomplete_files');

  const manifest = parseManifest(paths.manifest);
  if ('status' in manifest) return manifest;
  const mismatch = identityMismatch(manifest, expectation);
  if (mismatch) return mismatch;

  const chunks = readChunks(paths.chunks, manifest.count);
  if (!Array.isArray(chunks)) return chunks;
  const chunksMismatch = chunkIdentityMismatch(chunks, expectedChunks);
  if (chunksMismatch)
    return miss(chunksMismatch, 'chunks file differs from corpus');
  const embeddings = readEmbeddings(paths.embeddings, manifest);
  if (!(embeddings instanceof Float32Array)) return embeddings;

  return {
    status: 'hit',
    manifest,
    chunks: chunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings.subarray(
        index * manifest.dimension,
        (index + 1) * manifest.dimension,
      ),
    })),
  };
}
