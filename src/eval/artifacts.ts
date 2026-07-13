import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import {
  EvalKindSchema,
  decodeTraceEnvelope,
  type EvalKind,
  type TraceEnvelope,
} from './protocol';

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;
const DEFAULT_EVAL_ROOT = join(process.cwd(), 'data', 'eval');

function assertRunId(runId: string): void {
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) {
    throw new Error(`invalid eval run id: ${String(runId)}`);
  }
}

function assertEvalKind(kind: EvalKind): void {
  if (!EvalKindSchema.safeParse(kind).success) {
    throw new Error(`invalid eval kind: ${String(kind)}`);
  }
}

export function evalArtifactPath(
  relativePath: string,
  evalRoot = DEFAULT_EVAL_ROOT,
): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    posix.isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath) ||
    WINDOWS_DRIVE_PREFIX.test(relativePath)
  ) {
    throw new Error(`invalid eval artifact path: ${relativePath}`);
  }

  const segments = relativePath.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new Error(`invalid eval artifact path: ${relativePath}`);
  }

  const root = resolve(evalRoot);
  const artifactPath = resolve(root, ...segments);
  const relativeToRoot = relative(root, artifactPath);
  if (
    relativeToRoot === '..' ||
    relativeToRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativeToRoot)
  ) {
    throw new Error(`eval artifact path escapes root: ${relativePath}`);
  }
  return artifactPath;
}

export function traceRelativePath(runId: string, kind: EvalKind): string {
  assertRunId(runId);
  assertEvalKind(kind);
  return `traces/${runId}.${kind}.jsonl`;
}

export function runPath(runId: string, evalRoot = DEFAULT_EVAL_ROOT): string {
  assertRunId(runId);
  return evalArtifactPath(`runs/${runId}.json`, evalRoot);
}

export function baselinePath(
  kind: EvalKind,
  evalRoot = DEFAULT_EVAL_ROOT,
): string {
  assertEvalKind(kind);
  return evalArtifactPath(`baselines/${kind}.json`, evalRoot);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError('value is not JSON-serializable');
  }

  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const tempPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    writeFileSync(tempPath, `${serialized}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function appendTraceEnvelope(
  path: string,
  envelope: TraceEnvelope,
): void {
  const decoded = decodeTraceEnvelope(envelope);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(decoded)}\n`);
}

export function readTraceEnvelopes(path: string): TraceEnvelope[] {
  const content = readFileSync(path, 'utf8');
  if (content.trim().length === 0) {
    throw new Error(`empty trace file: ${path}`);
  }

  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();

  const traceIds = new Set<string>();
  const envelopes: TraceEnvelope[] = [];
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = lines[index]!;
    if (line.trim().length === 0) {
      throw new Error(`invalid trace JSONL line ${lineNumber}: empty line`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `invalid trace JSONL line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    let envelope: TraceEnvelope;
    try {
      envelope = decodeTraceEnvelope(parsed);
    } catch (error) {
      throw new Error(
        `invalid trace JSONL line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    if (traceIds.has(envelope.traceId)) {
      throw new Error(
        `duplicate traceId ${envelope.traceId} at line ${lineNumber}`,
      );
    }
    traceIds.add(envelope.traceId);
    envelopes.push(envelope);
  }
  return envelopes;
}
