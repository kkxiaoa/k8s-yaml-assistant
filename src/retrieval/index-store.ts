// 持久化全量 corpus index。index 只保存向量与当时的 canonical chunks；
// 当前 corpus identity、embedding model 或文件结构任一不匹配时都视为 cache miss。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { decodeKnowledgeChunk, type KnowledgeChunk } from '../knowledge/chunk';
import {
  KNOWLEDGE_IDENTITY_VERSION,
  type CorpusManifest,
} from '../knowledge/identity';
import { canonicalHash, canonicalJson } from '../shared/json';
import type { IndexBuildChunk } from './index-builder';
import { getRetrievalRuntimeConfig } from '../server/runtime-config';

export const INDEX_FORMAT_VERSION = 5 as const;

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
  corpusIdentityVersion: z.literal(KNOWLEDGE_IDENTITY_VERSION),
  embeddingModel: NonEmptyStringSchema,
  dimension: z.int().positive(),
  count: z.int().positive(),
  corpusManifestHash: Sha256Schema,
  chunksHash: Sha256Schema,
  embeddingsHash: Sha256Schema,
  indexHash: Sha256Schema,
  createdAt: z.iso.datetime({ offset: true }),
});

export type IndexManifest = z.infer<typeof IndexManifestSchema>;

export interface IndexExpectation {
  corpusManifest: CorpusManifest;
  corpusChunks: readonly KnowledgeChunk[];
  embeddingModel: string;
}

export interface IndexedChunk extends KnowledgeChunk {
  embedding: Float32Array;
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

/** 读取已经显式解码的索引目录。 */
export function resolveIndexDir(): string {
  return getRetrievalRuntimeConfig().indexDir;
}

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

function fileHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
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
  corpusManifest: Pick<
    CorpusManifest,
    'identityVersion' | 'manifestHash'
  >,
  embeddingModel: string,
): string {
  assertEmbeddingModel(embeddingModel);
  return canonicalHash({
    formatVersion: INDEX_FORMAT_VERSION,
    corpusIdentityVersion: corpusManifest.identityVersion,
    embeddingModel,
    corpusManifestHash: corpusManifest.manifestHash,
  });
}

function decodeIndexBuildChunk(
  chunk: IndexBuildChunk,
  index: number,
): KnowledgeChunk {
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

function decodeExpectedChunksById(
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

function chunksMatchExpected(
  chunks: readonly KnowledgeChunk[],
  expected: ReadonlyMap<string, KnowledgeChunk>,
): boolean {
  if (chunks.length !== expected.size) return false;
  for (const chunk of chunks) {
    const current = expected.get(chunk.id);
    if (
      current === undefined ||
      canonicalJson(chunk) !== canonicalJson(current)
    )
      return false;
  }
  return true;
}

function validateIndexForWrite(
  index: readonly IndexBuildChunk[],
  expectation: IndexExpectation,
): { chunks: KnowledgeChunk[]; embeddings: Float32Array; dimension: number } {
  const expectedChunks = decodeExpectedChunksById(expectation);
  if (index.length === 0) throw new Error('writeIndex: empty index');
  if (index.length !== expectation.corpusManifest.count) {
    throw new Error(
      `writeIndex: count ${index.length} does not match corpus count ${expectation.corpusManifest.count}`,
    );
  }

  const ordered = index
    .map((item, inputIndex) => ({
      item,
      inputIndex,
      chunk: decodeIndexBuildChunk(item, inputIndex),
    }))
    .sort(({ chunk: left }, { chunk: right }) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
  const first = ordered[0]!;
  if (!Array.isArray(first.item.embedding)) {
    throw new Error(
      `writeIndex: embedding must be number[] at index ${first.inputIndex}`,
    );
  }
  const dimension = first.item.embedding.length;
  if (dimension === 0) throw new Error('writeIndex: embedding dimension is 0');
  const seen = new Set<string>();
  const chunks: KnowledgeChunk[] = [];
  const embeddings = new Float32Array(index.length * dimension);

  ordered.forEach(({ item, inputIndex, chunk }, outputIndex) => {
    if (seen.has(chunk.id)) {
      throw new Error(`writeIndex: duplicate chunk ID ${chunk.id}`);
    }
    seen.add(chunk.id);
    chunks.push(chunk);

    if (!Array.isArray(item.embedding)) {
      throw new Error(
        `writeIndex: embedding must be number[] at index ${inputIndex}`,
      );
    }
    if (item.embedding.length !== dimension) {
      throw new Error(
        `writeIndex: embedding dimension mismatch at index ${inputIndex}`,
      );
    }
    item.embedding.forEach((value, valueIndex) => {
      if (!Number.isFinite(value)) {
        throw new Error(
          `writeIndex: embedding must contain finite numbers at index ${inputIndex}:${valueIndex}`,
        );
      }
    });
    embeddings.set(item.embedding, outputIndex * dimension);
  });

  for (let index = 0; index < embeddings.length; index++) {
    if (!Number.isFinite(embeddings[index])) {
      throw new Error(
        `writeIndex: Float32 embedding must remain finite at offset ${index}`,
      );
    }
  }
  if (!chunksMatchExpected(chunks, expectedChunks)) {
    throw new Error('writeIndex: corpus_manifest_mismatch');
  }
  return { chunks, embeddings, dimension };
}

export function writeIndex(
  index: readonly IndexBuildChunk[],
  expectation: IndexExpectation,
  dir: string = resolveIndexDir(),
): IndexManifest {
  assertEmbeddingModel(expectation.embeddingModel);
  const { chunks, embeddings, dimension } = validateIndexForWrite(
    index,
    expectation,
  );
  const chunksText = `${chunks.map((chunk) => JSON.stringify(chunk)).join('\n')}\n`;
  const embeddingsBuffer = Buffer.from(
    embeddings.buffer,
    embeddings.byteOffset,
    embeddings.byteLength,
  );
  const manifest: IndexManifest = {
    formatVersion: INDEX_FORMAT_VERSION,
    corpusIdentityVersion: expectation.corpusManifest.identityVersion,
    embeddingModel: expectation.embeddingModel,
    dimension,
    count: chunks.length,
    corpusManifestHash: expectation.corpusManifest.manifestHash,
    chunksHash: fileHash(chunksText),
    embeddingsHash: fileHash(embeddingsBuffer),
    indexHash: computeIndexHash(
      expectation.corpusManifest,
      expectation.embeddingModel,
    ),
    createdAt: new Date().toISOString(),
  };
  const paths = indexPaths(dir);

  mkdirSync(dir, { recursive: true });
  writeFileSync(paths.chunks, chunksText);
  writeFileSync(paths.embeddings, embeddingsBuffer);
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
  manifest: IndexManifest,
): IndexReadResult | KnowledgeChunk[] {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    return miss('read_error', errorMessage(error));
  }
  if (fileHash(buffer) !== manifest.chunksHash) {
    return miss('index_hash_mismatch', 'chunks file hash mismatch');
  }
  const text = buffer.toString('utf8');
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines =
    withoutTrailingNewline.length === 0
      ? []
      : withoutTrailingNewline.split('\n');
  if (lines.length !== manifest.count) {
    return miss(
      'chunk_count_mismatch',
      `chunks=${lines.length}, manifest=${manifest.count}`,
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
  if (fileHash(buffer) !== manifest.embeddingsHash) {
    return miss('index_hash_mismatch', 'embeddings file hash mismatch');
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
  const expectedChunks = decodeExpectedChunksById(expectation);
  const paths = indexPaths(dir);
  const presence = Object.values(paths).map((path) => existsSync(path));
  if (presence.every((exists) => !exists)) return miss('missing_files');
  if (presence.some((exists) => !exists)) return miss('incomplete_files');

  const manifest = parseManifest(paths.manifest);
  if ('status' in manifest) return manifest;
  const mismatch = identityMismatch(manifest, expectation);
  if (mismatch) return mismatch;

  const chunks = readChunks(paths.chunks, manifest);
  if (!Array.isArray(chunks)) return chunks;
  if (!chunksMatchExpected(chunks, expectedChunks))
    return miss('corpus_manifest_mismatch', 'chunks file differs from corpus');
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
