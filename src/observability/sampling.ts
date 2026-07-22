import { createHash } from "node:crypto";

const SAMPLING_BUCKET_COUNT = 1n << 64n;

export function requestIdSamplingBucket(requestId: string): bigint {
  return createHash("sha256")
    .update(requestId, "utf8")
    .digest()
    .readBigUInt64BE(0);
}

export function shouldSample(requestId: string, sampleRate: number): boolean {
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    throw new TypeError("invalid serving observation sample rate");
  }
  if (sampleRate === 0) return false;
  if (sampleRate === 1) return true;

  // Integer comparison preserves the 64-bit bucket instead of rounding it through a JS number.
  const threshold = BigInt(
    Math.ceil(sampleRate * Number(SAMPLING_BUCKET_COUNT)),
  );
  return requestIdSamplingBucket(requestId) < threshold;
}
