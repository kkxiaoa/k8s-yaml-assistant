import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveTuningEligibleCasesById } from '../src/eval/cases/governance';
import type { SemanticRetrievalCase } from '../src/eval/cases/retrieval-cases';
import {
  DEFAULT_ALIAS_DRAFT_DIR,
  DEFAULT_ALIASES_PATH,
  parseSchemaFieldAliasesJsonl,
  serializeSchemaFieldAliasesJsonl,
} from '../src/retrieval/query-expansion';

function runChecker(...args: string[]): string {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/check-schema-aliases.ts', ...args],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

mkdirSync(DEFAULT_ALIAS_DRAFT_DIR, { recursive: true });
const directory = mkdtempSync(join(DEFAULT_ALIAS_DRAFT_DIR, '.check-test-'));
const draftPath = join(directory, 'schema-field-aliases.test.jsonl');
const registryBefore = readFileSync(DEFAULT_ALIASES_PATH, 'utf8');

const holdoutCase: SemanticRetrievalCase = {
  id: 'alias-holdout',
  governance: {
    task: 'field_explanation',
    origin: 'human',
    role: 'holdout',
  },
  question: 'holdout question',
  expectedChunkIds: ['Chunk::holdout'],
  target: { kind: 'Pod' },
};
assert.throws(
  () =>
    resolveTuningEligibleCasesById(
      [holdoutCase.id],
      [holdoutCase],
      'alias target target-holdout',
    ),
  /alias target target-holdout.*holdout/i,
);

try {
  const aliases = parseSchemaFieldAliasesJsonl(registryBefore);
  const first = aliases[0];
  assert.ok(first);
  aliases[0] = { ...first, reviewNote: 'preview-only test change' };
  writeFileSync(draftPath, serializeSchemaFieldAliasesJsonl(aliases));

  const checked = runChecker('--draft', draftPath);
  assert.match(checked, /draft: 11 reviewed \/ 0 unreviewed/);

  const previewed = runChecker('--review', draftPath);
  assert.match(previewed, /merge: 0 added \/ 1 updated \/ 10 unchanged/);
  assert.match(previewed, /preview only: 正式 registry 未修改/);
  assert.equal(readFileSync(DEFAULT_ALIASES_PATH, 'utf8'), registryBefore);

  const unsafe = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/check-schema-aliases.ts',
      '--review',
      DEFAULT_ALIASES_PATH,
      '--apply',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /draft 必须是 .*data\/aliases\/drafts/);
  assert.equal(readFileSync(DEFAULT_ALIASES_PATH, 'utf8'), registryBefore);
  console.log('schema alias review: draft validation and preview boundary verified');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
