import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendTraceEnvelope,
  baselinePath,
  evalArtifactPath,
  readTraceEnvelopes,
  runPath,
  traceRelativePath,
  writeJsonAtomic,
} from './artifacts';
import { EVAL_SCHEMA_VERSION, type TraceEnvelope } from './protocol';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(
      `  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exitCode = 1;
  }
}

console.log('eval-artifacts:');

const GOVERNANCE = {
  task: 'field_explanation',
  origin: 'human',
  role: 'development',
} as const;

function traceFixture(
  traceId = 'trace-1',
  evalCaseId = 'case-1',
): TraceEnvelope<'faith', { rank: number }> {
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    traceId,
    runId: 'run-1',
    evalCaseId,
    governance: GOVERNANCE,
    kind: 'faith',
    createdAt: '2026-07-12T01:00:00.000Z',
    outcome: 'success',
    payload: { rank: 1 },
  };
}

check('trace artifact uses a POSIX path relative to the eval root', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'kya-eval-root-'));
  const relativePath = traceRelativePath('run-1', 'faith');

  assert.equal(relativePath, 'traces/run-1.faith.jsonl');
  assert.equal(
    evalArtifactPath(relativePath, evalRoot),
    join(evalRoot, 'traces', 'run-1.faith.jsonl'),
  );
});

check('artifact resolver rejects absolute, traversal, and non-POSIX paths', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'kya-eval-root-'));
  for (const path of [
    '/tmp/outside.json',
    '../outside.json',
    'traces/../../outside.json',
    'traces\\..\\outside.json',
    'C:\\outside.json',
    'C:/outside.json',
    '\\\\server\\share\\outside.json',
    './traces/run-1.jsonl',
    'traces//run-1.jsonl',
    'traces/\0outside.json',
  ]) {
    assert.throws(() => evalArtifactPath(path, evalRoot), path);
  }
});

check('portable path builders reject invalid run IDs and eval kinds', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'kya-eval-root-'));
  assert.throws(() => traceRelativePath('../run-1', 'faith'));
  assert.throws(() => runPath('run/1', evalRoot));
  assert.throws(() => runPath(undefined as never, evalRoot));
  assert.throws(() => traceRelativePath('run-1', 'unknown' as never));
  assert.throws(() => baselinePath('unknown' as never, evalRoot));
});

check('the same relative artifact resolves under a moved eval root', () => {
  const firstRoot = mkdtempSync(join(tmpdir(), 'kya-eval-root-a-'));
  const secondRoot = mkdtempSync(join(tmpdir(), 'kya-eval-root-b-'));
  const relativePath = traceRelativePath('run-1', 'retrieval');

  assert.equal(
    evalArtifactPath(relativePath, firstRoot),
    join(firstRoot, 'traces', 'run-1.retrieval.jsonl'),
  );
  assert.equal(
    evalArtifactPath(relativePath, secondRoot),
    join(secondRoot, 'traces', 'run-1.retrieval.jsonl'),
  );
  assert.notEqual(
    evalArtifactPath(relativePath, firstRoot),
    evalArtifactPath(relativePath, secondRoot),
  );
});

check('run and baseline paths use the portable eval directory layout', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'kya-eval-root-'));
  assert.equal(runPath('run-1', evalRoot), join(evalRoot, 'runs', 'run-1.json'));

  for (const kind of [
    'retrieval',
    'faith',
    'judge',
    'generation',
    'fix',
  ] as const) {
    assert.equal(
      baselinePath(kind, evalRoot),
      join(evalRoot, 'baselines', `${kind}.json`),
    );
  }
  assert.equal(
    baselinePath('faith'),
    join(process.cwd(), 'data', 'eval', 'baselines', 'faith.json'),
  );
});

check('atomic JSON write replaces the target without leaving temp files', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'kya-eval-root-'));
  const path = runPath('run-1', evalRoot);

  writeJsonAtomic(path, { version: 1 });
  writeJsonAtomic(path, { version: 2 });

  assert.equal(readFileSync(path, 'utf8'), '{\n  "version": 2\n}\n');
  assert.deepEqual(readdirSync(join(evalRoot, 'runs')), ['run-1.json']);
});

check('atomic JSON write preserves the old target and cleans temp on failure', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'kya-eval-root-'));
  const path = runPath('run-1', evalRoot);
  writeJsonAtomic(path, { version: 1 });

  assert.throws(() => writeJsonAtomic(path, { value: BigInt(1) }));
  assert.equal(readFileSync(path, 'utf8'), '{\n  "version": 1\n}\n');

  const directoryTarget = join(evalRoot, 'runs', 'directory.json');
  mkdirSync(directoryTarget);
  assert.throws(() => writeJsonAtomic(directoryTarget, { version: 2 }));
  assert.deepEqual(readdirSync(join(evalRoot, 'runs')).sort(), [
    'directory.json',
    'run-1.json',
  ]);
});

check('TraceEnvelope append/read validates and preserves line order', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'kya-eval-root-'));
  const path = evalArtifactPath(
    traceRelativePath('run-1', 'faith'),
    evalRoot,
  );
  const first = traceFixture('trace-1', 'case-1');
  const second = traceFixture('trace-2', 'case-2');

  appendTraceEnvelope(path, first);
  appendTraceEnvelope(path, second);

  assert.deepEqual(readTraceEnvelopes(path), [first, second]);
});

check('TraceEnvelope append rejects an invalid envelope before creating a file', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'kya-eval-root-'));
  const path = evalArtifactPath(
    traceRelativePath('run-1', 'faith'),
    evalRoot,
  );
  const invalid = { ...traceFixture() } as Partial<TraceEnvelope>;
  delete invalid.runId;

  assert.throws(() => appendTraceEnvelope(path, invalid as TraceEnvelope));
  assert.equal(existsSync(path), false);
});

check('TraceEnvelope reader rejects an empty trace file', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'kya-eval-root-'));
  const path = evalArtifactPath(
    traceRelativePath('run-1', 'faith'),
    evalRoot,
  );
  mkdirSync(join(evalRoot, 'traces'), { recursive: true });
  writeFileSync(path, '');

  assert.throws(() => readTraceEnvelopes(path), /empty trace file/);
});

check('TraceEnvelope reader reports malformed and invalid lines', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'kya-eval-root-'));
  const malformedPath = evalArtifactPath('traces/malformed.faith.jsonl', evalRoot);
  const invalidPath = evalArtifactPath('traces/invalid.faith.jsonl', evalRoot);
  mkdirSync(join(evalRoot, 'traces'), { recursive: true });
  writeFileSync(
    malformedPath,
    `${JSON.stringify(traceFixture())}\n{"traceId":\n`,
  );
  writeFileSync(
    invalidPath,
    `${JSON.stringify({ ...traceFixture(), kind: undefined })}\n`,
  );

  assert.throws(
    () => readTraceEnvelopes(malformedPath),
    /invalid trace JSONL line 2/,
  );
  assert.throws(
    () => readTraceEnvelopes(invalidPath),
    /invalid trace JSONL line 1/,
  );
});

check('TraceEnvelope reader rejects duplicate trace IDs', () => {
  const evalRoot = mkdtempSync(join(tmpdir(), 'kya-eval-root-'));
  const path = evalArtifactPath(
    traceRelativePath('run-1', 'faith'),
    evalRoot,
  );

  appendTraceEnvelope(path, traceFixture('trace-1', 'case-1'));
  appendTraceEnvelope(path, traceFixture('trace-1', 'case-2'));

  assert.throws(
    () => readTraceEnvelopes(path),
    /duplicate traceId trace-1 at line 2/,
  );
});

console.log(`\n通过 ${passed} 项`);
