// §4.3 3b:构建并持久化全量 CORPUS 索引。唯一花 Voyage 额度的一步(嵌入 CORPUS.length 条)。
// 产出 data/index/{manifest.json, chunks.jsonl, embeddings.f32};之后 eval/serving 只嵌 query。
// 用法:npm run index:build

import { config } from 'dotenv';
config({ override: true });
import { CORPUS } from '../src/knowledge/corpus';
import { buildIndex } from '../src/retrieval/retrieve';
import { EMBEDDING_MODEL } from '../src/retrieval/embeddings';
import { INDEX_DIR, readIndex, writeIndex, computeCorpusHash, computeIndexHash } from '../src/retrieval/index-store';

async function main(): Promise<void> {
  const wantHash = computeIndexHash(computeCorpusHash(CORPUS), EMBEDDING_MODEL);

  const existing = readIndex();
  if (existing && existing.manifest.indexHash === wantHash) {
    console.log(`索引已是最新(indexHash 匹配),跳过嵌入。${INDEX_DIR}`);
    console.log(existing.manifest);
    return;
  }
  if (existing) {
    console.log('检测到旧索引但 indexHash 不一致(语料或模型变了),重建...');
  }

  console.log(`嵌入 ${CORPUS.length} 条 chunk(模型 ${EMBEDDING_MODEL})...`);
  const t0 = Date.now();
  const index = await buildIndex(CORPUS);
  const manifest = writeIndex(index, EMBEDDING_MODEL);

  console.log(`\n✓ 索引已落盘 → ${INDEX_DIR}(耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(manifest);
}

main().catch((e: unknown) => {
  console.error('index:build 失败:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
