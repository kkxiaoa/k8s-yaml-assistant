import type { KnowledgeChunk, KnowledgeTarget } from '../knowledge/chunk';

function targetText(target: KnowledgeTarget): string {
  return [
    target.apiVersion === undefined
      ? undefined
      : `apiVersion=${target.apiVersion}`,
    `kind=${target.kind}`,
    target.path === undefined ? undefined : `path=${target.path}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join(', ');
}

/**
 * 官方文档和示例正文经常省略由标题和 targets 携带的资源、字段身份；这些元数据只进入
 * 检索输入，不改写展示给回答模型的原始证据。schema / policy 保持既有正文输入。
 */
export function retrievalDocumentText(
  chunk: KnowledgeChunk,
  includeTitle = false,
): string {
  const includeKnowledgeMetadata =
    chunk.sourceType === 'docs' || chunk.sourceType === 'example';
  const lines: string[] = [];
  if (includeKnowledgeMetadata || includeTitle) lines.push(chunk.title);
  if (includeKnowledgeMetadata && chunk.targets.length > 0) {
    lines.push(`规范目标: ${chunk.targets.map(targetText).join(' | ')}`);
  }
  lines.push(chunk.text);
  return lines.join('\n');
}
