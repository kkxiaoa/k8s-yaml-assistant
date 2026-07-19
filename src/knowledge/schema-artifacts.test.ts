import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSchemaArtifactManifest,
  writeSchemaArtifacts,
  type SchemaArtifactSnapshot,
} from './schema-artifacts';

function snapshot(
  resources: Record<string, unknown>,
  definitions: Record<string, unknown> = {},
): SchemaArtifactSnapshot {
  return {
    source: 'cluster',
    resources: new Map(Object.entries(resources)),
    definitions: new Map(Object.entries(definitions)),
  };
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

console.log('schema artifact ownership:');

check('只删除上一份 manifest 明确拥有的陈旧文件', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'schema-artifacts-owned-'));
  try {
    writeSchemaArtifacts(
      snapshot(
        {
          'apps.v1.Deployment.json': { revision: 1 },
          'core.v1.Pod.json': { revision: 1 },
        },
        { 'io.k8s.PodSpec.json': { type: 'object' } },
      ),
      outDir,
    );
    writeFileSync(join(outDir, 'resources', 'user-note.json'), '{"keep":true}\n');
    writeFileSync(join(outDir, 'resources', 'README.txt'), 'keep\n');

    const result = writeSchemaArtifacts(
      snapshot({ 'core.v1.Pod.json': { revision: 2 } }),
      outDir,
    );

    assert.deepEqual(result.removedFiles, [
      'definitions/io.k8s.PodSpec.json',
      'resources/apps.v1.Deployment.json',
    ]);
    assert.equal(
      readFileSync(join(outDir, 'resources', 'core.v1.Pod.json'), 'utf8'),
      '{\n  "revision": 2\n}\n',
    );
    assert.equal(
      readFileSync(join(outDir, 'resources', 'user-note.json'), 'utf8'),
      '{"keep":true}\n',
    );
    assert.equal(
      readFileSync(join(outDir, 'resources', 'README.txt'), 'utf8'),
      'keep\n',
    );
    assert.equal(
      existsSync(join(outDir, 'resources', 'apps.v1.Deployment.json')),
      false,
    );
    assert.equal(
      existsSync(join(outDir, 'definitions', 'io.k8s.PodSpec.json')),
      false,
    );

    const manifest = readSchemaArtifactManifest(outDir);
    assert.deepEqual(manifest.ownedFiles, {
      resources: ['core.v1.Pod.json'],
      definitions: [],
    });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

check('未归属文件发生目标冲突时在写盘前拒绝', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'schema-artifacts-collision-'));
  try {
    writeSchemaArtifacts(
      snapshot({ 'core.v1.Pod.json': { revision: 1 } }),
      outDir,
    );
    const manifestBefore = readFileSync(join(outDir, 'manifest.json'), 'utf8');
    writeFileSync(join(outDir, 'resources', 'user.json'), '{"owner":"user"}\n');

    assert.throws(
      () =>
        writeSchemaArtifacts(
          snapshot({
            'core.v1.Pod.json': { revision: 2 },
            'user.json': { owner: 'ingestion' },
          }),
          outDir,
        ),
      /unowned target collision.*resources\/user\.json/,
    );
    assert.equal(
      readFileSync(join(outDir, 'resources', 'core.v1.Pod.json'), 'utf8'),
      '{\n  "revision": 1\n}\n',
    );
    assert.equal(
      readFileSync(join(outDir, 'resources', 'user.json'), 'utf8'),
      '{"owner":"user"}\n',
    );
    assert.equal(readFileSync(join(outDir, 'manifest.json'), 'utf8'), manifestBefore);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

check('旧 manifest 不会被猜测为当前所有权', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'schema-artifacts-legacy-'));
  try {
    mkdirSync(join(outDir, 'resources'));
    mkdirSync(join(outDir, 'definitions'));
    writeFileSync(
      join(outDir, 'manifest.json'),
      `${JSON.stringify({
        generatedAt: '2026-06-21T14:34:13.174Z',
        resources: 1,
        definitions: 0,
        layout: 'resources+definitions',
      })}\n`,
    );
    writeFileSync(join(outDir, 'resources', 'legacy.json'), '{"keep":true}\n');

    assert.throws(
      () =>
        writeSchemaArtifacts(
          snapshot({ 'core.v1.Pod.json': { revision: 1 } }),
          outDir,
        ),
      /manifest does not declare safe artifact ownership/,
    );
    assert.equal(
      readFileSync(join(outDir, 'resources', 'legacy.json'), 'utf8'),
      '{"keep":true}\n',
    );
    assert.equal(
      existsSync(join(outDir, 'resources', 'core.v1.Pod.json')),
      false,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

check('无 manifest 的非空目录和越界文件名都会失败关闭', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'schema-artifacts-unowned-'));
  const unsafeDir = mkdtempSync(join(tmpdir(), 'schema-artifacts-path-'));
  try {
    mkdirSync(join(outDir, 'resources'));
    writeFileSync(join(outDir, 'resources', 'user.json'), '{"keep":true}\n');
    assert.throws(
      () =>
        writeSchemaArtifacts(
          snapshot({ 'core.v1.Pod.json': { revision: 1 } }),
          outDir,
        ),
      /cannot establish artifact ownership for non-empty output/,
    );
    assert.throws(
      () =>
        writeSchemaArtifacts(
          snapshot({ '../escape.json': { unsafe: true } }),
          unsafeDir,
        ),
      /invalid resource artifact filename/,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(unsafeDir, { recursive: true, force: true });
  }
});

console.log(`\n通过 ${passed} 项`);
