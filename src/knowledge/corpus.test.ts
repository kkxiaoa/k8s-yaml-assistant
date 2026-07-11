import assert from 'node:assert/strict';
import {
  buildCorpus,
  buildCorpusManifest,
  CORPUS,
  DEFAULT_CORPUS_SOURCES,
  getCorpusProviders,
  hashCorpusChunks,
} from './corpus';

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

console.log('corpus builder:');

check('默认构建 schema + policy,与兼容 CORPUS 常量一致', () => {
  assert.deepEqual([...DEFAULT_CORPUS_SOURCES], ['schema', 'policy']);
  const built = buildCorpus();
  assert.equal(built.length, CORPUS.length);
  assert.equal(hashCorpusChunks(built), hashCorpusChunks(CORPUS));
});

check('source 选择可控', () => {
  const schemaOnly = buildCorpus({ sources: ['schema'] });
  const policyOnly = buildCorpus({ sources: ['policy'] });

  assert.ok(schemaOnly.length > 0);
  assert.ok(policyOnly.length > 0);
  assert.ok(schemaOnly.every((chunk) => chunk.sourceType === 'schema'));
  assert.ok(policyOnly.every((chunk) => chunk.sourceType === 'policy'));
  assert.equal(buildCorpus().length, schemaOnly.length + policyOnly.length);
});

check('provider manifest 包含 sourceType、count、hash', () => {
  const manifest = buildCorpusManifest();
  assert.equal(manifest.count, CORPUS.length);
  assert.equal(manifest.hash, hashCorpusChunks(CORPUS));
  assert.deepEqual(
    manifest.sources.map((source) => source.sourceType),
    ['schema', 'policy'],
  );

  for (const source of manifest.sources) {
    assert.ok(source.count > 0, `${source.sourceType} count`);
    assert.match(source.hash, /^[a-f0-9]{64}$/, `${source.sourceType} hash`);
  }
});

check('未注册 sourceType 明确失败', () => {
  assert.throws(
    () => getCorpusProviders(['docs']),
    /未注册 corpus provider: docs/,
  );
});

check('corpus hash 对输入顺序稳定', () => {
  const chunks = buildCorpus();
  assert.equal(hashCorpusChunks(chunks), hashCorpusChunks([...chunks].reverse()));
});

console.log(`\n通过 ${passed} 项`);
