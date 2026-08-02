import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSchemaArtifactManifest } from '../src/knowledge/schema-artifacts';

function writeInput(directory: string, kind: string): void {
  writeFileSync(
    join(directory, `${kind}.json`),
    `${JSON.stringify({
      resource: kind,
      kind,
      apiVersion: 'v1',
      source: 'builtin',
      schema: { type: 'object', properties: { spec: { type: 'object' } } },
    })}\n`,
  );
}

function ingest(input: string, outDir: string): void {
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/ingest-schemas.ts',
      '--source',
      'dir',
      '--input',
      input,
      '--out',
      outDir,
    ],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
}

const root = mkdtempSync(join(tmpdir(), 'ingest-schemas-integration-'));
const input = join(root, 'input');
const outDir = join(root, 'generated');
mkdirSync(input);

try {
  writeInput(input, 'Pod');
  writeInput(input, 'Service');
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/ingest-schemas.ts',
          '--source',
          'dir',
          '--input',
          input,
        ],
        { cwd: process.cwd(), stdio: 'pipe' },
      ),
    /Missing --out/u,
  );
  ingest(input, outDir);
  assert.equal(existsSync(join(outDir, 'resources', 'core.v1.Pod.json')), true);
  assert.equal(
    existsSync(join(outDir, 'resources', 'core.v1.Service.json')),
    true,
  );

  rmSync(join(input, 'Service.json'));
  ingest(input, outDir);
  assert.equal(existsSync(join(outDir, 'resources', 'core.v1.Pod.json')), true);
  assert.equal(
    existsSync(join(outDir, 'resources', 'core.v1.Service.json')),
    false,
  );
  assert.deepEqual(readSchemaArtifactManifest(outDir).ownedFiles, {
    resources: ['core.v1.Pod.json'],
    definitions: [],
  });
  console.log('ingest schemas: stale owned resource cleanup verified');
} finally {
  rmSync(root, { recursive: true, force: true });
}
