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
- 最小回答:只回答核心问题所需且能由证据直接推出的内容;检索片段是候选证据,不是逐条介绍清单。问题只询问字段或路径时,回答最直接匹配字段及其定义后立即结束,不得展开其他候选片段中的子字段或用法。字段、资源、API、参数、键、命令、取值、默认值、校验/准入/运行后果和操作建议都要有直接证据;限制本身不能推出未明示的补救动作,也不能用“通常”“可能”“例如”引入新事实。核心问题已有完整答案时立即结束,不要追加“未提供”说明;即使是否定描述,也不得点名证据中未出现的字段或选项。
- 字段路径:schema 来源“规范目标”中的 path 是完整字段路径,必须原样使用;单字段段 path 表示顶层字段,不得自行添加 spec、metadata 或其他前缀。
- YAML 与示例:<current_yaml> 只证明其自身资源中明确出现的字段和值;问题目标资源与当前资源不同时,不得复制当前 YAML。问题明确询问配置写法且 <docs> 有匹配目标的 example 来源时,应基于该来源输出一个最小完整资源 YAML 代码块:保留其 \`apiVersion\`、\`kind\`、\`metadata.name\` 和核心问题所需业务子树,删除无关相邻字段;example 只提供配置参考,不替代 schema 合法性。没有匹配 example 时,仅当 <docs> 同时支持核心业务字段与 \`metadata.name\` schema 规范目标,才使用只含 \`apiVersion\`、\`kind\`、\`metadata.name\` 的通用骨架,名称使用 \`example\` 或 \`example-\` 开头的明显占位值。当前 YAML 与问题目标一致时可保留其中已有名称。\`metadata.namespace\` 不属于通用骨架,没有当前配置或直接证据时不得补写;也不得补写其他相邻字段。若证据只有 object 字段而没有子字段 schema 或 example,不得命名真实或占位子键、不得生成该对象的 YAML;只说明已知的路径、类型、作用和缺少的子字段依据。
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
  /(?:怎么|如何)[^?？。\n]{0,24}(?:设置|配置|声明|指定|编写|写入|添加|设为|设|启用|关闭|绑定|引用|挂载|申请|限制|选中|配)[^?？。\n]{0,48}(?:[?？。\n]|$)|(?:YAML|配置)(?:示例|样例|写法|片段)/iu;

interface ResourceExampleEvidenceInput {
  question: string;
  mode: AskMode;
  resource?: string;
  apiVersion?: string;
  enabled: boolean;
}

function usesSupplementalResourceExample(
  input: ResourceExampleEvidenceInput,
): boolean {
  return (
    input.enabled &&
    input.mode === 'free' &&
    input.resource !== undefined &&
    CONFIGURATION_EXAMPLE_INTENT.test(input.question)
  );
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

function withResourceExampleEvidence(
  hits: readonly Hit[],
  input: ResourceExampleEvidenceInput,
): Hit[] {
  const { resource } = input;
  if (
    hits.length === 0 ||
    !usesSupplementalResourceExample(input) ||
    resource === undefined
  ) {
    return [...hits];
  }

  const coreTargets = hits.flatMap((hit) =>
    hit.sourceType === 'example'
      ? []
      : hit.targets.filter(
          (target) =>
            target.kind === resource &&
            target.apiVersion !== undefined &&
            target.path !== undefined &&
            target.path !== 'metadata.name',
        ),
  );
  const examples = CORPUS.filter(
    (chunk) =>
      chunk.sourceType === 'example' &&
      chunk.targets.some((exampleTarget) =>
        coreTargets.some(
          (coreTarget) =>
            exampleTarget.apiVersion === coreTarget.apiVersion &&
            exampleTarget.kind === coreTarget.kind &&
            exampleTarget.path === coreTarget.path,
        ),
      ),
  );
  const existingExample = hits.some((hit) =>
    examples.some((example) => example.id === hit.id),
  );
  if (existingExample) return [...hits];
  if (examples.length === 1) return [...hits, toHit(examples[0]!)];
  if (examples.length > 1) return [...hits];

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
  return findExactFieldChunks(CORPUS, resource, fieldPath, apiVersion)
    .filter((chunk) => chunk.sourceType !== 'example')
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
  const questionResource = inferResource(question);
  const usesEditorTarget =
    mode !== 'free' ||
    questionResource === null ||
    questionResource === query.resourceHint;
  const routed =
    mode === 'free'
      ? (questionResource ?? query.resourceHint)
      : (query.resourceHint ?? questionResource);
  const routedApiVersion = usesEditorTarget
    ? query.apiVersionHint
    : undefined;
  const effectiveQuery: RetrievalQuery = {
    ...query,
    resourceHint: routed ?? undefined,
    apiVersionHint: routedApiVersion,
    fieldPathHint: usesEditorTarget ? query.fieldPathHint : undefined,
    selectedText: usesEditorTarget ? query.selectedText : undefined,
  };
  const text = retrievalText(effectiveQuery);

  const baseTrace = {
    question,
    mode,
    resourceHint: routed ?? undefined,
    apiVersionHint: routedApiVersion,
    fieldPathHint: effectiveQuery.fieldPathHint,
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
      effectiveQuery.fieldPathHint,
      routedApiVersion,
    ),
    { k, taskType: 'ask' },
  );
  const needsErrorStructureEvidence =
    mode === 'explain_error' &&
    hasSchemaFieldDescendants(
      CORPUS,
      routed ?? undefined,
      effectiveQuery.fieldPathHint,
      routedApiVersion,
    );
  if (exactHits.length > 0 && !needsErrorStructureEvidence) {
    const contextHits = withResourceExampleEvidence(exactHits, {
      question,
      mode,
      resource: routed ?? undefined,
      apiVersion: routedApiVersion,
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
  const {
    hits: ranked,
    trace: searchTrace,
    targetResource,
  } = await search(text, {
    boostResource: routed ?? undefined,
    boostPath: effectiveQuery.fieldPathHint,
    boostApiVersion: routedApiVersion,
    boostDirectSchemaChildren:
      needsErrorStructureEvidence &&
      (options.structuredErrorDirectSchemaChildBoost ?? true),
    queryExpansion: options.queryExpansion,
    retargetQueryText: (selectedResource) =>
      retrievalText({
        ...effectiveQuery,
        resourceHint: selectedResource,
        apiVersionHint: undefined,
        fieldPathHint: undefined,
      }),
    ...(options.runtimeAccess === undefined
      ? {}
      : { runtimeAccess: options.runtimeAccess }),
    ...(options.requestObserver === undefined
      ? {}
      : { requestObserver: options.requestObserver }),
  });
  const effectiveTargetResource = targetResource ?? routed ?? undefined;
  const usesInitialTarget = effectiveTargetResource === routed;
  const effectiveTargetApiVersion = usesInitialTarget
    ? routedApiVersion
    : undefined;
  const resourceExampleInput: ResourceExampleEvidenceInput = {
    question,
    mode,
    resource: effectiveTargetResource,
    apiVersion: effectiveTargetApiVersion,
    enabled: options.resourceExampleScaffoldEvidence ?? true,
  };
  const rankedHits = ranked.map(({ chunk, score }) => toHit(chunk, score));
  const coreCandidates = usesSupplementalResourceExample(resourceExampleInput)
    ? rankedHits.filter((hit) => hit.sourceType !== 'example')
    : rankedHits;
  const hits = selectContextHits(coreCandidates, { k, taskType: 'ask' });
  const finalHits = withResourceExampleEvidence(
    hits,
    resourceExampleInput,
  );
  const { context, sources } = formatSources(finalHits);

  const trace = emit({
    ...baseTrace,
    ...searchTrace,
    resourceHint: effectiveTargetResource,
    apiVersionHint: effectiveTargetApiVersion,
    fieldPathHint: usesInitialTarget
      ? effectiveQuery.fieldPathHint
      : undefined,
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
