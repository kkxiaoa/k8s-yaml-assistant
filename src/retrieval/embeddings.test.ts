// Embedding model 与 index v3 持久化契约测试。纯本地,不调用 embedding 或网络。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeChunk } from '../knowledge/chunk';
import {
  buildCorpusIdentity,
  type CorpusManifest,
} from '../knowledge/identity';
import { resolveEmbeddingModel } from './embeddings';
import {
  buildIndexInput,
  type IndexBuildChunk,
} from './index-builder';
import {
  type IndexedChunk,
  computeIndexHash,
  INDEX_FORMAT_VERSION,
  readIndex,
  writeIndex,
  type IndexExpectation,
  type IndexMissReason,
  type IndexReadResult,
} from './index-store';
import {
  CorpusIndexUnavailableError,
  createCorpusIndexLoader,
  denseSearch,
  resolveCorpusIndex,
} from './retrieve';

const BASE_CHUNK: KnowledgeChunk = {
  id: 'schema::v1::Pod::spec.containers.image',
  title: 'Pod · spec.containers.image',
  text: 'image field',
  sourceType: 'schema',
  provenance: { authority: 'cluster_api', version: 'v1' },
  targets: [
    { apiVersion: 'v1', kind: 'Pod', path: 'spec.containers.image' },
  ],
};

const SECOND_CHUNK: KnowledgeChunk = {
  id: 'schema::v1::Pod::spec.restartPolicy',
  title: 'Pod · spec.restartPolicy',
  text: 'restart policy field',
  sourceType: 'schema',
  provenance: { authority: 'cluster_api', version: 'v1' },
  targets: [
    { apiVersion: 'v1', kind: 'Pod', path: 'spec.restartPolicy' },
  ],
};

function corpusManifest(
  chunks: readonly KnowledgeChunk[] = [BASE_CHUNK],
): CorpusManifest {
  return buildCorpusIdentity([
    {
      providerId: 'schema.test',
      sourceType: 'schema',
      chunks,
    },
  ]);
}

function expectation(
  chunks: readonly KnowledgeChunk[] = [BASE_CHUNK],
  embeddingModel = 'test-model',
): IndexExpectation {
  return {
    corpusManifest: corpusManifest(chunks),
    corpusChunks: chunks,
    embeddingModel,
  };
}

function indexed(
  chunk: KnowledgeChunk,
  embedding: number[] = [0.25, 0.75],
): IndexBuildChunk {
  return { ...chunk, embedding };
}

type IsExact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;

const INDEXED_EMBEDDING_IS_FLOAT32: IsExact<
  IndexedChunk['embedding'],
  Float32Array
> = true;
void INDEXED_EMBEDDING_IS_FLOAT32;

function missReason(result: IndexReadResult): IndexMissReason {
  assert.equal(result.status, 'miss');
  return result.reason;
}

function rewriteManifest(
  dir: string,
  mutate: (manifest: Record<string, unknown>) => void,
): void {
  const path = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    unknown
  >;
  mutate(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function refreshFileHash(
  dir: string,
  file: 'chunks.jsonl' | 'embeddings.f32',
): void {
  const field = file === 'chunks.jsonl' ? 'chunksHash' : 'embeddingsHash';
  rewriteManifest(dir, (manifest) => {
    manifest[field] = sha256File(join(dir, file));
  });
}

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(
      `  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

async function checkAsync(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(
      `  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

console.log('resolveEmbeddingModel / index v3:');

check('默认 embedding model 是 voyage-3', () => {
  delete process.env.VOYAGE_EMBEDDING_MODEL;
  assert.equal(resolveEmbeddingModel(), 'voyage-3');
});

check('env VOYAGE_EMBEDDING_MODEL 覆盖默认', () => {
  process.env.VOYAGE_EMBEDDING_MODEL = 'voyage-4';
  assert.equal(resolveEmbeddingModel(), 'voyage-4');
  delete process.env.VOYAGE_EMBEDDING_MODEL;
});

check('index v3 round-trip 保存完整 identity 与 canonical metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v3-roundtrip-'));
  try {
    const expected = expectation();
    const manifest = writeIndex(
      [indexed(BASE_CHUNK)],
      expected,
      dir,
    );

    assert.deepEqual(manifest, {
      formatVersion: INDEX_FORMAT_VERSION,
      embeddingModel: expected.embeddingModel,
      dimension: 2,
      count: 1,
      corpusContentHash: expected.corpusManifest.contentHash,
      corpusManifestHash: expected.corpusManifest.manifestHash,
      chunksHash: sha256File(join(dir, 'chunks.jsonl')),
      embeddingsHash: sha256File(join(dir, 'embeddings.f32')),
      indexHash: computeIndexHash(
        expected.corpusManifest,
        expected.embeddingModel,
      ),
      createdAt: manifest.createdAt,
    });
    assert.match(manifest.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    const rawChunk = JSON.parse(
      readFileSync(join(dir, 'chunks.jsonl'), 'utf8').trim(),
    ) as Record<string, unknown>;
    assert.deepEqual(rawChunk.targets, BASE_CHUNK.targets);
    assert.deepEqual(rawChunk.provenance, BASE_CHUNK.provenance);
    for (const field of [
      'resource',
      'path',
      'resources',
      'paths',
      'appliesTo',
      'sourceUri',
      'version',
      'trustLevel',
    ]) {
      assert.equal(field in rawChunk, false, field);
    }

    const restored = readIndex(expected, dir);
    assert.equal(restored.status, 'hit');
    assert.deepEqual(restored.chunks[0]!.targets, BASE_CHUNK.targets);
    assert.deepEqual(restored.chunks[0]!.provenance, BASE_CHUNK.provenance);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('index hit 使用共享连续 Float32Array,不展开为 number[]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v3-contiguous-'));
  try {
    const chunks = [BASE_CHUNK, SECOND_CHUNK];
    const expected = expectation(chunks);
    writeIndex(
      [
        indexed(BASE_CHUNK, [0.25, 0.75]),
        indexed(SECOND_CHUNK, [-0.5, 0.125]),
      ],
      expected,
      dir,
    );

    const restored = readIndex(expected, dir);
    assert.equal(restored.status, 'hit');
    const first: unknown = restored.chunks[0]!.embedding;
    const second: unknown = restored.chunks[1]!.embedding;
    assert.ok(first instanceof Float32Array);
    assert.ok(second instanceof Float32Array);
    assert.equal(first.buffer, second.buffer);
    assert.equal(first.byteOffset + first.byteLength, second.byteOffset);
    assert.deepEqual(Array.from(first), [0.25, 0.75]);
    assert.deepEqual(Array.from(second), [-0.5, 0.125]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('连续 Float32Array 与 builder number[] 的 dense score 和排序完全一致', () => {
  const thirdChunk: KnowledgeChunk = {
    ...BASE_CHUNK,
    id: 'schema::v1::Pod::spec.nodeName',
    title: 'Pod · spec.nodeName',
    text: 'node name field',
    targets: [{ apiVersion: 'v1', kind: 'Pod', path: 'spec.nodeName' }],
  };
  const chunks = [BASE_CHUNK, SECOND_CHUNK, thirdChunk];
  const vectors = [
    new Float32Array([0.125, -0.5, 0.75, 0.25]),
    new Float32Array([-0.625, 0.375, 0.25, -0.125]),
    new Float32Array([0.5, 0.25, -0.375, 0.625]),
  ];
  const dimension = vectors[0]!.length;
  const matrix = new Float32Array(chunks.length * dimension);
  vectors.forEach((vector, index) => matrix.set(vector, index * dimension));

  const legacy = chunks.map((chunk, index) =>
    indexed(chunk, Array.from(vectors[index]!)),
  );
  const query = [0.3, -0.2, 0.4, 0.1];
  const referenceCosine = (a: number[], b: number[]): number => {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < a.length; index++) {
      const av = a[index] ?? 0;
      const bv = b[index] ?? 0;
      dot += av * bv;
      normA += av * av;
      normB += bv * bv;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  };
  const expected = legacy
    .map((chunk) => ({
      id: chunk.id,
      score: referenceCosine(query, chunk.embedding),
    }))
    .sort((a, b) => b.score - a.score);
  const dir = mkdtempSync(join(tmpdir(), 'index-v3-ab-'));
  try {
    const expectedIdentity = expectation(chunks);
    writeIndex(legacy, expectedIdentity, dir);
    const restored = readIndex(expectedIdentity, dir);
    assert.equal(restored.status, 'hit');
    const actual = denseSearch(query, restored.chunks, chunks.length).map(
      ({ chunk, score }) => ({ id: chunk.id, score }),
    );
    assert.deepEqual(actual, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('text、metadata 与 model 变化分别给出明确 miss reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v3-identity-'));
  try {
    const original = expectation();
    writeIndex([indexed(BASE_CHUNK)], original, dir);

    const changedText = { ...BASE_CHUNK, text: 'changed image field' };
    assert.equal(
      missReason(readIndex(expectation([changedText]), dir)),
      'corpus_content_mismatch',
    );

    const changedMetadata: KnowledgeChunk = {
      ...BASE_CHUNK,
      provenance: { authority: 'kubernetes_official', version: 'v1' },
    };
    assert.equal(
      missReason(readIndex(expectation([changedMetadata]), dir)),
      'corpus_manifest_mismatch',
    );
    assert.equal(
      missReason(readIndex(expectation([BASE_CHUNK], 'other-model'), dir)),
      'embedding_model_mismatch',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('chunks 文件与 manifest 声称的当前 identity 不一致时失效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v3-chunk-identity-'));
  try {
    const expected = expectation();
    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    writeFileSync(
      join(dir, 'chunks.jsonl'),
      `${JSON.stringify({ ...BASE_CHUNK, text: 'stale image field' })}\n`,
    );
    refreshFileHash(dir, 'chunks.jsonl');
    assert.equal(
      missReason(readIndex(expected, dir)),
      'corpus_content_mismatch',
    );

    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    writeFileSync(
      join(dir, 'chunks.jsonl'),
      `${JSON.stringify({
        ...BASE_CHUNK,
        provenance: { authority: 'kubernetes_official', version: 'v1' },
      })}\n`,
    );
    refreshFileHash(dir, 'chunks.jsonl');
    assert.equal(
      missReason(readIndex(expected, dir)),
      'corpus_manifest_mismatch',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('count、dimension 与 indexHash 不一致不会返回 chunks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v3-shape-'));
  try {
    const expected = expectation();
    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    rewriteManifest(dir, (manifest) => {
      manifest.count = 2;
    });
    const countMismatch = readIndex(expected, dir);
    assert.equal(missReason(countMismatch), 'corpus_count_mismatch');
    assert.equal('chunks' in countMismatch, false);

    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    rewriteManifest(dir, (manifest) => {
      manifest.dimension = 3;
    });
    assert.equal(
      missReason(readIndex(expected, dir)),
      'embedding_dimension_mismatch',
    );

    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    rewriteManifest(dir, (manifest) => {
      manifest.indexHash = 'f'.repeat(64);
    });
    assert.equal(
      missReason(readIndex(expected, dir)),
      'index_hash_mismatch',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('chunks 与 embeddings 文件哈希不匹配时封闭失效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v3-file-hash-'));
  try {
    const expected = expectation();
    const manifest = writeIndex([indexed(BASE_CHUNK)], expected, dir);
    const chunksPath = join(dir, 'chunks.jsonl');
    const embeddingsPath = join(dir, 'embeddings.f32');
    assert.equal(manifest.chunksHash, sha256File(chunksPath));
    assert.equal(manifest.embeddingsHash, sha256File(embeddingsPath));

    const chunksText = readFileSync(chunksPath, 'utf8');
    writeFileSync(chunksPath, `${chunksText.trimEnd()} \n`);
    assert.equal(
      missReason(readIndex(expected, dir)),
      'index_hash_mismatch',
    );

    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    const bytes = readFileSync(embeddingsPath);
    const changed = new Float32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    changed[0] = changed[0]! + 0.125;
    writeFileSync(embeddingsPath, Buffer.from(changed.buffer));
    assert.equal(
      missReason(readIndex(expected, dir)),
      'index_hash_mismatch',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('格式、损坏 JSON、chunk count 与旧 manifest 明确失效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v3-json-'));
  try {
    const expected = expectation();
    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    writeFileSync(join(dir, 'manifest.json'), '{broken');
    assert.equal(missReason(readIndex(expected, dir)), 'invalid_manifest');

    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    writeFileSync(join(dir, 'chunks.jsonl'), '{broken\n');
    refreshFileHash(dir, 'chunks.jsonl');
    assert.equal(missReason(readIndex(expected, dir)), 'invalid_chunk');

    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    writeFileSync(join(dir, 'chunks.jsonl'), '');
    refreshFileHash(dir, 'chunks.jsonl');
    assert.equal(
      missReason(readIndex(expected, dir)),
      'chunk_count_mismatch',
    );

    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    rewriteManifest(dir, (manifest) => {
      manifest.formatVersion = 1;
    });
    assert.equal(missReason(readIndex(expected, dir)), 'format_mismatch');

    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    writeFileSync(
      join(dir, 'manifest.json'),
      `${JSON.stringify({
        formatVersion: INDEX_FORMAT_VERSION,
        corpusHash: 'a'.repeat(64),
        indexHash: 'b'.repeat(64),
        embeddingModel: 'test-model',
        dimension: 2,
        count: 1,
        createdAt: '2026-07-12T00:00:00.000Z',
      })}\n`,
    );
    assert.equal(missReason(readIndex(expected, dir)), 'invalid_manifest');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('NaN embedding 与 duplicate chunk ID 明确失效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v3-values-'));
  try {
    const expected = expectation();
    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    writeFileSync(
      join(dir, 'embeddings.f32'),
      Buffer.from(new Float32Array([Number.NaN, 0.75]).buffer),
    );
    refreshFileHash(dir, 'embeddings.f32');
    assert.equal(missReason(readIndex(expected, dir)), 'invalid_embedding');

    const twoChunks = [BASE_CHUNK, SECOND_CHUNK];
    const twoExpected = expectation(twoChunks);
    writeIndex(twoChunks.map((chunk) => indexed(chunk)), twoExpected, dir);
    const firstLine = JSON.stringify(BASE_CHUNK);
    writeFileSync(join(dir, 'chunks.jsonl'), `${firstLine}\n${firstLine}\n`);
    refreshFileHash(dir, 'chunks.jsonl');
    assert.equal(
      missReason(readIndex(twoExpected, dir)),
      'duplicate_chunk_id',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('缺失和不完整文件集使用不同 miss reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v3-files-'));
  try {
    const expected = expectation();
    assert.equal(missReason(readIndex(expected, dir)), 'missing_files');
    writeFileSync(join(dir, 'manifest.json'), '{}\n');
    assert.equal(missReason(readIndex(expected, dir)), 'incomplete_files');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('writeIndex 在落盘前拒绝 count、维度、NaN 与重复 ID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v3-write-'));
  try {
    assert.throws(
      () =>
        writeIndex(
          [
            {
              ...BASE_CHUNK,
              embedding: new Float32Array([0.25, 0.75]),
            } as unknown as IndexBuildChunk,
          ],
          expectation(),
          dir,
        ),
      /number\[\]/i,
    );
    assert.throws(
      () =>
        writeIndex(
          [indexed(BASE_CHUNK)],
          expectation([BASE_CHUNK, SECOND_CHUNK]),
          dir,
        ),
      /count/i,
    );
    assert.throws(
      () =>
        writeIndex(
          [indexed(BASE_CHUNK), indexed(SECOND_CHUNK, [0.5])],
          expectation([BASE_CHUNK, SECOND_CHUNK]),
          dir,
        ),
      /dimension/i,
    );
    assert.throws(
      () =>
        writeIndex(
          [indexed(BASE_CHUNK, [Number.NaN, 0.75])],
          expectation(),
          dir,
        ),
      /finite/i,
    );
    assert.throws(
      () =>
        writeIndex(
          [indexed(BASE_CHUNK), indexed(BASE_CHUNK)],
          expectation([BASE_CHUNK, SECOND_CHUNK]),
          dir,
        ),
      /duplicate/i,
    );
    assert.throws(
      () =>
        writeIndex(
          [indexed({ ...BASE_CHUNK, text: 'stale text' })],
          expectation(),
          dir,
        ),
      /corpus_content_mismatch/,
    );
    assert.throws(
      () =>
        writeIndex(
          [
            indexed({
              ...BASE_CHUNK,
              provenance: {
                authority: 'kubernetes_official',
                version: 'v1',
              },
            }),
          ],
          expectation(),
          dir,
        ),
      /corpus_manifest_mismatch/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await checkAsync('builder input 是唯一保留 number[] 的模型边界', async () => {
  let supplierCalls = 0;
  const built = await buildIndexInput(
    [BASE_CHUNK, SECOND_CHUNK],
    'test-model',
    async (texts, model) => {
      supplierCalls++;
      assert.deepEqual(texts, [BASE_CHUNK.text, SECOND_CHUNK.text]);
      assert.equal(model, 'test-model');
      return [
        [0.25, 0.75],
        [-0.5, 0.125],
      ];
    },
  );

  assert.equal(supplierCalls, 1);
  assert.equal(Array.isArray(built[0]!.embedding), true);
});

await checkAsync('runtime 所有 miss 都封闭失败且不调用旧 rebuild 或 Voyage', async () => {
  const reasons: IndexMissReason[] = [
    'missing_files',
    'incomplete_files',
    'read_error',
    'format_mismatch',
    'invalid_manifest',
    'corpus_count_mismatch',
    'corpus_content_mismatch',
    'corpus_manifest_mismatch',
    'embedding_model_mismatch',
    'index_hash_mismatch',
    'chunk_count_mismatch',
    'invalid_chunk',
    'duplicate_chunk_id',
    'embedding_dimension_mismatch',
    'invalid_embedding',
  ];
  let rebuildCalls = 0;
  let voyageCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    voyageCalls++;
    throw new Error('network must not be called');
  };
  const legacyCall = resolveCorpusIndex as unknown as (
    persisted: IndexReadResult,
    rebuild: () => Promise<IndexedChunk[]>,
  ) => Promise<{ chunks: IndexedChunk[] }>;

  try {
    for (const reason of reasons) {
      await assert.rejects(
        legacyCall(
          { status: 'miss', reason },
          async () => {
            rebuildCalls++;
            return [];
          },
        ),
        (error: unknown) =>
          error instanceof CorpusIndexUnavailableError &&
          error.reason === reason &&
          error.message === 'corpus index unavailable',
        reason,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(resolveCorpusIndex.length, 1);
  assert.equal(rebuildCalls, 0);
  assert.equal(voyageCalls, 0);
});

await checkAsync('runtime hit 复用已校验 Float32 chunks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v3-hit-'));
  try {
    const expected = expectation();
    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    const persisted = readIndex(expected, dir);
    const resolved = await resolveCorpusIndex(persisted);

    assert.deepEqual(resolved.cache, { status: 'hit' });
    assert.equal(resolved.chunks[0]!.id, BASE_CHUNK.id);
    assert.ok(resolved.chunks[0]!.embedding instanceof Float32Array);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await checkAsync('有效 serving index 在并发和后续调用中只读取一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v3-loader-once-'));
  try {
    const expected = expectation();
    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    let readCalls = 0;
    const loader = createCorpusIndexLoader(() => {
      readCalls++;
      return readIndex(expected, dir);
    });

    const firstPromise = loader.load();
    const secondPromise = loader.load();
    assert.strictEqual(secondPromise, firstPromise);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.strictEqual(second, first);
    assert.strictEqual(await loader.load(), first);
    assert.equal(readCalls, 1);
    assert.deepEqual(loader.cache(), { status: 'hit' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n通过 ${passed} 项`);
