import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { SERVING_OBSERVATION_HARD_LIMITS } from './config';
import { decodeServingRetrievalObservation } from './serving-observation';
import { canonicalJson } from '../shared/json';

const SEGMENT_PATTERN =
  /^serving-observations\.(\d{4}-\d{2}-\d{2})\.(\d{4})\.jsonl$/u;
const MAX_DAILY_SEGMENT_SEQUENCE = 9999;

export const LOCAL_SINK_ERROR_CODES = [
  'invalid_options',
  'clock_invalid',
  'root_setup_failed',
  'root_unsafe',
  'segment_unsafe',
  'segment_create_failed',
  'segment_open_failed',
  'segment_write_failed',
  'segment_sequence_exhausted',
  'cleanup_failed',
  'observation_invalid',
  'observation_too_large',
] as const;

export type LocalSinkErrorCode = (typeof LOCAL_SINK_ERROR_CODES)[number];

export type LocalSinkAppendResult =
  | { ok: true }
  | { ok: false; error: { code: LocalSinkErrorCode } };

export interface LocalObservationSink {
  append(value: unknown): LocalSinkAppendResult;
}

interface LocalSinkStats {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface LocalSinkFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): void;
  lstat(path: string): LocalSinkStats;
  readdir(path: string): string[];
  open(path: string, flags: number, mode?: number): number;
  fstat(fileDescriptor: number): LocalSinkStats;
  write(fileDescriptor: number, data: Uint8Array): number;
  truncate(fileDescriptor: number, length: number): void;
  close(fileDescriptor: number): void;
  unlink(path: string): void;
}

export const NODE_LOCAL_SINK_FILE_SYSTEM: LocalSinkFileSystem = Object.freeze({
  mkdir(path: string, options: { recursive: true; mode: number }) {
    mkdirSync(path, options);
  },
  lstat(path: string) {
    return lstatSync(path);
  },
  readdir(path: string) {
    return readdirSync(path);
  },
  open(path: string, flags: number, mode?: number) {
    return openSync(path, flags, mode);
  },
  fstat(fileDescriptor: number) {
    return fstatSync(fileDescriptor);
  },
  write(fileDescriptor: number, data: Uint8Array) {
    return writeSync(fileDescriptor, data);
  },
  truncate(fileDescriptor: number, length: number) {
    ftruncateSync(fileDescriptor, length);
  },
  close(fileDescriptor: number) {
    closeSync(fileDescriptor);
  },
  unlink(path: string) {
    unlinkSync(path);
  },
});

export interface LocalSinkOptions {
  rootDir: string;
  maxFileBytes: number;
  maxTotalBytes: number;
  retentionDays: number;
  clock?: () => Date;
  fileSystem?: LocalSinkFileSystem;
}

export type CreateLocalObservationSinkResult =
  | { ok: true; sink: LocalObservationSink }
  | { ok: false; error: { code: LocalSinkErrorCode } };

interface SegmentIdentity {
  date: string;
  sequence: number;
  name: string;
  path: string;
  size: number;
  dev: number;
  ino: number;
}

class LocalSinkFault extends Error {
  constructor(readonly code: LocalSinkErrorCode) {
    super(code);
    this.name = 'LocalSinkFault';
  }
}

function failed(code: LocalSinkErrorCode): {
  ok: false;
  error: { code: LocalSinkErrorCode };
} {
  return { ok: false, error: { code } };
}

export function isLocalSinkErrorCode(
  value: unknown,
): value is LocalSinkErrorCode {
  return (
    typeof value === 'string' &&
    (LOCAL_SINK_ERROR_CODES as readonly string[]).includes(value)
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

function hasFileSystemShape(value: unknown): value is LocalSinkFileSystem {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return [
    'mkdir',
    'lstat',
    'readdir',
    'open',
    'fstat',
    'write',
    'truncate',
    'close',
    'unlink',
  ].every((key) => typeof candidate[key] === 'function');
}

function validOptions(options: LocalSinkOptions): boolean {
  const fileSystem = options.fileSystem ?? NODE_LOCAL_SINK_FILE_SYSTEM;
  return (
    typeof options.rootDir === 'string' &&
    isAbsolute(options.rootDir) &&
    resolve(options.rootDir) === options.rootDir &&
    options.rootDir !== parse(options.rootDir).root &&
    isPositiveSafeInteger(options.maxFileBytes) &&
    options.maxFileBytes <= SERVING_OBSERVATION_HARD_LIMITS.maxFileBytes &&
    isPositiveSafeInteger(options.maxTotalBytes) &&
    options.maxTotalBytes <= SERVING_OBSERVATION_HARD_LIMITS.maxTotalBytes &&
    options.maxFileBytes <= options.maxTotalBytes &&
    isPositiveSafeInteger(options.retentionDays) &&
    options.retentionDays <= SERVING_OBSERVATION_HARD_LIMITS.retentionDays &&
    (options.clock === undefined || typeof options.clock === 'function') &&
    hasFileSystemShape(fileSystem)
  );
}

function utcDate(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new LocalSinkFault('clock_invalid');
  }
  return date.toISOString().slice(0, 10);
}

function retentionCutoff(today: string, retentionDays: number): string {
  const cutoff = new Date(`${today}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - (retentionDays - 1));
  return cutoff.toISOString().slice(0, 10);
}

function parseSegmentName(name: string): {
  date: string;
  sequence: number;
} | null {
  const match = SEGMENT_PATTERN.exec(name);
  if (match === null) return null;
  const date = match[1]!;
  const sequence = Number(match[2]);
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > MAX_DAILY_SEGMENT_SEQUENCE
  ) {
    return null;
  }
  return { date, sequence };
}

function bySegmentIdentity(
  left: SegmentIdentity,
  right: SegmentIdentity,
): number {
  return (
    left.date.localeCompare(right.date) ||
    left.sequence - right.sequence ||
    left.name.localeCompare(right.name)
  );
}

class SynchronousLocalObservationSink implements LocalObservationSink {
  private readonly rootDir: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly retentionDays: number;
  private readonly clock: () => Date;
  private readonly fileSystem: LocalSinkFileSystem;
  private segments: SegmentIdentity[] = [];
  private current: SegmentIdentity | undefined;
  private cleanupPending = false;
  private poisoned = false;
  private rootIdentity: { dev: number; ino: number } | undefined;

  constructor(options: LocalSinkOptions) {
    this.rootDir = options.rootDir;
    this.maxFileBytes = options.maxFileBytes;
    this.maxTotalBytes = options.maxTotalBytes;
    this.retentionDays = options.retentionDays;
    this.clock = options.clock ?? (() => new Date());
    this.fileSystem = options.fileSystem ?? NODE_LOCAL_SINK_FILE_SYSTEM;
  }

  initialize(): void {
    const rootStats = this.ensureSafeRoot();
    this.rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };
    this.segments = this.scanSegments();
    this.cleanup(undefined, 0, utcDate(this.clock()));

    // A new process cannot prove the completion state of the previous writer's last record.
    this.current = undefined;
  }

  append(value: unknown): LocalSinkAppendResult {
    let data: Buffer;
    try {
      const decoded = decodeServingRetrievalObservation(value);
      data = Buffer.from(`${canonicalJson(decoded)}\n`, 'utf8');
    } catch {
      return failed('observation_invalid');
    }

    if (
      data.byteLength > this.maxFileBytes ||
      data.byteLength > this.maxTotalBytes
    ) {
      return failed('observation_too_large');
    }

    try {
      this.appendData(data);
      return { ok: true };
    } catch (error) {
      return failed(
        error instanceof LocalSinkFault
          ? error.code
          : 'segment_write_failed',
      );
    }
  }

  private appendData(data: Buffer): void {
    if (this.poisoned) throw new LocalSinkFault('segment_write_failed');
    this.ensureSafeRoot();
    const today = utcDate(this.clock());

    if (this.cleanupPending) {
      this.cleanup(this.current?.name, data.byteLength, today);
      this.cleanupPending = false;
    }

    if (this.mustRotate(today, data.byteLength)) {
      this.appendToNewSegment(today, data);
      return;
    }

    this.appendToExistingSegment(data);
  }

  private mustRotate(today: string, bytes: number): boolean {
    return (
      this.current === undefined ||
      this.current.date !== today ||
      this.current.size + bytes > this.maxFileBytes ||
      this.totalBytes() + bytes > this.maxTotalBytes
    );
  }

  private appendToNewSegment(today: string, data: Buffer): void {
    const { fileDescriptor, segment } = this.createSegment(today);
    this.segments.push(segment);
    this.segments.sort(bySegmentIdentity);
    this.current = segment;
    this.cleanupPending = true;

    try {
      this.cleanup(segment.name, data.byteLength, today);
      this.cleanupPending = false;
    } catch (error) {
      this.closeAfterFailure(fileDescriptor);
      throw error;
    }

    this.writeCompleteLine(fileDescriptor, segment, data);
  }

  private appendToExistingSegment(data: Buffer): void {
    const segment = this.current;
    if (segment === undefined) {
      throw new LocalSinkFault('segment_open_failed');
    }
    const fileDescriptor = this.openExistingSegment(segment);
    this.writeCompleteLine(fileDescriptor, segment, data);
  }

  private createSegment(today: string): {
    fileDescriptor: number;
    segment: SegmentIdentity;
  } {
    const lastSequence = this.segments
      .filter((segment) => segment.date === today)
      .reduce((maximum, segment) => Math.max(maximum, segment.sequence), 0);
    const sequence = lastSequence + 1;
    if (sequence > MAX_DAILY_SEGMENT_SEQUENCE) {
      throw new LocalSinkFault('segment_sequence_exhausted');
    }

    const name = `serving-observations.${today}.${String(sequence).padStart(4, '0')}.jsonl`;
    const path = join(this.rootDir, name);
    const flags =
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_APPEND |
      constants.O_WRONLY |
      constants.O_NOFOLLOW;
    let fileDescriptor: number;
    try {
      fileDescriptor = this.fileSystem.open(path, flags, 0o600);
    } catch {
      throw new LocalSinkFault('segment_create_failed');
    }

    try {
      this.ensureSafeRoot();
      const stats = this.fileSystem.fstat(fileDescriptor);
      if (
        !stats.isFile() ||
        stats.size !== 0 ||
        (stats.mode & 0o077) !== 0 ||
        !Number.isFinite(stats.dev) ||
        !Number.isFinite(stats.ino)
      ) {
        throw new LocalSinkFault('segment_create_failed');
      }
      return {
        fileDescriptor,
        segment: {
          date: today,
          sequence,
          name,
          path,
          size: 0,
          dev: stats.dev,
          ino: stats.ino,
        },
      };
    } catch (error) {
      this.closeAfterFailure(fileDescriptor);
      if (error instanceof LocalSinkFault) throw error;
      throw new LocalSinkFault('segment_create_failed');
    }
  }

  private openExistingSegment(segment: SegmentIdentity): number {
    let pathStats: LocalSinkStats;
    try {
      pathStats = this.fileSystem.lstat(segment.path);
    } catch {
      throw new LocalSinkFault('segment_open_failed');
    }
    if (!this.sameRegularFile(pathStats, segment)) {
      throw new LocalSinkFault('segment_unsafe');
    }

    let fileDescriptor: number;
    try {
      fileDescriptor = this.fileSystem.open(
        segment.path,
        constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      );
    } catch {
      throw new LocalSinkFault('segment_open_failed');
    }

    try {
      this.ensureSafeRoot();
      const descriptorStats = this.fileSystem.fstat(fileDescriptor);
      if (!this.sameRegularFile(descriptorStats, segment)) {
        throw new LocalSinkFault('segment_unsafe');
      }
      return fileDescriptor;
    } catch (error) {
      this.closeAfterFailure(fileDescriptor);
      if (error instanceof LocalSinkFault) throw error;
      throw new LocalSinkFault('segment_open_failed');
    }
  }

  private sameRegularFile(
    stats: LocalSinkStats,
    segment: SegmentIdentity,
  ): boolean {
    return (
      stats.isFile() &&
      !stats.isSymbolicLink() &&
      stats.dev === segment.dev &&
      stats.ino === segment.ino &&
      stats.size === segment.size &&
      (stats.mode & 0o077) === 0
    );
  }

  private writeCompleteLine(
    fileDescriptor: number,
    segment: SegmentIdentity,
    data: Buffer,
  ): void {
    const previousSize = segment.size;
    let offset = 0;
    try {
      while (offset < data.byteLength) {
        const written = this.fileSystem.write(
          fileDescriptor,
          data.subarray(offset),
        );
        if (
          !Number.isSafeInteger(written) ||
          written <= 0 ||
          written > data.byteLength - offset
        ) {
          throw new Error('invalid write count');
        }
        offset += written;
      }
    } catch {
      try {
        this.fileSystem.truncate(fileDescriptor, previousSize);
      } catch {
        this.poisoned = true;
      }
      this.closeAfterFailure(fileDescriptor);
      throw new LocalSinkFault('segment_write_failed');
    }

    try {
      this.fileSystem.close(fileDescriptor);
    } catch {
      this.poisoned = true;
      throw new LocalSinkFault('segment_write_failed');
    }
    segment.size += data.byteLength;
  }

  private closeAfterFailure(fileDescriptor: number): void {
    try {
      this.fileSystem.close(fileDescriptor);
    } catch {
      this.poisoned = true;
    }
  }

  private ensureSafeRoot(): LocalSinkStats {
    let stats: LocalSinkStats;
    try {
      stats = this.fileSystem.lstat(this.rootDir);
    } catch (error) {
      if (!isNotFound(error)) {
        throw new LocalSinkFault('root_setup_failed');
      }
      if (this.rootIdentity !== undefined) {
        throw new LocalSinkFault('root_unsafe');
      }
      try {
        this.fileSystem.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
        stats = this.fileSystem.lstat(this.rootDir);
      } catch {
        throw new LocalSinkFault('root_setup_failed');
      }
    }

    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      !Number.isFinite(stats.dev) ||
      !Number.isFinite(stats.ino) ||
      (stats.mode & 0o077) !== 0
    ) {
      throw new LocalSinkFault('root_unsafe');
    }
    if (
      this.rootIdentity !== undefined &&
      (stats.dev !== this.rootIdentity.dev || stats.ino !== this.rootIdentity.ino)
    ) {
      throw new LocalSinkFault('root_unsafe');
    }
    return stats;
  }

  private scanSegments(): SegmentIdentity[] {
    let names: string[];
    try {
      names = this.fileSystem.readdir(this.rootDir);
    } catch {
      throw new LocalSinkFault('root_setup_failed');
    }

    const segments: SegmentIdentity[] = [];
    for (const name of names) {
      const parsed = parseSegmentName(name);
      if (parsed === null) continue;
      const path = join(this.rootDir, name);
      let stats: LocalSinkStats;
      try {
        stats = this.fileSystem.lstat(path);
      } catch {
        throw new LocalSinkFault('segment_unsafe');
      }
      if (
        stats.isSymbolicLink() ||
        !stats.isFile() ||
        !Number.isSafeInteger(stats.size) ||
        stats.size < 0 ||
        stats.size > this.maxFileBytes ||
        !Number.isFinite(stats.dev) ||
        !Number.isFinite(stats.ino) ||
        (stats.mode & 0o077) !== 0
      ) {
        throw new LocalSinkFault('segment_unsafe');
      }
      segments.push({
        ...parsed,
        name,
        path,
        size: stats.size,
        dev: stats.dev,
        ino: stats.ino,
      });
    }
    return segments.sort(bySegmentIdentity);
  }

  private cleanup(
    protectedName: string | undefined,
    reservedBytes: number,
    today: string,
  ): void {
    const cutoff = retentionCutoff(today, this.retentionDays);
    for (const segment of [...this.segments]) {
      if (segment.name !== protectedName && segment.date < cutoff) {
        this.deleteSegment(segment);
      }
    }

    for (const segment of [...this.segments].sort(bySegmentIdentity)) {
      if (this.totalBytes() + reservedBytes <= this.maxTotalBytes) break;
      if (segment.name !== protectedName) this.deleteSegment(segment);
    }
    if (this.totalBytes() + reservedBytes > this.maxTotalBytes) {
      throw new LocalSinkFault('cleanup_failed');
    }
  }

  private deleteSegment(segment: SegmentIdentity): void {
    try {
      this.ensureSafeRoot();
      const currentStats = this.fileSystem.lstat(segment.path);
      if (!this.sameRegularFile(currentStats, segment)) {
        throw new LocalSinkFault('cleanup_failed');
      }
      this.ensureSafeRoot();
      this.fileSystem.unlink(segment.path);
      this.segments = this.segments.filter(
        (candidate) => candidate.name !== segment.name,
      );
      if (this.current?.name === segment.name) this.current = undefined;
    } catch {
      throw new LocalSinkFault('cleanup_failed');
    }
  }

  private totalBytes(): number {
    return this.segments.reduce((total, segment) => total + segment.size, 0);
  }
}

export function createLocalObservationSink(
  options: LocalSinkOptions,
): CreateLocalObservationSinkResult {
  try {
    if (!validOptions(options)) return failed('invalid_options');
    const sink = new SynchronousLocalObservationSink(options);
    sink.initialize();
    return { ok: true, sink };
  } catch (error) {
    return failed(
      error instanceof LocalSinkFault ? error.code : 'root_setup_failed',
    );
  }
}
