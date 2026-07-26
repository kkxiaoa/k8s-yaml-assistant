import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function githubOutputs(path: string): Map<string, string> {
  return new Map(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
}

test('index-identity emits only workflow-consumed outputs', () => {
  const tempDir = mkdtempSync(
    join(tmpdir(), 'k8s-yaml-assistant-release-manifest-'),
  );
  const outputPath = join(tempDir, 'github-output');

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/release-manifest.ts',
        'index-identity',
        '--github-output',
        outputPath,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    assert.equal(
      result.status,
      0,
      `index-identity failed:\n${result.stderr}`,
    );
    const outputs = githubOutputs(outputPath);
    assert.deepEqual([...outputs.keys()].sort(), [
      'embedding_model',
      'index_hash',
      'index_image',
      'index_tag',
    ]);
    assert.equal(outputs.get('embedding_model'), 'voyage-3');

    const overridden = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/release-manifest.ts',
        'index-identity',
        '--embedding-model',
        'voyage-4',
        '--github-output',
        outputPath,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    assert.notEqual(overridden.status, 0);
    assert.match(overridden.stderr, /unknown.*--embedding-model/u);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('prepare emits only the release notes identity consumed by the workflow', () => {
  const tempDir = mkdtempSync(
    join(tmpdir(), 'k8s-yaml-assistant-release-prepare-'),
  );
  const outputPath = join(tempDir, 'github-output');
  const releasePath = join(tempDir, 'release.json');
  const sourceCommit = 'a'.repeat(40);
  const version = (
    JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  ).version;
  writeFileSync(
    releasePath,
    JSON.stringify({
      name: version,
      tagName: `v${version}`,
      targetCommitish: sourceCommit,
      isDraft: true,
      isPrerelease: false,
      body: [
        '### Features',
        '',
        '- Build verified release evidence.',
        '',
        '### Known limitations',
        '',
        '- Production deployment is not enabled.',
        '',
      ].join('\n'),
      assets: [],
    }),
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/release-manifest.ts',
        'prepare',
        '--release-json',
        releasePath,
        '--source-sha',
        sourceCommit,
        '--github-output',
        outputPath,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, `prepare failed:\n${result.stderr}`);
    assert.deepEqual([...githubOutputs(outputPath).keys()], [
      'release_notes_sha256',
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
