import assert from 'node:assert/strict';
import { KNOWLEDGE_IDENTITY_VERSION } from './identity';
import {
  buildCorpus,
  buildCorpusManifest,
  CORPUS,
  DEFAULT_CORPUS_SOURCES,
  getCorpusProviders,
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
  assert.deepEqual(built, CORPUS);
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

check('真实 provider manifest 使用稳定 providerId 和单一完整 identity', () => {
  const manifest = buildCorpusManifest();
  assert.equal(manifest.identityVersion, KNOWLEDGE_IDENTITY_VERSION);
  assert.equal(manifest.count, CORPUS.length);
  assert.deepEqual(
    manifest.providers.map(({ providerId, sourceType }) => ({
      providerId,
      sourceType,
    })),
    [
      { providerId: 'policy.organization', sourceType: 'policy' },
      { providerId: 'schema.curated-openapi', sourceType: 'schema' },
    ],
  );
  assert.equal('contentHash' in manifest, false);
  assert.match(manifest.manifestHash, /^[a-f0-9]{64}$/);

  for (const provider of manifest.providers) {
    assert.ok(provider.count > 0, `${provider.providerId} count`);
    assert.equal('contentHash' in provider, false);
    assert.equal('identityVersion' in provider, false);
    assert.match(provider.manifestHash, /^[a-f0-9]{64}$/);
  }
});

check('未注册 sourceType 明确失败', () => {
  assert.throws(
    () => getCorpusProviders(['docs']),
    /未注册 corpus provider: docs/,
  );
});

check('source 子集使用同一 manifest contract', () => {
  const schema = buildCorpusManifest({ sources: ['schema'] });
  assert.equal(schema.providers.length, 1);
  assert.equal(schema.providers[0]!.providerId, 'schema.curated-openapi');
  assert.equal(schema.count, buildCorpus({ sources: ['schema'] }).length);
});

console.log(`\n通过 ${passed} 项`);
