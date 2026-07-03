// 前端 API 客户端:封装与 /api/* 的通信细节(fetch / headers / JSON / 读流)。
// page 只调函数 + 管状态,不碰 URL、请求格式、流读取。
import type { VErr } from './yaml';

export interface SourceHit {
  id: string;
  title: string;
  resource: string;
  path?: string;
  text: string;
  sourceType: 'schema' | 'doc' | 'example' | 'policy';
  score?: number;
}

export interface EditorContext {
  yaml: string;
  kind?: string | null;
  apiVersion?: string | null;
  selectedText?: string;
  cursorPath?: string | null;
  errors?: VErr[];
}

export type AskMode = 'free' | 'explain_field' | 'explain_error';

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

interface AskHandlers {
  onSources: (sources: SourceHit[]) => void;
  onDelta: (text: string) => void;
}

function parseSseEvents(buffer: string): {
  events: Array<{ event: string; data: string }>;
  rest: string;
} {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events = parts.map((part) => {
    const event = part.match(/^event:\s*(.+)$/m)?.[1] ?? 'message';
    const data = part
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    return { event, data };
  });
  return { events, rest };
}

/** 流式问答:SSE 先返回 sources,再持续返回 answer delta。 */
export async function askStream(
  question: string,
  mode: AskMode,
  context: EditorContext,
  handlers: AskHandlers,
): Promise<void> {
  const res = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, mode, context }),
  });

  if (!res.body) return;

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();

    if (done) break;

    buffer += dec.decode(value, { stream: true });
    const parsed = parseSseEvents(buffer);
    buffer = parsed.rest;

    for (const evt of parsed.events) {
      if (evt.event === 'sources') {
        handlers.onSources(JSON.parse(evt.data) as SourceHit[]);
      } else if (evt.event === 'delta') {
        handlers.onDelta(JSON.parse(evt.data) as string);
      }
    }
  }
}

export interface GenResult {
  yaml: string | null;
  rounds: number;
}

/** 自然语言需求 → 生成合法资源 YAML(后端带"生成→校验→修正"自检闭环)。 */
export async function generateYaml(requirement: string): Promise<GenResult> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requirement }),
  });
  return (await res.json()) as GenResult;
}

/** 修正有校验错误的资源 YAML(后端带自检闭环)。 */
export async function fixYaml(
  yaml: string,
  errors: VErr[],
): Promise<GenResult> {
  const res = await fetch('/api/fix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml, errors }),
  });
  return (await res.json()) as GenResult;
}
