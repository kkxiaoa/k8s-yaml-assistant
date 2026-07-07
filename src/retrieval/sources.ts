// §7.3 轻量 grounding:把检索 chunk 编号成带 [S1][S2] 的 context + sources 元数据。
// 生成层(pipeline / eval)共用同一段编号,答案引用 [S1] 可回溯到 source。

import type { SourceType, TrustLevel } from '../knowledge/schema-corpus';

/** 输入只需这几个字段——检索 Hit 或 Chunk 都满足。 */
export interface SourceInput {
  id: string;
  title: string;
  text: string;
  sourceType: SourceType;
  sourceUri?: string;
  trustLevel?: TrustLevel;
}

export interface Source {
  /** 引用编号,答案里以 [S{n}] 出现 */
  n: number;
  id: string;
  title: string;
  sourceType: SourceType;
  /** 官方文档链接,优先取 chunk 元数据,无则从文本 "More info: <url>" 回退提取 */
  sourceUri?: string;
  trustLevel?: TrustLevel;
}

/** context 里给来源打标签,让生成层能区分"官方事实"与"组织策略"分层表达。 */
const SOURCE_LABEL: Record<SourceType, string> = {
  schema: 'K8s schema',
  policy: '组织策略',
};

/**
 * 冲突表达规则:让答案区分"K8s 官方事实(schema)"与"平台组织策略(policy)"并分层表达。
 * serving(ASK_SYSTEM)与 eval(ANSWER_SYSTEM)共用同一段——含"policy 非 K8s 官方强制"红线,
 * 抽成单一来源避免两处逐字重复导致 eval/serving silent drift(无 test 能抓)。
 */
export const CONFLICT_RULES = `- 来源分工:标 [schema][K8s schema] 的是官方事实(字段是否合法/能填什么);标 [policy][组织策略] 的是平台组织规范(推荐/禁止怎么配),不是 K8s 官方强制。
- 冲突表达:当 schema 允许但 policy 禁止/不推荐时,同时说明两层。措辞严谨,例如:"image 字段在 K8s schema 层面允许填字符串,nginx:latest 能通过字段类型校验;但平台 policy 禁止 latest tag。"不要笼统说成"schema 合法"。
- 完整性:问题涉及"能不能/是否允许/推荐吗/生产可用吗",必须同时检查 schema 与 policy 来源;若未检索到 policy 来源,只答 schema 层事实并说明"未检索到组织规范"。
- 红线:不得把 policy 说成 K8s 官方强制;policy 一律标"组织策略/平台规范",强度由级别(required/forbidden/recommended/discouraged)表达。`;

/** 从 chunk 文本抽 "More info: https://..." 的 URL(到空白/中文标点为止)。 */
export function extractSourceUri(text: string): string | undefined {
  const m = text.match(/More info:\s*(https?:\/\/[^\s。,，]+)/);
  return m?.[1]?.replace(/[.,]+$/, ''); // 去掉误吞的末尾英文标点
}

/** chunk[] → { 带 [S1][S2] 编号的 context, sources 元数据 }。 */
export function formatSources(chunks: SourceInput[]): {
  context: string;
  sources: Source[];
} {
  const sources: Source[] = chunks.map((c, i) => ({
    n: i + 1,
    id: c.id,
    title: c.title,
    sourceType: c.sourceType,
    sourceUri: c.sourceUri ?? extractSourceUri(c.text),
    trustLevel: c.trustLevel,
  }));
  const context = chunks
    .map(
      (c, i) =>
        `[S${i + 1}][${c.sourceType}][${SOURCE_LABEL[c.sourceType]}] ${c.title}\n${c.text}`,
    )
    .join('\n\n');
  return { context, sources };
}
