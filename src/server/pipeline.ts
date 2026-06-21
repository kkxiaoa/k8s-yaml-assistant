// 服务端可复用管线:把 CLI 里的检索/校验逻辑抽成函数,供 Next.js API 路由调用。
// 检索流水线(向量 → 软路由 → rerank)与 CLI 完全一致,只是这里被 Web 复用。

import { config } from 'dotenv';
config({ override: true });
import Anthropic from '@anthropic-ai/sdk';
import { load } from 'js-yaml';
import { buildIndex, retrieve, type IndexedChunk } from '../retrieval/retrieve';
import { CORPUS } from '../knowledge/corpus';
import { inferResource } from '../retrieval/router';
import { rerank, COARSE_N } from '../retrieval/rerank';
import { validateResource, type ValidationError } from '../validation/validate';

export const ANSWER_MODEL = 'claude-sonnet-4-6'; // DeepSeek 映射 deepseek-v4-flash

export const ASK_SYSTEM = `你是一位精通 Kubernetes 资源模型的助手,服务于一个容器云平台控制台。
基于给定的 <ask_mode>、<editor_context>、<current_yaml> 和 <docs> 片段准确回答用户关于当前 YAML 配置的问题。
规则:
- 只依据 <docs> 作答,不要编造文档里没有的字段或取值。
- ask_mode=explain_field 时,优先解释 <editor_context> 中的 cursorPath / selectedText。
- ask_mode=explain_error 时,优先解释 <editor_context> 中的 errors。
- 若 <editor_context> 与 <docs> 冲突,以 <docs> 和校验错误为准。
- 若片段不足以回答,明确说"提供的文档片段中没有相关信息",不要猜。
- 简洁准确,涉及枚举值时列全。用中文回答。`;

export function getClient(): Anthropic {
  return new Anthropic({
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKey: process.env.DEEPSEEK_API_KEY,
  });
}

const FALLBACK_RESOURCES = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Pod',
  'Service',
  'Ingress',
  'ConfigMap',
  'Secret',
  'StorageClass',
  'PersistentVolumeClaim',
]);

const indexPromises = new Map<string, Promise<IndexedChunk[]>>();

function chunksForResource(resource?: string): {
  cacheKey: string;
  chunks: typeof CORPUS;
} {
  if (resource) {
    const scoped = CORPUS.filter((c) => c.resource === resource);
    if (scoped.length > 0)
      return { cacheKey: `resource:${resource}`, chunks: scoped };
  }
  const fallback = CORPUS.filter((c) => FALLBACK_RESOURCES.has(c.resource));
  return {
    cacheKey: 'fallback:core',
    chunks: fallback.length > 0 ? fallback : CORPUS.slice(0, 1000),
  };
}

function getIndex(resource?: string): Promise<IndexedChunk[]> {
  const { cacheKey, chunks } = chunksForResource(resource);
  const existing = indexPromises.get(cacheKey);
  if (existing) return existing;
  const next = buildIndex(chunks);
  indexPromises.set(cacheKey, next);
  return next;
}

export interface Hit {
  id: string;
  title: string;
  resource: string;
  path?: string;
  text: string;
  sourceType: 'schema';
  score?: number;
}

export interface EditorContext {
  yaml?: string;
  kind?: string | null;
  apiVersion?: string | null;
  selectedText?: string;
  cursorPath?: string | null;
  errors?: ValidationError[];
}

export type AskMode = 'free' | 'explain_field' | 'explain_error';

export interface RetrievalQuery {
  userQuestion: string;
  resourceHint?: string;
  fieldPathHint?: string;
  selectedText?: string;
  errorMessages?: string[];
}

function toRetrievalQuery(
  question: string,
  mode: AskMode,
  editorContext?: EditorContext,
): RetrievalQuery {
  const firstErrorPath = editorContext?.errors?.find((e) => e.path)?.path;
  const fieldPathHint =
    mode === 'explain_field' || editorContext?.selectedText
      ? (editorContext?.cursorPath ?? undefined)
      : mode === 'explain_error'
        ? firstErrorPath
        : undefined;
  return {
    userQuestion: question,
    resourceHint: editorContext?.kind ?? undefined,
    fieldPathHint,
    selectedText: editorContext?.selectedText,
    errorMessages:
      mode === 'explain_error'
        ? editorContext?.errors?.map((e) => `${e.path}: ${e.message}`)
        : undefined,
  };
}

function retrievalText(query: RetrievalQuery): string {
  return [
    query.userQuestion,
    query.resourceHint ? `资源:${query.resourceHint}` : '',
    query.fieldPathHint ? `字段:${query.fieldPathHint}` : '',
    query.selectedText ? `选中内容:${query.selectedText}` : '',
    ...(query.errorMessages ?? []).map((e) => `错误:${e}`),
  ]
    .filter(Boolean)
    .join('\n');
}

function toHit(chunk: (typeof CORPUS)[number], score?: number): Hit {
  return {
    id: chunk.id,
    title: chunk.title,
    resource: chunk.resource,
    path: chunk.path,
    text: chunk.text,
    sourceType: chunk.sourceType,
    score,
  };
}

function exactFieldHits(
  resource: string | undefined,
  fieldPath: string | undefined,
  k: number,
): Hit[] {
  if (!resource || !fieldPath) return [];
  const exact = CORPUS.filter(
    (c) => c.resource === resource && c.path === fieldPath,
  );
  if (exact.length > 0) return exact.slice(0, k).map((c) => toHit(c, 1));

  const leaf = fieldPath.split('.').pop();
  if (!leaf) return [];
  return CORPUS.filter(
    (c) => c.resource === resource && c.path.endsWith(`.${leaf}`),
  )
    .slice(0, k)
    .map((c) => toHit(c, 0.8));
}

export function formatEditorContext(editorContext?: EditorContext): string {
  if (!editorContext) return '<editor_context>\n无\n</editor_context>';
  const errors = editorContext.errors?.length
    ? editorContext.errors
        .map((e) => `- ${e.path || '(根)'}: ${e.message}`)
        .join('\n')
    : '无';
  return `<editor_context>
kind: ${editorContext.kind ?? '未知'}
apiVersion: ${editorContext.apiVersion ?? '未知'}
cursorPath: ${editorContext.cursorPath ?? '未知'}
selectedText: ${editorContext.selectedText || '无'}
errors:
${errors}
</editor_context>`;
}

/** 完整检索流水线:软路由 → 粗召回 → rerank 精排 → 拼上下文。 */
export async function retrieveContext(
  question: string,
  k = 3,
  editorContext?: EditorContext,
  mode: AskMode = 'free',
): Promise<{ context: string; hits: Hit[] }> {
  const query = toRetrievalQuery(question, mode, editorContext);
  const routed = query.resourceHint ?? inferResource(question);
  const exactHits = exactFieldHits(routed ?? undefined, query.fieldPathHint, k);
  if (exactHits.length > 0) {
    return {
      context: exactHits.map((h) => `## ${h.title}\n${h.text}`).join('\n\n'),
      hits: exactHits,
    };
  }

  const index = await getIndex(routed ?? undefined);
  const text = retrievalText(query);
  const coarse = await retrieve(
    text,
    index,
    COARSE_N,
    routed ?? undefined,
    query.fieldPathHint,
  );
  const rr = await rerank(
    text,
    coarse.map((h) => h.chunk.text),
    k,
  );
  const hits = rr.map((r) => ({
    chunk: coarse[r.index]!.chunk,
    score: r.score,
  }));
  const context = hits
    .map(({ chunk }) => `## ${chunk.title}\n${chunk.text}`)
    .join('\n\n');

  return {
    context,
    hits: hits.map(({ chunk, score }) => ({
      id: chunk.id,
      title: chunk.title,
      resource: chunk.resource,
      path: chunk.path,
      text: chunk.text,
      sourceType: chunk.sourceType,
      score,
    })),
  };
}

/** 校验一段资源 YAML 文本(解析 + schema 驱动校验,自动按 kind 选 schema)。供 /api/check 调用。 */
export function validateYamlText(yamlText: string): ValidationError[] {
  let parsed: unknown;
  try {
    parsed = load(yamlText);
  } catch (e) {
    return [
      {
        path: '',
        message:
          'YAML 解析失败: ' + (e instanceof Error ? e.message : String(e)),
      },
    ];
  }
  return validateResource(parsed);
}
