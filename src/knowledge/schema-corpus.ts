// Phase A:schema 驱动知识库。从真实 K8s OpenAPI v3 schema 自动生成 chunk(结构化切片)。
// 一字段一 chunk,自带 资源 + 路径 + 类型 + 枚举 + required 元数据(context injection)。
// schema 加载与查找见 ./schemas.ts(校验也复用同一份)。

import { resolveSchemaNode, SCHEMA_DOCS, type SchemaNode } from './schemas';

const MAX_SCHEMA_DEPTH = 8;

export interface Chunk {
  id: string;
  resource: string;
  path: string;
  title: string;
  text: string;
  sourceType: 'schema';
}

function chunkText(
  resource: string,
  path: string,
  node: SchemaNode,
  required: boolean,
): string {
  const parts = [
    `${resource} 的字段 ${path}:${node.description ?? '(无描述)'}`,
  ];

  if (node.type) parts.push(`类型 ${node.type}`);

  const enumVals = node.enum ?? node.items?.enum;
  if (enumVals && enumVals.length > 0)
    parts.push(`可选值 ${enumVals.join(' / ')}`);

  if (required) parts.push('该字段必填');
  return parts.join('。');
}

// node 约定为「已解析一层」(properties 存在、值可能仍含未展开 $ref)。
// 每个字段在本层各解析一次;下降时把已解析的 sub 传下去,不重复解析(避免 O(树²))。
function walk(
  resource: string,
  node: SchemaNode,
  prefix: string,
  out: Chunk[],
  depth: number,
): void {
  if (depth > MAX_SCHEMA_DEPTH || !node.properties) return;
  const requiredSet = new Set(node.required ?? []);
  for (const [name, child] of Object.entries(node.properties)) {
    const resolved = resolveSchemaNode(child);
    // 数组元素类型是字段的固有形态:再解析一层 items,让 items.enum / items.properties 可见。
    const items = resolved.items
      ? resolveSchemaNode(resolved.items)
      : undefined;
    const forText = items ? { ...resolved, items } : resolved;
    const path = prefix ? `${prefix}.${name}` : name;
    out.push({
      id: `${resource}::${path}`,
      resource,
      path,
      title: `${resource} · ${path}`,
      text: chunkText(resource, path, forText, requiredSet.has(name)),
      sourceType: 'schema',
    });
    const sub = resolved.properties
      ? resolved
      : items?.properties
        ? items
        : null;
    if (sub) walk(resource, sub, path, out, depth + 1);
  }
}

/** 把所有 schema 展开成 chunk 数组。根节点先解析一层再交给 walk。 */
export function buildSchemaCorpus(): Chunk[] {
  const out: Chunk[] = [];
  for (const doc of SCHEMA_DOCS)
    walk(doc.resource, resolveSchemaNode(doc.schema), '', out, 0);
  return out;
}
