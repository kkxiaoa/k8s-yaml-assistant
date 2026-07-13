// 服务端可复用管线:把 CLI 里的检索/校验逻辑抽成函数,供 Next.js API 路由调用。
// 检索流水线(向量 → 软路由 → rerank)与 CLI 完全一致,只是这里被 Web 复用。

import { config } from 'dotenv';
config({ override: true });
import { performance } from 'node:perf_hooks';
import Anthropic from '@anthropic-ai/sdk';
import { searchCorpusTraced } from '../retrieval/retrieve';
import {
  formatSources,
  CONFLICT_RULES,
  selectContextHits,
  type Source,
} from '../retrieval/sources';
import { CORPUS } from '../knowledge/corpus';
import {
  chunkPaths,
  chunkResources,
  primaryPath,
  primaryResource,
  type SourceType,
  type TrustLevel,
} from '../knowledge/chunk';
import { inferResource } from '../retrieval/router';
import {
  validateYamlDocuments,
  type ValidationError,
} from '../validation/validate';
import {
  toTraceHit,
  type RetrievalTrace,
} from '../retrieval/trace';
import { findExactFieldChunks } from '../retrieval/exact-field';
import {
  resolveQueryExpansionEnabled,
  skippedExactQueryExpansionTrace,
} from '../retrieval/query-expansion-runtime';
import { ANSWER_MODEL } from './agent-contract';

export { ANSWER_MODEL } from './agent-contract';

export const ASK_SYSTEM = `你是一位精通 Kubernetes 资源模型的助手,服务于一个容器云平台控制台。
基于给定的 <ask_mode>、<editor_context>、<current_yaml> 和 <docs> 片段准确回答用户关于当前 YAML 配置的问题。
规则:
- 只依据 <docs> 作答,不要编造文档里没有的字段或取值。
- ask_mode=explain_field 时,优先解释 <editor_context> 中的 cursorPath / selectedText。
- ask_mode=explain_error 时,优先解释 <editor_context> 中的 errors。
- 若 <editor_context> 与 <docs> 冲突,以 <docs> 和校验错误为准。
- 若片段不足以回答,明确说"提供的文档片段中没有相关信息",不要猜。
- 关键事实(字段名、取值、默认值)后标出处如 [S1],对应 <docs> 里的来源编号;不要引用给定来源之外的内容。
${CONFLICT_RULES}
- 简洁准确,涉及枚举值时列全。用中文回答。`;

export function getClient(): Anthropic {
  return new Anthropic({
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKey: process.env.DEEPSEEK_API_KEY,
  });
}

export interface Hit {
  id: string;
  title: string;
  resource?: string;
  path?: string;
  resources?: string[];
  paths?: string[];
  text: string;
  sourceType: SourceType;
  sourceUri?: string;
  trustLevel?: TrustLevel;
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

export type RetrievalTraceSink = (trace: RetrievalTrace) => void;

export interface RetrieveContextOptions {
  traceSink?: RetrievalTraceSink;
  search?: typeof searchCorpusTraced;
  queryExpansion?: boolean;
}

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
    resource: primaryResource(chunk),
    path: primaryPath(chunk),
    resources: chunkResources(chunk),
    paths: chunkPaths(chunk),
    text: chunk.text,
    sourceType: chunk.sourceType,
    sourceUri: chunk.sourceUri,
    trustLevel: chunk.trustLevel,
    score,
  };
}

function exactFieldHits(
  resource: string | undefined,
  fieldPath: string | undefined,
  k: number,
): Hit[] {
  return findExactFieldChunks(CORPUS, resource, fieldPath, k)
    .map((chunk) => toHit(chunk, 1));
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
  options: RetrieveContextOptions = {},
): Promise<{
  context: string;
  hits: Hit[];
  sources: Source[];
  trace: RetrievalTrace;
}> {
  const t0 = performance.now();
  const query = toRetrievalQuery(question, mode, editorContext);
  const routed = query.resourceHint ?? inferResource(question);
  const text = retrievalText(query);

  const baseTrace = {
    question,
    mode,
    resourceHint: routed ?? undefined,
    fieldPathHint: query.fieldPathHint,
    createdAt: new Date().toISOString(),
  };
  const emit = (trace: RetrievalTrace): RetrievalTrace => {
    options.traceSink?.(trace);
    return trace;
  };

  // 完整字段路径命中时短路;模糊叶子字段交给统一检索处理。
  const exactHits = selectContextHits(
    exactFieldHits(routed ?? undefined, query.fieldPathHint, k),
    { k, taskType: 'ask' },
  );
  if (exactHits.length > 0) {
    const trace = emit({
      ...baseTrace,
      queryText: text,
      queryExpansion: skippedExactQueryExpansionTrace(
        text,
        routed ?? undefined,
        resolveQueryExpansionEnabled(options.queryExpansion),
      ),
      path: 'exact',
      coarseHits: [],
      rerankHits: [],
      finalHits: exactHits.map((h) => toTraceHit(h, h.score)),
      latencyMs: { total: performance.now() - t0 },
      cache: { indexHit: undefined, embeddingHit: false },
    });
    const { context, sources } = formatSources(exactHits);
    return { context, hits: exactHits, sources, trace };
  }

  // 全量软加权检索(无硬过滤),与 eval 共用同一索引与同一段代码。serving 取 top-k。
  const search = options.search ?? searchCorpusTraced;
  const { hits: ranked, trace: searchTrace } = await search(text, {
    boostResource: routed ?? undefined,
    boostPath: query.fieldPathHint,
    queryExpansion: options.queryExpansion,
  });
  const hits = selectContextHits(ranked, { k, taskType: 'ask' });
  const { context, sources } = formatSources(hits.map((h) => h.chunk));
  const finalHits = hits.map(({ chunk, score }) => toHit(chunk, score));

  const trace = emit({
    ...baseTrace,
    ...searchTrace,
    path: 'search',
    finalHits: finalHits.map((h) => toTraceHit(h, h.score)),
    latencyMs: { ...searchTrace.latencyMs, total: performance.now() - t0 },
  });

  return { context, hits: finalHits, sources, trace };
}

/** 校验一段资源 YAML 文本(多文档 + schema 驱动校验)。供 /api/check 调用,与生成引擎共用同一校验。 */
export function validateYamlText(yamlText: string): ValidationError[] {
  return validateYamlDocuments(yamlText).errors;
}
