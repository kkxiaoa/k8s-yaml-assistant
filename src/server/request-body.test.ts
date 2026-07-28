import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GLOBAL_MAX_BODY_BYTES,
  readJsonBody,
} from './request-body';

const encoder = new TextEncoder();

function streamRequest(
  chunks: Uint8Array[],
  options: {
    headers?: HeadersInit;
    error?: unknown;
    onCancel?: () => void;
    signal?: AbortSignal;
  } = {},
): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) {
        controller.enqueue(chunk);
        return;
      }
      if (options.error !== undefined) {
        controller.error(options.error);
        return;
      }
      controller.close();
    },
    cancel() {
      options.onCancel?.();
    },
  });
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: options.headers,
    body,
    signal: options.signal,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

test('全局请求体硬上限固定为 256 KiB', () => {
  assert.equal(GLOBAL_MAX_BODY_BYTES, 256 * 1024);
});

test('合法 Content-Length 超限时不读取请求流并返回 413 语义', async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(encoder.encode('{"value":"not read"}'));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'Content-Length': '33' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  assert.deepEqual(await readJsonBody(request, 32), {
    ok: false,
    code: 'payload_too_large',
  });
  assert.equal(pulls, 0);
});

test('缺失、非法或伪小 Content-Length 时仍按实际字节限制', async () => {
  const valid = encoder.encode('{"text":"跨分块"}');
  const split = valid.indexOf(encoder.encode('跨')[0]!);
  const missing = streamRequest([
    valid.slice(0, split + 1),
    valid.slice(split + 1),
  ]);
  assert.deepEqual(await readJsonBody(missing, valid.byteLength), {
    ok: true,
    value: { text: '跨分块' },
  });

  const invalid = streamRequest([encoder.encode('{"ok":true}')], {
    headers: { 'Content-Length': 'invalid' },
  });
  assert.deepEqual(await readJsonBody(invalid, 64), {
    ok: true,
    value: { ok: true },
  });

  let cancelled = 0;
  const oversized = streamRequest(
    [encoder.encode('{"value":"0123456789"}')],
    {
      headers: { 'Content-Length': '2' },
      onCancel: () => cancelled++,
    },
  );
  assert.deepEqual(await readJsonBody(oversized, 8), {
    ok: false,
    code: 'payload_too_large',
  });
  assert.equal(cancelled, 1);
});

test('UTF-8 多字节字符跨 chunk 时只解码一次且内容完整', async () => {
  const bytes = encoder.encode('{"text":"字段解释"}');
  const marker = encoder.encode('字');
  const index = bytes.findIndex((_, offset) =>
    marker.every((byte, i) => bytes[offset + i] === byte),
  );
  assert.ok(index >= 0);

  const request = streamRequest([
    bytes.slice(0, index + 1),
    bytes.slice(index + 1, index + 2),
    bytes.slice(index + 2),
  ]);
  assert.deepEqual(await readJsonBody(request, bytes.byteLength), {
    ok: true,
    value: { text: '字段解释' },
  });
});

test('空请求、非法 UTF-8、非法 JSON 和读取错误返回稳定非敏感错误码', async () => {
  const empty = new Request('http://localhost/api/test', { method: 'POST' });
  assert.deepEqual(await readJsonBody(empty, 64), {
    ok: false,
    code: 'invalid_json',
  });

  const invalidUtf8 = streamRequest([
    Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
  ]);
  assert.deepEqual(await readJsonBody(invalidUtf8, 64), {
    ok: false,
    code: 'invalid_encoding',
  });

  const invalidJson = streamRequest([encoder.encode('{"secret":"raw"')]);
  assert.deepEqual(await readJsonBody(invalidJson, 64), {
    ok: false,
    code: 'invalid_json',
  });

  const rawFailure = 'reader failed with TestRawBodySecret123';
  const readerError = streamRequest([], { error: new Error(rawFailure) });
  const result = await readJsonBody(readerError, 64);
  assert.deepEqual(result, { ok: false, code: 'body_read_failed' });
  assert.equal(JSON.stringify(result).includes(rawFailure), false);
});

test('已中止请求返回稳定错误且不解析请求体', async () => {
  const controller = new AbortController();
  controller.abort(new Error('TestAbortSecret123'));
  const request = streamRequest([encoder.encode('{"ok":true}')], {
    signal: controller.signal,
  });
  const result = await readJsonBody(request, 64);
  assert.deepEqual(result, { ok: false, code: 'request_aborted' });
  assert.equal(JSON.stringify(result).includes('TestAbortSecret123'), false);
});
