// §4.3 3b:构建并持久化全量 CORPUS 索引。唯一花 Voyage 额度的一步(嵌入 CORPUS.length 条)。
// 产出 data/index/{manifest.json, chunks.jsonl, embeddings.f32};之后 eval/serving 只嵌 query。
// 用法:npm run index:build

import { config } from 'dotenv';
config({ override: true });
import { buildCorpusManifest, CORPUS } from '../src/knowledge/corpus';
import { buildIndex } from '../src/retrieval/retrieve';
import { resolveEmbeddingModel } from '../src/retrieval/embeddings';
import {
  resolveIndexDir,
  readIndex,
  writeIndex,
} from '../src/retrieval/index-store';

async function main(): Promise<void> {
  const embeddingModel = resolveEmbeddingModel();
  const indexDir = resolveIndexDir();
  const expectation = {
    corpusManifest: buildCorpusManifest(),
    corpusChunks: CORPUS,
    embeddingModel,
  };

  const existing = readIndex(expectation, indexDir);
  if (existing.status === 'hit') {
    console.log(`索引已是最新(indexHash 匹配),跳过嵌入。${indexDir}`);
    console.log(existing.manifest);
    return;
  }
  if (existing.reason !== 'missing_files') {
    console.log(`索引失效(${existing.reason}),重建...`);
  }

  console.log(`嵌入 ${CORPUS.length} 条 chunk(模型 ${embeddingModel})...`);
  const t0 = Date.now();
  const index = await buildIndex(CORPUS);
  const manifest = writeIndex(index, expectation, indexDir);

  console.log(`\n✓ 索引已落盘 → ${indexDir}(耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(manifest);
}

main().catch((e: unknown) => {
  console.error('index:build 失败:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
