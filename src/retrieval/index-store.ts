// 索引持久化(§4.3)。把全量 CORPUS 的 embedding 落盘,避免每次 eval/启动都重嵌。
// 格式:data/index/{manifest.json, chunks.jsonl, embeddings.f32}
//   - manifest.json   : 元信息 + corpusHash/indexHash(失效判定)
//   - chunks.jsonl    : 每行一个 chunk(不含 embedding,可读、可 diff)
//   - embeddings.f32  : 紧凑二进制 Float32(count × dim,行序与 chunks.jsonl 对齐)
//
// 本模块只做 hash 计算 + 磁盘读写,不碰网络、不做嵌入(嵌入在 index:build 脚本里)。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chunk } from '../knowledge/corpus';
import type { IndexedChunk } from './retrieve';

/** 索引目录:env INDEX_DIR 优先,默认 data/index。A/B 用隔离目录(如 data/index-ab)。 */
export function resolveIndexDir(): string {
  return process.env.INDEX_DIR ?? join(process.cwd(), 'data', 'index');
}

export const INDEX_DIR = resolveIndexDir();

export interface IndexManifest {
  indexHash: string;
  corpusHash: string;
  embeddingModel: string;
  dimension: number;
  count: number;
  createdAt: string;
}

/** 语料指纹:按 id 排序后拼接 `id\ntext`,取 sha256。语料内容变化即变化。 */
export function computeCorpusHash(chunks: Chunk[]): string {
  const h = createHash('sha256');
  for (const c of [...chunks].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(c.id);
    h.update('\n');
    h.update(c.text);
    h.update('\n');
  }
  return h.digest('hex');
}

/** 索引指纹:corpusHash + embeddingModel。语料或模型任一变化即让旧索引失效。 */
export function computeIndexHash(
  corpusHash: string,
  embeddingModel: string,
): string {
  return createHash('sha256')
    .update(corpusHash)
    .update('\n')
    .update(embeddingModel)
    .digest('hex');
}

/** 把带 embedding 的索引写盘。 */
export function writeIndex(
  index: IndexedChunk[],
  embeddingModel: string,
  dir: string = resolveIndexDir(),
): IndexManifest {
  if (index.length === 0) throw new Error('writeIndex: 空索引');
  const dimension = index[0]!.embedding.length;
  if (dimension === 0) throw new Error('writeIndex: embedding 维度为 0');
  const manifestPath = join(dir, 'manifest.json');
  const chunksPath = join(dir, 'chunks.jsonl');
  const embeddingsPath = join(dir, 'embeddings.f32');

  const corpusHash = computeCorpusHash(index);
  const manifest: IndexManifest = {
    indexHash: computeIndexHash(corpusHash, embeddingModel),
    corpusHash,
    embeddingModel,
    dimension,
    count: index.length,
    createdAt: new Date().toISOString(),
  };

  mkdirSync(dir, { recursive: true });

  // chunks.jsonl(不含 embedding)
  const jsonl = index
    .map((c) =>
      JSON.stringify({
        id: c.id,
        resource: c.resource,
        path: c.path,
        title: c.title,
        text: c.text,
        sourceType: c.sourceType,
      }),
    )
    .join('\n');
  writeFileSync(chunksPath, `${jsonl}\n`);

  // embeddings.f32(紧凑二进制,行序与 chunks.jsonl 对齐)
  const flat = new Float32Array(index.length * dimension);
  index.forEach((c, i) => {
    if (c.embedding.length !== dimension)
      throw new Error(`writeIndex: 第 ${i} 条维度不一致`);
    flat.set(c.embedding, i * dimension);
  });
  writeFileSync(embeddingsPath, Buffer.from(flat.buffer));

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** 读盘还原索引。文件缺失返回 null;格式损坏(count×dim 对不上)抛错。 */
export function readIndex(
  dir: string = resolveIndexDir(),
): {
  manifest: IndexManifest;
  chunks: IndexedChunk[];
} | null {
  const manifestPath = join(dir, 'manifest.json');
  const chunksPath = join(dir, 'chunks.jsonl');
  const embeddingsPath = join(dir, 'embeddings.f32');
  if (
    !existsSync(manifestPath) ||
    !existsSync(chunksPath) ||
    !existsSync(embeddingsPath)
  )
    return null;

  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  ) as IndexManifest;
  const lines = readFileSync(chunksPath, 'utf8').split('\n').filter(Boolean);
  if (lines.length !== manifest.count) {
    throw new Error(
      `readIndex: chunks 行数 ${lines.length} != manifest.count ${manifest.count}`,
    );
  }

  const buf = readFileSync(embeddingsPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const flat = new Float32Array(ab);
  if (flat.length !== manifest.count * manifest.dimension) {
    throw new Error(
      `readIndex: embedding 长度 ${flat.length} != count×dim ${manifest.count * manifest.dimension}`,
    );
  }

  const chunks: IndexedChunk[] = lines.map((line, i) => {
    const c = JSON.parse(line) as Chunk;
    return {
      ...c,
      embedding: Array.from(
        flat.subarray(i * manifest.dimension, (i + 1) * manifest.dimension),
      ),
    };
  });

  return { manifest, chunks };
}
