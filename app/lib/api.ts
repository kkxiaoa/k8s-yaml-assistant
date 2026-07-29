// 前端 API 客户端:封装与 /api/* 的通信细节(fetch / headers / JSON / 读流)。
// page 只调函数 + 管状态,不碰 URL、请求格式、流读取。
import type { VErr } from './yaml';
import type {
  KnowledgeTarget,
  Provenance,
  SourceType,
} from '@/knowledge/chunk';
import { applicationPath } from '@/shared/application-path.mjs';
import type {
  AdminExperienceRequest,
  AdminExperienceResponse,
  ExperienceResponse,
} from '@/server/experience-control';

export interface SourceHit {
  /** 引用编号,对应答案里的 [S{n}] */
  n?: number;
  id: string;
  title: string;
  text: string;
  sourceType: SourceType;
  provenance: Provenance;
  targets: KnowledgeTarget[];
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

const apiErrorMessages: Readonly<Record<string, string>> = {
  authentication_required: '请先通过 GitHub 登录后再使用此功能。',
  access_denied: '当前账号无权执行此操作。',
  sleep_mode: '当前处于休眠模式，模型功能暂不可用。',
  global_budget_exhausted: '本期体验预算已用完，稍后可继续体验。',
  quota_exhausted:
    '当前体验额度不足；匿名用户可登录获得每日额度，登录用户可在额度重置后继续。',
  control_state_unavailable: '体验状态暂不可用，模型功能已安全关闭。',
  invalid_origin: '管理请求来源无效，请刷新页面后重试。',
  invalid_content_type: '管理请求格式无效，请刷新页面后重试。',
  model_access_disabled:
    '模型功能当前已关闭；Schema（结构模式）检查仍可使用。',
  concurrency_limited: '当前请求正在处理中，请稍后再试。',
  rate_limited: '请求过于频繁，请稍后再试。',
  invalid_request: '请求内容无效，请检查输入后重试。',
  invalid_json: '请求内容无法解析，请刷新页面后重试。',
  invalid_encoding: '请求编码无效，请刷新页面后重试。',
  payload_too_large: '请求内容过大，请缩短 YAML（配置文件）或问题。',
  model_input_too_large: '模型输入过大，请缩短 YAML（配置文件）或问题。',
  runtime_config_invalid: '服务配置尚未就绪，请稍后再试。',
  deepseek_unavailable: '回答模型当前不可用，请稍后再试。',
  voyage_unavailable: '检索模型当前不可用，请稍后再试。',
  upstream_timeout: '上游服务响应超时，请稍后再试。',
  upstream_authentication_failed: '上游服务认证失败，请联系管理员。',
  upstream_balance_exhausted: '模型服务余额不足，模型功能暂不可用。',
  upstream_quota_exceeded: '模型服务额度已用尽，模型功能暂不可用。',
  upstream_unavailable: '上游服务当前不可用，请稍后再试。',
  upstream_request_rejected: '上游服务拒绝了请求，请稍后再试。',
  upstream_error: '上游服务请求失败，请稍后再试。',
  schema_invalid: 'Schema（结构模式）数据尚未就绪，请稍后再试。',
  policy_invalid: '策略数据尚未就绪，请稍后再试。',
  aliases_missing: '别名数据尚未就绪，请稍后再试。',
  aliases_invalid: '别名数据无效，请联系管理员。',
  service_unavailable: '服务当前不可用，请稍后再试。',
  request_failed: '请求失败，请稍后再试。',
  empty_response: '服务未返回有效响应，请稍后再试。',
};

export class ApiRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(apiErrorMessages[code] ?? apiErrorMessages.request_failed);
    this.name = 'ApiRequestError';
    this.code = code;
  }
}

function responseErrorCode(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code === 'string') return record.code;
  const error = record.error;
  if (error === null || typeof error !== 'object' || Array.isArray(error)) {
    return null;
  }
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : null;
}

function statusErrorCode(status: number): string {
  if (status === 401) return 'authentication_required';
  if (status === 403) return 'access_denied';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503) return 'service_unavailable';
  return 'request_failed';
}

async function requireSuccessfulResponse(response: Response): Promise<void> {
  if (response.ok) return;
  let code: string | null = null;
  if (
    response.headers
      .get('content-type')
      ?.toLowerCase()
      .includes('application/json')
  ) {
    try {
      code = responseErrorCode(await response.json());
    } catch {
      code = null;
    }
  }
  throw new ApiRequestError(code ?? statusErrorCode(response.status));
}

/** 校验 YAML,返回错误列表。 */
export async function checkYaml(yaml: string): Promise<VErr[]> {
  const res = await fetch(applicationPath('/api/check'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml }),
  });
  await requireSuccessfulResponse(res);
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
  const res = await fetch(applicationPath('/api/ask'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, mode, context }),
  });

  await requireSuccessfulResponse(res);
  if (!res.body) {
    throw new ApiRequestError('empty_response');
  }

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
      } else if (evt.event === 'error') {
        let code = 'upstream_error';
        try {
          code = responseErrorCode(JSON.parse(evt.data) as unknown) ?? code;
        } catch {
          // The browser only exposes a stable local error when the stream is malformed.
        }
        throw new ApiRequestError(code);
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
  const res = await fetch(applicationPath('/api/generate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requirement }),
  });
  await requireSuccessfulResponse(res);
  return (await res.json()) as GenResult;
}

/** 修正有校验错误的资源 YAML(后端带自检闭环)。 */
export async function fixYaml(
  yaml: string,
  errors: VErr[],
): Promise<GenResult> {
  const res = await fetch(applicationPath('/api/fix'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml, errors }),
  });
  await requireSuccessfulResponse(res);
  return (await res.json()) as GenResult;
}

export async function getExperience(): Promise<ExperienceResponse> {
  const response = await fetch(applicationPath('/api/experience'), {
    cache: 'no-store',
  });
  await requireSuccessfulResponse(response);
  return (await response.json()) as ExperienceResponse;
}

export async function getAdminExperience(): Promise<AdminExperienceResponse> {
  const response = await fetch(applicationPath('/api/admin/experience'), {
    cache: 'no-store',
  });
  await requireSuccessfulResponse(response);
  return (await response.json()) as AdminExperienceResponse;
}

export async function setAdminExperience(
  request: AdminExperienceRequest,
): Promise<AdminExperienceResponse> {
  const response = await fetch(applicationPath('/api/admin/experience'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  await requireSuccessfulResponse(response);
  return (await response.json()) as AdminExperienceResponse;
}
