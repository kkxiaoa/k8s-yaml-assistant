import assert from 'node:assert/strict';
import {
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { canonicalJson } from '../shared/json';
import {
  NODE_LOCAL_SINK_FILE_SYSTEM,
  createLocalObservationSink,
  type LocalSinkFileSystem,
  type LocalSinkOptions,
} from './local-sink';
import type { ServingRetrievalObservation } from './serving-observation';

const FIXED_NOW = new Date('2026-07-21T12:00:00.000Z');
const RAW_FAILURE_DETAIL = 'TestLocalSinkFailureSecret123';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryRoot(): { base: string; rootDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'serving-local-sink-'));
  temporaryDirectories.push(base);
  return { base, rootDir: join(base, 'observability') };
}

function observation(
  observationId = '11111111-1111-4111-8111-111111111111',
): ServingRetrievalObservation {
  return {
    schemaVersion: 'serving-observation/v1',
    observationId,
    requestId: '22222222-2222-4222-8222-222222222222',
    createdAt: '2026-07-21T12:00:00.000Z',
    kind: 'retrieval',
    route: { mode: 'free', path: 'search' },
    query: {
      disposition: 'redacted',
      text: '解释 Deployment 的 replicas 字段',
      redactionVersion: 'serving-redaction/v1',
      redactionLabels: [],
    },
    ranking: { coarse: [], rerank: [], final: [] },
    latencyMs: { total: 3 },
  };
}

function options(
  rootDir: string,
  overrides: Partial<LocalSinkOptions> = {},
): LocalSinkOptions {
  return {
    rootDir,
    maxFileBytes: 4096,
    maxTotalBytes: 16_384,
    retentionDays: 7,
    clock: () => FIXED_NOW,
    ...overrides,
  };
}

function requiredSink(sinkOptions: LocalSinkOptions) {
  const result = createLocalObservationSink(sinkOptions);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('unreachable local sink creation failure');
  return result.sink;
}

function managedFiles(rootDir: string): string[] {
  return readdirSync(rootDir)
    .filter((name) =>
      /^serving-observations\.\d{4}-\d{2}-\d{2}\.\d{4}\.jsonl$/u.test(
        name,
      ),
    )
    .sort();
}

function createManagedFile(
  rootDir: string,
  name: string,
  byteLength: number,
): void {
  writeFileSync(join(rootDir, name), Buffer.alloc(byteLength, 0x78), {
    flag: 'wx',
    mode: 0o600,
  });
}

test('writes one canonical JSON object per line synchronously with restrictive permissions', () => {
  const { rootDir } = temporaryRoot();
  const openedFlags: number[] = [];
  const fileSystem: LocalSinkFileSystem = {
    ...NODE_LOCAL_SINK_FILE_SYSTEM,
    open(path, flags, mode) {
      openedFlags.push(flags);
      return NODE_LOCAL_SINK_FILE_SYSTEM.open(path, flags, mode);
    },
  };
  const sink = requiredSink(options(rootDir, { fileSystem }));
  const first = observation();
  const second = observation('33333333-3333-4333-8333-333333333333');

  const firstResult = sink.append(first);
  const secondResult = sink.append(second);

  assert.deepEqual(firstResult, { ok: true });
  assert.deepEqual(secondResult, { ok: true });
  assert.equal(firstResult instanceof Promise, false);
  assert.deepEqual(managedFiles(rootDir), [
    'serving-observations.2026-07-21.0001.jsonl',
  ]);
  const path = join(rootDir, managedFiles(rootDir)[0]!);
  assert.equal(
    readFileSync(path, 'utf8'),
    `${canonicalJson(first)}\n${canonicalJson(second)}\n`,
  );
  assert.equal(lstatSync(rootDir).mode & 0o777, 0o700);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);

  const createFlags = openedFlags.find(
    (flags) => (flags & constants.O_CREAT) !== 0,
  )!;
  assert.notEqual(createFlags & constants.O_CREAT, 0);
  assert.notEqual(createFlags & constants.O_EXCL, 0);
  assert.notEqual(createFlags & constants.O_APPEND, 0);
  assert.notEqual(createFlags & constants.O_WRONLY, 0);
  assert.notEqual(createFlags & constants.O_NOFOLLOW, 0);

  const existingFlags = openedFlags.find(
    (flags) =>
      (flags & constants.O_CREAT) === 0 &&
      (flags & constants.O_APPEND) !== 0,
  )!;
  assert.equal(existingFlags & constants.O_CREAT, 0);
  assert.equal(existingFlags & constants.O_EXCL, 0);
  assert.notEqual(existingFlags & constants.O_APPEND, 0);
  assert.notEqual(existingFlags & constants.O_WRONLY, 0);
  assert.notEqual(existingFlags & constants.O_NOFOLLOW, 0);
  assert.equal('fsync' in NODE_LOCAL_SINK_FILE_SYSTEM, false);
});

test('strictly decodes before writing and rejects an oversized line without creating a segment', () => {
  const invalidRoot = temporaryRoot().rootDir;
  const invalidSink = requiredSink(options(invalidRoot));
  const invalid = { ...observation(), rawQuestion: RAW_FAILURE_DETAIL };

  assert.deepEqual(invalidSink.append(invalid), {
    ok: false,
    error: { code: 'observation_invalid' },
  });
  assert.deepEqual(managedFiles(invalidRoot), []);

  const oversizedRoot = temporaryRoot().rootDir;
  const lineBytes = Buffer.byteLength(
    `${canonicalJson(observation())}\n`,
    'utf8',
  );
  const oversizedSink = requiredSink(
    options(oversizedRoot, {
      maxFileBytes: lineBytes - 1,
      maxTotalBytes: lineBytes - 1,
    }),
  );

  assert.deepEqual(oversizedSink.append(observation()), {
    ok: false,
    error: { code: 'observation_too_large' },
  });
  assert.deepEqual(managedFiles(oversizedRoot), []);
});

test('rotates on the byte boundary and UTC date boundary with fixed-width sequences', () => {
  const { rootDir } = temporaryRoot();
  let now = new Date('2026-07-21T23:59:00.000Z');
  const lineBytes = Buffer.byteLength(
    `${canonicalJson(observation())}\n`,
    'utf8',
  );
  const sink = requiredSink(
    options(rootDir, {
      maxFileBytes: lineBytes * 2 - 1,
      maxTotalBytes: lineBytes * 8,
      clock: () => now,
    }),
  );

  assert.deepEqual(sink.append(observation()), { ok: true });
  assert.deepEqual(
    sink.append(observation('33333333-3333-4333-8333-333333333333')),
    { ok: true },
  );
  now = new Date('2026-07-22T00:01:00.000Z');
  assert.deepEqual(
    sink.append(observation('44444444-4444-4444-8444-444444444444')),
    { ok: true },
  );

  assert.deepEqual(managedFiles(rootDir), [
    'serving-observations.2026-07-21.0001.jsonl',
    'serving-observations.2026-07-21.0002.jsonl',
    'serving-observations.2026-07-22.0001.jsonl',
  ]);
});

test('a new sink instance starts a new segment instead of extending prior writer state', () => {
  const { rootDir } = temporaryRoot();
  const firstSink = requiredSink(options(rootDir));
  assert.deepEqual(firstSink.append(observation()), { ok: true });

  const restartedSink = requiredSink(options(rootDir));
  assert.deepEqual(
    restartedSink.append(
      observation('33333333-3333-4333-8333-333333333333'),
    ),
    { ok: true },
  );

  assert.deepEqual(managedFiles(rootDir), [
    'serving-observations.2026-07-21.0001.jsonl',
    'serving-observations.2026-07-21.0002.jsonl',
  ]);
});

test('initial cleanup applies calendar-day retention and total bytes in stable order', () => {
  const { base, rootDir } = temporaryRoot();
  mkdirSync(rootDir, { mode: 0o700 });
  createManagedFile(
    rootDir,
    'serving-observations.2026-07-10.0001.jsonl',
    10,
  );
  for (const sequence of ['0001', '0002', '0003']) {
    createManagedFile(
      rootDir,
      `serving-observations.2026-07-20.${sequence}.jsonl`,
      20,
    );
  }
  writeFileSync(join(rootDir, 'notes.txt'), 'keep');
  mkdirSync(join(rootDir, 'serving-observations.not-managed'));
  const symlinkTarget = join(base, 'unmanaged-target');
  writeFileSync(symlinkTarget, 'keep target');
  symlinkSync(symlinkTarget, join(rootDir, 'unmanaged-link'));

  const result = createLocalObservationSink(
    options(rootDir, {
      maxFileBytes: 40,
      maxTotalBytes: 40,
      retentionDays: 7,
    }),
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(managedFiles(rootDir), [
    'serving-observations.2026-07-20.0002.jsonl',
    'serving-observations.2026-07-20.0003.jsonl',
  ]);
  assert.equal(readFileSync(join(rootDir, 'notes.txt'), 'utf8'), 'keep');
  assert.equal(lstatSync(join(rootDir, 'unmanaged-link')).isSymbolicLink(), true);
  assert.equal(
    lstatSync(join(rootDir, 'serving-observations.not-managed')).isDirectory(),
    true,
  );
});

test('rotates and cleans old segments before an append would exceed total bytes', () => {
  const { rootDir } = temporaryRoot();
  const lineBytes = Buffer.byteLength(
    `${canonicalJson(observation())}\n`,
    'utf8',
  );
  const sink = requiredSink(
    options(rootDir, {
      maxFileBytes: lineBytes * 2 + 10,
      maxTotalBytes: lineBytes * 2 + 10,
    }),
  );

  assert.deepEqual(sink.append(observation()), { ok: true });
  assert.deepEqual(
    sink.append(observation('33333333-3333-4333-8333-333333333333')),
    { ok: true },
  );
  assert.deepEqual(
    sink.append(observation('44444444-4444-4444-8444-444444444444')),
    { ok: true },
  );

  assert.deepEqual(managedFiles(rootDir), [
    'serving-observations.2026-07-21.0002.jsonl',
  ]);
  const content = readFileSync(join(rootDir, managedFiles(rootDir)[0]!), 'utf8');
  assert.equal(content.split('\n').filter(Boolean).length, 1);
  assert.ok(Buffer.byteLength(content, 'utf8') <= lineBytes * 2 + 10);
});

test('rejects a symlink root and managed-name symlink without deleting either target', () => {
  const rootLinkCase = temporaryRoot();
  const realRoot = join(rootLinkCase.base, 'real-observability');
  mkdirSync(realRoot, { mode: 0o700 });
  symlinkSync(realRoot, rootLinkCase.rootDir);

  assert.deepEqual(createLocalObservationSink(options(rootLinkCase.rootDir)), {
    ok: false,
    error: { code: 'root_unsafe' },
  });

  const segmentLinkCase = temporaryRoot();
  mkdirSync(segmentLinkCase.rootDir, { mode: 0o700 });
  const target = join(segmentLinkCase.base, 'segment-target');
  writeFileSync(target, 'do not delete');
  const link = join(
    segmentLinkCase.rootDir,
    'serving-observations.2026-07-20.0001.jsonl',
  );
  symlinkSync(target, link);

  assert.deepEqual(createLocalObservationSink(options(segmentLinkCase.rootDir)), {
    ok: false,
    error: { code: 'segment_unsafe' },
  });
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(target, 'utf8'), 'do not delete');
});

test('rejects replacement of the initialized root directory identity', () => {
  const { rootDir } = temporaryRoot();
  const sink = requiredSink(options(rootDir));
  rmSync(rootDir, { recursive: true });
  mkdirSync(rootDir, { mode: 0o700 });

  assert.deepEqual(sink.append(observation()), {
    ok: false,
    error: { code: 'root_unsafe' },
  });
  assert.deepEqual(readdirSync(rootDir), []);
});

test('pins the initialized root directory with a no-follow directory descriptor', () => {
  const { rootDir } = temporaryRoot();
  let rootDescriptor: number | undefined;
  let rootDescriptorClosed = false;
  const fileSystem: LocalSinkFileSystem = {
    ...NODE_LOCAL_SINK_FILE_SYSTEM,
    open(path, flags, mode) {
      const descriptor = NODE_LOCAL_SINK_FILE_SYSTEM.open(path, flags, mode);
      if (path === rootDir) {
        rootDescriptor = descriptor;
        assert.notEqual(flags & constants.O_DIRECTORY, 0);
        assert.notEqual(flags & constants.O_NOFOLLOW, 0);
      }
      return descriptor;
    },
    close(fileDescriptor) {
      if (fileDescriptor === rootDescriptor) rootDescriptorClosed = true;
      NODE_LOCAL_SINK_FILE_SYSTEM.close(fileDescriptor);
    },
  };

  requiredSink(options(rootDir, { fileSystem }));

  assert.notEqual(rootDescriptor, undefined);
  assert.equal(rootDescriptorClosed, false);
});

test('exclusive creation never overwrites a segment introduced after initialization', () => {
  const { rootDir } = temporaryRoot();
  let collisionCreated = false;
  const fileSystem: LocalSinkFileSystem = {
    ...NODE_LOCAL_SINK_FILE_SYSTEM,
    open(path, flags, mode) {
      if (!collisionCreated && (flags & constants.O_CREAT) !== 0) {
        collisionCreated = true;
        writeFileSync(path, 'collision sentinel', { flag: 'wx', mode: 0o600 });
      }
      return NODE_LOCAL_SINK_FILE_SYSTEM.open(path, flags, mode);
    },
  };
  const sink = requiredSink(options(rootDir, { fileSystem }));

  const result = sink.append(observation());

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'segment_create_failed' },
  });
  assert.equal(
    readFileSync(
      join(rootDir, 'serving-observations.2026-07-21.0001.jsonl'),
      'utf8',
    ),
    'collision sentinel',
  );
  assert.equal(JSON.stringify(result).includes(RAW_FAILURE_DETAIL), false);
});

test('open, write, and cleanup faults return fixed errors without leaking causes', () => {
  const writeCase = temporaryRoot();
  const writeFileSystem: LocalSinkFileSystem = {
    ...NODE_LOCAL_SINK_FILE_SYSTEM,
    write() {
      throw new Error(RAW_FAILURE_DETAIL);
    },
  };
  const writeSink = requiredSink(
    options(writeCase.rootDir, { fileSystem: writeFileSystem }),
  );
  const writeResult = writeSink.append(observation());
  assert.deepEqual(writeResult, {
    ok: false,
    error: { code: 'segment_write_failed' },
  });
  assert.equal(JSON.stringify(writeResult).includes(RAW_FAILURE_DETAIL), false);

  const openCase = temporaryRoot();
  let failExistingOpen = false;
  const openFileSystem: LocalSinkFileSystem = {
    ...NODE_LOCAL_SINK_FILE_SYSTEM,
    open(path, flags, mode) {
      if (failExistingOpen && (flags & constants.O_CREAT) === 0) {
        throw new Error(RAW_FAILURE_DETAIL);
      }
      return NODE_LOCAL_SINK_FILE_SYSTEM.open(path, flags, mode);
    },
  };
  const openSink = requiredSink(
    options(openCase.rootDir, { fileSystem: openFileSystem }),
  );
  assert.deepEqual(openSink.append(observation()), { ok: true });
  failExistingOpen = true;
  const openResult = openSink.append(
    observation('33333333-3333-4333-8333-333333333333'),
  );
  assert.deepEqual(openResult, {
    ok: false,
    error: { code: 'segment_open_failed' },
  });
  assert.equal(JSON.stringify(openResult).includes(RAW_FAILURE_DETAIL), false);

  const cleanupCase = temporaryRoot();
  mkdirSync(cleanupCase.rootDir, { mode: 0o700 });
  createManagedFile(
    cleanupCase.rootDir,
    'serving-observations.2026-06-01.0001.jsonl',
    20,
  );
  const cleanupFileSystem: LocalSinkFileSystem = {
    ...NODE_LOCAL_SINK_FILE_SYSTEM,
    unlink() {
      throw new Error(RAW_FAILURE_DETAIL);
    },
  };
  const cleanupResult = createLocalObservationSink(
    options(cleanupCase.rootDir, { fileSystem: cleanupFileSystem }),
  );
  assert.deepEqual(cleanupResult, {
    ok: false,
    error: { code: 'cleanup_failed' },
  });
  assert.equal(JSON.stringify(cleanupResult).includes(RAW_FAILURE_DETAIL), false);
});

test('a rotation cleanup failure blocks the record and retries before later writes', () => {
  const { rootDir } = temporaryRoot();
  const lineBytes = Buffer.byteLength(
    `${canonicalJson(observation())}\n`,
    'utf8',
  );
  let failCleanup = false;
  const fileSystem: LocalSinkFileSystem = {
    ...NODE_LOCAL_SINK_FILE_SYSTEM,
    unlink(path) {
      if (failCleanup) throw new Error(RAW_FAILURE_DETAIL);
      NODE_LOCAL_SINK_FILE_SYSTEM.unlink(path);
    },
  };
  const sink = requiredSink(
    options(rootDir, {
      maxFileBytes: lineBytes * 2 + 10,
      maxTotalBytes: lineBytes * 2 + 10,
      fileSystem,
    }),
  );
  assert.deepEqual(sink.append(observation()), { ok: true });
  assert.deepEqual(
    sink.append(observation('33333333-3333-4333-8333-333333333333')),
    { ok: true },
  );

  failCleanup = true;
  assert.deepEqual(
    sink.append(observation('44444444-4444-4444-8444-444444444444')),
    { ok: false, error: { code: 'cleanup_failed' } },
  );
  assert.equal(
    readFileSync(
      join(rootDir, 'serving-observations.2026-07-21.0002.jsonl'),
      'utf8',
    ),
    '',
  );

  failCleanup = false;
  assert.deepEqual(
    sink.append(observation('55555555-5555-4555-8555-555555555555')),
    { ok: true },
  );
  assert.deepEqual(managedFiles(rootDir), [
    'serving-observations.2026-07-21.0002.jsonl',
  ]);
});

test('rolls a partial append back to the previous complete JSONL boundary', () => {
  const { rootDir } = temporaryRoot();
  let writeCalls = 0;
  let injectFailure = true;
  const fileSystem: LocalSinkFileSystem = {
    ...NODE_LOCAL_SINK_FILE_SYSTEM,
    write(fileDescriptor, data) {
      if (!injectFailure) {
        return NODE_LOCAL_SINK_FILE_SYSTEM.write(fileDescriptor, data);
      }
      if (++writeCalls === 1) {
        return NODE_LOCAL_SINK_FILE_SYSTEM.write(
          fileDescriptor,
          data.subarray(0, 7),
        );
      }
      injectFailure = false;
      throw new Error(RAW_FAILURE_DETAIL);
    },
  };
  const sink = requiredSink(options(rootDir, { fileSystem }));

  const result = sink.append(observation());

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'segment_write_failed' },
  });
  const path = join(rootDir, managedFiles(rootDir)[0]!);
  assert.equal(readFileSync(path, 'utf8'), '');

  const recovered = observation('33333333-3333-4333-8333-333333333333');
  assert.deepEqual(sink.append(recovered), { ok: true });
  assert.equal(readFileSync(path, 'utf8'), `${canonicalJson(recovered)}\n`);
});

test('fails closed when the daily fixed-width sequence is exhausted', () => {
  const { rootDir } = temporaryRoot();
  mkdirSync(rootDir, { mode: 0o700 });
  createManagedFile(
    rootDir,
    'serving-observations.2026-07-21.9999.jsonl',
    4096,
  );
  const sink = requiredSink(options(rootDir));

  assert.deepEqual(sink.append(observation()), {
    ok: false,
    error: { code: 'segment_sequence_exhausted' },
  });
  assert.deepEqual(managedFiles(rootDir), [
    'serving-observations.2026-07-21.9999.jsonl',
  ]);
});

test('rejects unsafe options and a pre-existing broad-permission root', () => {
  const relativeResult = createLocalObservationSink(
    options('data/observability'),
  );
  assert.deepEqual(relativeResult, {
    ok: false,
    error: { code: 'invalid_options' },
  });

  const { rootDir } = temporaryRoot();
  mkdirSync(rootDir, { mode: 0o700 });
  chmodSync(rootDir, 0o755);
  assert.deepEqual(createLocalObservationSink(options(rootDir)), {
    ok: false,
    error: { code: 'root_unsafe' },
  });
});
