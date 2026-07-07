// A2:embedding model 可切换单测。纯函数,无需网络/key。

import assert from 'node:assert/strict';
import { resolveEmbeddingModel } from './embeddings';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

console.log('resolveEmbeddingModel:');

check('默认 embedding model 是 voyage-3', () => {
  delete process.env.VOYAGE_EMBEDDING_MODEL;
  assert.equal(resolveEmbeddingModel(), 'voyage-3');
});

check('env VOYAGE_EMBEDDING_MODEL 覆盖默认', () => {
  process.env.VOYAGE_EMBEDDING_MODEL = 'voyage-4';
  assert.equal(resolveEmbeddingModel(), 'voyage-4');
  delete process.env.VOYAGE_EMBEDDING_MODEL;
});

console.log(`\n通过 ${passed} 项`);
