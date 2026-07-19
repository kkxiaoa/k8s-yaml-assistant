import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const output = execFileSync(
  process.execPath,
  ['--import', 'tsx', 'scripts/check-schemas.ts'],
  { cwd: process.cwd(), encoding: 'utf8' },
);

assert.match(
  output,
  /schema check passed: 28 curated resource\(s\), \d+ definition\(s\) loaded/,
);
console.log('schema check: lazy local reference gate verified');
