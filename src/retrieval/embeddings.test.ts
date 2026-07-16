// Embedding model 与 index v2 持久化契约测试。纯本地,不调用 embedding 或网络。

import assert from 'node:assert/strict';
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
  computeIndexHash,
  INDEX_FORMAT_VERSION,
  readIndex,
  writeIndex,
  type IndexExpectation,
  type IndexMissReason,
  type IndexReadResult,
} from './index-store';
import { resolveCorpusIndex, type IndexedChunk } from './retrieve';

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
): IndexedChunk {
  return { ...chunk, embedding };
}

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

console.log('resolveEmbeddingModel / index v2:');

check('默认 embedding model 是 voyage-3', () => {
  delete process.env.VOYAGE_EMBEDDING_MODEL;
  assert.equal(resolveEmbeddingModel(), 'voyage-3');
});

check('env VOYAGE_EMBEDDING_MODEL 覆盖默认', () => {
  process.env.VOYAGE_EMBEDDING_MODEL = 'voyage-4';
  assert.equal(resolveEmbeddingModel(), 'voyage-4');
  delete process.env.VOYAGE_EMBEDDING_MODEL;
});

check('index v2 round-trip 保存完整 identity 与 canonical metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v2-roundtrip-'));
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

check('text、metadata 与 model 变化分别给出明确 miss reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v2-identity-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'index-v2-chunk-identity-'));
  try {
    const expected = expectation();
    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    writeFileSync(
      join(dir, 'chunks.jsonl'),
      `${JSON.stringify({ ...BASE_CHUNK, text: 'stale image field' })}\n`,
    );
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
    assert.equal(
      missReason(readIndex(expected, dir)),
      'corpus_manifest_mismatch',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('count、dimension 与 indexHash 不一致不会返回 chunks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v2-shape-'));
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

check('格式、损坏 JSON、chunk count 与旧 manifest 明确失效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v2-json-'));
  try {
    const expected = expectation();
    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    writeFileSync(join(dir, 'manifest.json'), '{broken');
    assert.equal(missReason(readIndex(expected, dir)), 'invalid_manifest');

    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    writeFileSync(join(dir, 'chunks.jsonl'), '{broken\n');
    assert.equal(missReason(readIndex(expected, dir)), 'invalid_chunk');

    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    writeFileSync(join(dir, 'chunks.jsonl'), '');
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
  const dir = mkdtempSync(join(tmpdir(), 'index-v2-values-'));
  try {
    const expected = expectation();
    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    writeFileSync(
      join(dir, 'embeddings.f32'),
      Buffer.from(new Float32Array([Number.NaN, 0.75]).buffer),
    );
    assert.equal(missReason(readIndex(expected, dir)), 'invalid_embedding');

    const twoChunks = [BASE_CHUNK, SECOND_CHUNK];
    const twoExpected = expectation(twoChunks);
    writeIndex(twoChunks.map((chunk) => indexed(chunk)), twoExpected, dir);
    const firstLine = JSON.stringify(BASE_CHUNK);
    writeFileSync(join(dir, 'chunks.jsonl'), `${firstLine}\n${firstLine}\n`);
    assert.equal(
      missReason(readIndex(twoExpected, dir)),
      'duplicate_chunk_id',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('缺失和不完整文件集使用不同 miss reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v2-files-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'index-v2-write-'));
  try {
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

await checkAsync('runtime miss 只返回当前重建 chunks，并保留 trace reason', async () => {
  const stale: IndexReadResult = {
    status: 'miss',
    reason: 'corpus_manifest_mismatch',
  };
  const current = indexed({
    ...BASE_CHUNK,
    provenance: { authority: 'kubernetes_official', version: 'v1' },
  });
  const resolved = await resolveCorpusIndex(stale, async () => [current]);

  assert.deepEqual(resolved.chunks, [current]);
  assert.deepEqual(resolved.cache, {
    status: 'rebuilt',
    reason: 'corpus_manifest_mismatch',
  });
});

await checkAsync('runtime hit 复用已校验 chunks，不执行 rebuild', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-v2-hit-'));
  try {
    const expected = expectation();
    writeIndex([indexed(BASE_CHUNK)], expected, dir);
    const persisted = readIndex(expected, dir);
    let rebuildCalled = false;
    const resolved = await resolveCorpusIndex(persisted, async () => {
      rebuildCalled = true;
      return [];
    });

    assert.equal(rebuildCalled, false);
    assert.deepEqual(resolved.cache, { status: 'hit' });
    assert.equal(resolved.chunks[0]!.id, BASE_CHUNK.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n通过 ${passed} 项`);
