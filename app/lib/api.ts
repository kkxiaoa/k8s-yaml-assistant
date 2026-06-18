// 前端 API 客户端:封装与 /api/* 的通信细节(fetch / headers / JSON / 读流)。
// page 只调这两个函数 + 管状态,不碰 URL、请求格式、流读取。
import type { VErr } from './yaml';

/** 校验 YAML,返回错误列表。 */
export async function checkYaml(yaml: string): Promise<VErr[]> {
  const res = await fetch('/api/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml }),
  });
  const data = (await res.json()) as { errors: VErr[] };
  return data.errors;
}

/** 流式问答:每收到一段文本就回调 onChunk。 */
export async function askStream(question: string, onChunk: (text: string) => void): Promise<void> {
  const res = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onChunk(dec.decode(value));
  }
}
