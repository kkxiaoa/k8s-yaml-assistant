export const GLOBAL_MAX_BODY_BYTES = 256 * 1024;

export type RequestBodyErrorCode =
  | 'payload_too_large'
  | 'request_aborted'
  | 'body_read_failed'
  | 'invalid_encoding'
  | 'invalid_json';

type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; code: RequestBodyErrorCode };

function failure(code: RequestBodyErrorCode): JsonBodyResult {
  return { ok: false, code };
}

function declaredLengthExceeds(request: Request, maxBytes: number): boolean {
  const header = request.headers.get('content-length');
  if (header === null || !/^\d+$/.test(header)) return false;
  try {
    return BigInt(header) > BigInt(maxBytes);
  } catch {
    return false;
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The stable boundary error has already been selected.
  }
}

export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<JsonBodyResult> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > GLOBAL_MAX_BODY_BYTES
  ) {
    throw new RangeError('invalid request body limit');
  }
  if (declaredLengthExceeds(request, maxBytes)) {
    return failure('payload_too_large');
  }
  if (request.signal.aborted) return failure('request_aborted');
  if (request.body === null) return failure('invalid_json');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      if (request.signal.aborted) {
        await cancelReader(reader);
        return failure('request_aborted');
      }

      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        return failure(
          request.signal.aborted ? 'request_aborted' : 'body_read_failed',
        );
      }
      if (next.done) break;

      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await cancelReader(reader);
        return failure('payload_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (request.signal.aborted) return failure('request_aborted');

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return failure('invalid_encoding');
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return failure('invalid_json');
  }
}
