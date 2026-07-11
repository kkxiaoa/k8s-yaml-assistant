import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EVAL_DIR, type EvalKind } from './run-store';

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId === '.' || runId === '..') {
    throw new Error(`invalid eval run id: ${runId}`);
  }
}

export function tracePathForRun(runId: string, kind: EvalKind): string {
  assertRunId(runId);
  return join(EVAL_DIR, 'traces', `${runId}.${kind}.jsonl`);
}

export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
