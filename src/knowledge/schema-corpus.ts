// Phase A:schema 驱动知识库。从真实 K8s OpenAPI v3 schema 自动生成 chunk(结构化切片)。
// 一字段一 chunk,自带 资源 + 路径 + 类型 + 枚举 + required 元数据(context injection)。
// 换成集群导出的真实 CRD schema 时,只要往 data/schemas/ 丢 JSON、在下面 DOCS 里加一行即可。

import storageClass from '../../data/schemas/storageclass.json';
import pvc from '../../data/schemas/persistentvolumeclaim.json';
import pv from '../../data/schemas/persistentvolume.json';
import vsc from '../../data/schemas/volumesnapshotclass.json';
import vac from '../../data/schemas/volumeattributesclass.json';

export interface Chunk {
  id: string;
  resource: string;
  title: string;
  text: string;
}

interface SchemaNode {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
}
interface SchemaDoc {
  resource: string;
  apiVersion: string;
  schema: SchemaNode;
}

const DOCS = [storageClass, pvc, pv, vsc, vac] as unknown as SchemaDoc[];

function chunkText(resource: string, path: string, node: SchemaNode, required: boolean): string {
  const parts = [`${resource} 的字段 ${path}:${node.description ?? '(无描述)'}`];
  if (node.type) parts.push(`类型 ${node.type}`);
  const enumVals = node.enum ?? node.items?.enum;
  if (enumVals && enumVals.length > 0) parts.push(`可选值 ${enumVals.join(' / ')}`);
  if (required) parts.push('该字段必填');
  return parts.join('。');
}

function walk(resource: string, node: SchemaNode, prefix: string, out: Chunk[], depth: number): void {
  if (depth > 4 || !node.properties) return;
  const requiredSet = new Set(node.required ?? []);
  for (const [name, child] of Object.entries(node.properties)) {
    const path = prefix ? `${prefix}.${name}` : name;
    out.push({
      id: `${resource}::${path}`,
      resource,
      title: `${resource} · ${path}`,
      text: chunkText(resource, path, child, requiredSet.has(name)),
    });
    // 递归对象 / 数组项的子属性
    const sub = child.properties ? child : child.items?.properties ? child.items : null;
    if (sub) walk(resource, sub, path, out, depth + 1);
  }
}

/** 把所有 schema 展开成 chunk 数组。 */
export function buildSchemaCorpus(): Chunk[] {
  const out: Chunk[] = [];
  for (const doc of DOCS) walk(doc.resource, doc.schema, '', out, 0);
  return out;
}
