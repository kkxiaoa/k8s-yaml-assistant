import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function gitBlobSha1(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex');
}

export function readVerifiedProviderSnapshot(input: {
  root: string;
  snapshot: string;
  upstreamPath: string;
  upstreamBlobSha1: string;
}): Buffer {
  const path = join(input.root, input.snapshot);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${input.snapshot} must be a regular file`);
  }
  const content = readFileSync(path);
  const actualBlobSha1 = gitBlobSha1(content);
  if (actualBlobSha1 !== input.upstreamBlobSha1) {
    throw new Error(
      `${input.snapshot} (${input.upstreamPath}) Git blob mismatch: expected ${input.upstreamBlobSha1}, got ${actualBlobSha1}`,
    );
  }
  return content;
}
