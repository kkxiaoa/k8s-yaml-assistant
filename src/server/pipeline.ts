// 服务端可复用管线:把 CLI 里的检索/校验逻辑抽成函数,供 Next.js API 路由调用。
// 检索流水线(向量 → 软路由 → rerank)与 CLI 完全一致,只是这里被 Web 复用。

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
import { type KnowledgeChunk } from '../knowledge/chunk';
import { inferResource } from '../retrieval/router';
import {
  validateYamlDocuments,
  type ValidationError,
} from '../validation/validate';
import { toTraceHit, type RetrievalTrace } from '../retrieval/trace';
import {
  findExactFieldChunks,
  hasSchemaFieldDescendants,
} from '../retrieval/exact-field';
import {
  resolveQueryExpansionEnabled,
  skippedExactQueryExpansionTrace,
} from '../retrieval/query-expansion-runtime';
import { ANSWER_MODEL } from './agent-contract';
import {
  assertModelInputByteBudget,
  DEEPSEEK_CLIENT_POLICY,
} from './model-request-policy';
import {
  requireDeepSeekRuntimeAccess,
  type DeepSeekRuntimeAccess,
  type RetrievalRuntimeAccess,
} from './runtime-config';
import type { ProviderRequestObserver } from './provider-usage';
export { ANSWER_MODEL };

export const ASK_MAX_TOKENS = 2048;
export const ASK_REQUEST_OPTIONS = {
  thinking: { type: 'disabled' },
  temperature: 0,
} satisfies Pick<
  Anthropic.MessageCreateParamsNonStreaming,
  'temperature' | 'thinking'
>;

export const ASK_SYSTEM = `你是一位精通 Kubernetes 资源模型的助手,服务于一个容器云平台控制台。
基于给定的 <ask_mode>、<editor_context>、<current_yaml> 和 <docs> 片段准确回答用户关于当前 YAML 配置的问题。
规则按优先级执行:
- 证据边界:事实只能来自 <docs>,以及 <current_yaml> / <editor_context> 中明确给出的当前配置、选中内容和校验错误。问题只能在证据已列出的有限选项中限定用户所指对象;常识、模型记忆、未展示内容和外部链接都不是证据。<editor_context> 与 <docs> 冲突时以 <docs> 和校验错误为准。
- 最小回答:只回答核心问题所需且能由证据直接推出的内容;检索片段是候选证据,不是逐条介绍清单。字段、资源、API、参数、键、命令、取值、默认值、校验/准入/运行后果和操作建议都要有直接证据;限制本身不能推出未明示的补救动作,也不能用“通常”“可能”“例如”引入新事实。核心问题已有完整答案时立即结束,不要追加“未提供”说明;即使是否定描述,也不得点名证据中未出现的字段或选项。
- 字段路径:schema 来源“规范目标”中的 path 是完整字段路径,必须原样使用;单字段段 path 表示顶层字段,不得自行添加 spec、metadata 或其他前缀。
- YAML 与示例:有 <current_yaml> 时只复用其中明确内容和证据支持的字段、取值。没有 <current_yaml> 时,示例只能组合证据支持的业务字段、层级和键;这些字段的值可以使用明确标为示例的占位值。问题明确询问配置写法,且 <docs> 同时支持核心业务字段与资源的 \`metadata.name\` schema 规范目标时,应输出一个最小完整资源 YAML 示例:使用只含 \`apiVersion\`、\`kind\`、\`metadata.name\` 的通用资源骨架,并只组合核心问题所需且有证据的业务字段子树;名称只能使用 \`example\` 或 \`example-\` 开头的明显占位值。\`metadata.namespace\` 不属于通用骨架,没有当前配置或直接证据时不得补写;也不得补写其他相邻字段。若证据只有 object 字段而没有子字段 schema,不得命名真实或占位子键、不得生成该对象的 YAML;只说明已知的路径、类型、作用和缺少的子字段依据。
- 来源不足:证据只支持部分答案时只回答该部分,并按类别说明还缺什么,不得列举证据中未出现的具体例子。证据不足以回答核心问题时,只说“提供的文档片段中没有相关信息,无法据此回答”并停止,不追加命令、替代方案或无关片段。
- 模式聚焦:ask_mode=explain_field 时优先解释 cursorPath / selectedText;ask_mode=explain_error 时优先解释 errors。
${CONFLICT_RULES}
- 引用与输出:字段名、取值、默认值等关键事实后标对应 [S#];只有 <docs> 明确给出完整枚举时才列全。用中文简洁回答。`;

export function getClient(
  runtimeAccess: DeepSeekRuntimeAccess = requireDeepSeekRuntimeAccess(),
): Anthropic {
  const config = runtimeAccess.config;
  return new Anthropic({
    baseURL: config.deepseek.baseUrl,
    apiKey: runtimeAccess.apiKey(),
    ...DEEPSEEK_CLIENT_POLICY,
  });
}

export interface Hit extends KnowledgeChunk {
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
  structuredErrorDirectSchemaChildBoost?: boolean;
  resourceExampleScaffoldEvidence?: boolean;
  runtimeAccess?: RetrievalRuntimeAccess;
  requestObserver?: ProviderRequestObserver;
}

export interface RetrievalQuery {
  userQuestion: string;
  resourceHint?: string;
  apiVersionHint?: string;
  fieldPathHint?: string;
  selectedText?: string;
  errorMessages?: string[];
}

const CONFIGURATION_EXAMPLE_INTENT =
  /(?:怎么|如何)[^?？。\n]{0,32}(?:设置|配置|声明|指定|编写|写入|添加|设为|启用|关闭|绑定|引用|挂载|限制|配)(?:[?？。\n]|$)|(?:YAML|配置)(?:示例|样例|写法|片段)/iu;

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
    apiVersionHint: editorContext?.apiVersion ?? undefined,
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
    query.apiVersionHint ? `apiVersion:${query.apiVersionHint}` : '',
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
    text: chunk.text,
    sourceType: chunk.sourceType,
    provenance: chunk.provenance,
    targets: chunk.targets,
    score,
  };
}

function withResourceExampleScaffoldEvidence(
  hits: readonly Hit[],
  input: {
    question: string;
    mode: AskMode;
    editorContext?: EditorContext;
    resource?: string;
    apiVersion?: string;
    enabled: boolean;
  },
): Hit[] {
  const { question, mode, editorContext, resource, enabled } = input;
  if (
    !enabled ||
    hits.length === 0 ||
    mode !== 'free' ||
    editorContext?.yaml?.trim() ||
    !resource ||
    !CONFIGURATION_EXAMPLE_INTENT.test(question)
  ) {
    return [...hits];
  }

  const evidenceVersions = new Set(
    hits.flatMap((hit) =>
      hit.targets
        .filter((target) => target.kind === resource)
        .map((target) => target.apiVersion)
        .filter((value): value is string => value !== undefined),
    ),
  );
  const apiVersion =
    input.apiVersion ??
    (evidenceVersions.size === 1 ? [...evidenceVersions][0] : undefined);
  if (!apiVersion) return [...hits];

  const candidates = findExactFieldChunks(
    CORPUS,
    resource,
    'metadata.name',
    apiVersion,
  ).filter((chunk) => chunk.sourceType === 'schema');
  if (candidates.length !== 1) return [...hits];

  const scaffold = candidates[0]!;
  return hits.some((hit) => hit.id === scaffold.id)
    ? [...hits]
    : [...hits, toHit(scaffold)];
}

function exactFieldHits(
  resource: string | undefined,
  fieldPath: string | undefined,
  apiVersion: string | undefined,
): Hit[] {
  return findExactFieldChunks(CORPUS, resource, fieldPath, apiVersion).map(
    (chunk) => toHit(chunk, 1),
  );
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

export interface AskPromptInput {
  question: string;
  context: string;
  mode: AskMode;
  editorContext?: EditorContext;
}

export function buildAskUserMessage(input: AskPromptInput): string {
  const { question, context, mode, editorContext } = input;
  return `参考以下上下文和 K8s 字段文档片段回答问题。\n\n<ask_mode>\n${mode}\n</ask_mode>\n\n${formatEditorContext(editorContext)}\n\n<current_yaml>\n${editorContext?.yaml ?? '无'}\n</current_yaml>\n\n<docs>\n${context}\n</docs>\n\n问题:${question}`;
}

export type AskRequest = Anthropic.MessageCreateParamsNonStreaming;

export function buildAskRequest(input: AskPromptInput): AskRequest {
  const request: AskRequest = {
    model: ANSWER_MODEL,
    max_tokens: ASK_MAX_TOKENS,
    ...ASK_REQUEST_OPTIONS,
    system: ASK_SYSTEM,
    messages: [
      {
        role: 'user',
        content: buildAskUserMessage(input),
      },
    ],
  };
  assertModelInputByteBudget(request);
  return request;
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
    apiVersionHint: query.apiVersionHint,
    fieldPathHint: query.fieldPathHint,
    createdAt: new Date().toISOString(),
  };
  const emit = (trace: RetrievalTrace): RetrievalTrace => {
    options.traceSink?.(trace);
    return trace;
  };

  // 精确标量字段直接回答;对象字段错误继续检索修复所需的子字段证据。
  const exactHits = selectContextHits(
    exactFieldHits(
      routed ?? undefined,
      query.fieldPathHint,
      query.apiVersionHint,
    ),
    { k, taskType: 'ask' },
  );
  const needsErrorStructureEvidence =
    mode === 'explain_error' &&
    hasSchemaFieldDescendants(
      CORPUS,
      routed ?? undefined,
      query.fieldPathHint,
      query.apiVersionHint,
    );
  if (exactHits.length > 0 && !needsErrorStructureEvidence) {
    const contextHits = withResourceExampleScaffoldEvidence(exactHits, {
      question,
      mode,
      editorContext,
      resource: routed ?? undefined,
      apiVersion: query.apiVersionHint,
      enabled: options.resourceExampleScaffoldEvidence ?? true,
    });
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
      finalHits: contextHits.map((h) => toTraceHit(h, h.score)),
      latencyMs: { total: performance.now() - t0 },
      cache: { index: { status: 'not_used' }, embeddingHit: false },
    });
    const { context, sources } = formatSources(contextHits);
    return { context, hits: contextHits, sources, trace };
  }

  // 全量软加权检索(无硬过滤),与 eval 共用同一索引与同一段代码。serving 取 top-k。
  const search = options.search ?? searchCorpusTraced;
  const { hits: ranked, trace: searchTrace } = await search(text, {
    boostResource: routed ?? undefined,
    boostPath: query.fieldPathHint,
    boostApiVersion: query.apiVersionHint,
    boostDirectSchemaChildren:
      needsErrorStructureEvidence &&
      (options.structuredErrorDirectSchemaChildBoost ?? true),
    queryExpansion: options.queryExpansion,
    ...(options.runtimeAccess === undefined
      ? {}
      : { runtimeAccess: options.runtimeAccess }),
    ...(options.requestObserver === undefined
      ? {}
      : { requestObserver: options.requestObserver }),
  });
  const hits = selectContextHits(ranked, { k, taskType: 'ask' });
  const finalHits = withResourceExampleScaffoldEvidence(
    hits.map(({ chunk, score }) => toHit(chunk, score)),
    {
      question,
      mode,
      editorContext,
      resource: routed ?? undefined,
      apiVersion: query.apiVersionHint,
      enabled: options.resourceExampleScaffoldEvidence ?? true,
    },
  );
  const { context, sources } = formatSources(finalHits);

  const trace = emit({
    ...baseTrace,
    ...searchTrace,
    path: 'search',
    finalHits: finalHits.map((h) => toTraceHit(h, h.score)),
    latencyMs: { ...searchTrace.latencyMs, total: performance.now() - t0 },
  });

  return { context, hits: finalHits, sources, trace };
}

export interface PrepareAskInput {
  question: string;
  k?: number;
  editorContext?: EditorContext;
  mode: AskMode;
  retrievalOptions?: RetrieveContextOptions;
}

export async function prepareAsk(input: PrepareAskInput) {
  const {
    question,
    k = 3,
    editorContext,
    mode,
    retrievalOptions,
  } = input;
  const retrieval = await retrieveContext(
    question,
    k,
    editorContext,
    mode,
    retrievalOptions,
  );
  return {
    ...retrieval,
    request: buildAskRequest({
      question,
      context: retrieval.context,
      mode,
      editorContext,
    }),
  };
}

/** 校验一段资源 YAML 文本(多文档 + schema 驱动校验)。供 /api/check 调用,与生成引擎共用同一校验。 */
export function validateYamlText(yamlText: string): ValidationError[] {
  return validateYamlDocuments(yamlText).errors;
}
