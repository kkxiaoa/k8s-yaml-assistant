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
    .map((c, i) => `[S${i + 1}] ${c.title}\n${c.text}`)
    .join('\n\n');
  return { context, sources };
}
