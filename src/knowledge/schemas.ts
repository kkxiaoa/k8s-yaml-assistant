// 路线 A(精选语料):只加载 data/schemas/curated.json 白名单内的资源。
// generated 采用 resources + definitions registry 布局:
// - resources/*.json:按 apiVersion/kind 查找用户资源入口
// - definitions/*.json:按 OpenAPI definition name 本地解析 $ref,不请求网络

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import curated from '../../data/schemas/curated.json';

export interface SchemaNode {
  $ref?: string;
  allOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
  [key: string]: unknown;
}

export interface SchemaDoc {
  resource: string;
  apiVersion: string;
  group?: string;
  version?: string;
  kind?: string;
  schema: SchemaNode;
  source?: 'builtin' | 'cluster' | 'crd';
  definitionName?: string;
}

interface CuratedEntry {
  kind: string;
  apiVersion: string;
}

const GENERATED_DIR = join(process.cwd(), 'data', 'schemas', 'generated');
const RESOURCES_DIR = join(GENERATED_DIR, 'resources');
const DEFINITIONS_DIR = join(GENERATED_DIR, 'definitions');

function normalizeSchemaDoc(doc: SchemaDoc): SchemaDoc {
  return {
    ...doc,
    kind: doc.kind ?? doc.resource,
    resource: doc.resource ?? doc.kind,
    source: doc.source ?? 'cluster',
  };
}

function resourceFileNameOf(entry: CuratedEntry): string {
  const [group, version] = entry.apiVersion.includes('/')
    ? (entry.apiVersion.split('/') as [string, string])
    : ['core', entry.apiVersion];
  return `${group}.${version}.${entry.kind}.json`;
}

function refName(ref: string): string | null {
  const prefix = '#/components/schemas/';
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

function mergeSchemas(items: SchemaNode[]): SchemaNode {
  const merged: SchemaNode = {};
  for (const item of items) {
    Object.assign(merged, item);
    if (item.properties)
      merged.properties = { ...(merged.properties ?? {}), ...item.properties };
    if (item.required)
      merged.required = Array.from(
        new Set([...(merged.required ?? []), ...item.required]),
      );
    if (!merged.description && item.description)
      merged.description = item.description;
    if (!merged.type && item.type) merged.type = item.type;
  }
  return merged;
}

function mergeSiblingKeywords(base: SchemaNode, node: SchemaNode): SchemaNode {
  const out: SchemaNode = { ...base };
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' || key === 'allOf' || key === 'anyOf' || key === 'oneOf')
      continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = {
        ...(out.properties ?? {}),
        ...(value as Record<string, SchemaNode>),
      };
      continue;
    }
    if (key === 'required' && Array.isArray(value)) {
      out.required = Array.from(
        new Set([...(out.required ?? []), ...(value as string[])]),
      );
      continue;
    }
    out[key] = value;
  }
  return out;
}

function loadDefinitionRegistry(): Map<string, SchemaNode> {
  const registry = new Map<string, SchemaNode>();
  if (!existsSync(DEFINITIONS_DIR)) return registry;
  for (const file of readdirSync(DEFINITIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    registry.set(
      file.replace(/\.json$/, ''),
      JSON.parse(
        readFileSync(join(DEFINITIONS_DIR, file), 'utf8'),
      ) as SchemaNode,
    );
  }
  return registry;
}

export const SCHEMA_DEFINITIONS = loadDefinitionRegistry();

/**
 * 解析节点「这一层」:折叠自身的 $ref / allOf(合并 target/成员 + 同级关键字),
 * 但**不递归解析子节点** —— properties 的值、items 保持原样(含未展开的 $ref),
 * 留给调用方在下降到该子节点时再各自解析一次。
 *
 * 为什么懒解析:解析随遍历发生 —— 切片只到 MAX_SCHEMA_DEPTH、校验只到用户 YAML 出现的字段,
 * 都不会解析用不到的深层子树,也不会对已解析节点重复解析(此前的深解析是 O(树²) 且预展开整棵树)。
 * $ref 环:单次调用内沿 $ref/allOf 链累积 seen 截断;跨层由调用方的深度上限 / 数据深度天然收敛。
 * 需要看 items 内部(数组元素的 enum / properties)的调用方,对 items 再调一次本函数即可。
 */
export function resolveSchemaNode(
  node: SchemaNode,
  seen = new Set<string>(),
): SchemaNode {
  if (node.$ref) {
    const name = refName(node.$ref);
    if (!name || seen.has(name)) return mergeSiblingKeywords({}, node);
    const target = SCHEMA_DEFINITIONS.get(name);
    if (!target) return mergeSiblingKeywords({}, node);
    const resolved = resolveSchemaNode(target, new Set([...seen, name]));
    return mergeSiblingKeywords(resolved, node);
  }

  if (node.allOf) {
    const base = mergeSiblingKeywords(
      mergeSchemas(node.allOf.map((item) => resolveSchemaNode(item, seen))),
      node,
    );
    delete base.$ref;
    delete base.allOf;
    return base;
  }

  return { ...node };
}

export function loadSchemaDocs(): SchemaDoc[] {
  if (!existsSync(RESOURCES_DIR)) {
    throw new Error(
      `缺少 ${RESOURCES_DIR}。请先运行 \`npm run ingest:schemas\` 生成 schema 语料。`,
    );
  }

  const entries = [
    ...(curated.builtin as CuratedEntry[]),
    ...(curated.crd as CuratedEntry[]),
  ];
  const missing: string[] = [];
  const docs = entries.flatMap((entry) => {
    const file = resourceFileNameOf(entry);
    const path = join(RESOURCES_DIR, file);
    if (!existsSync(path)) {
      missing.push(`${entry.apiVersion}/${entry.kind}`);
      return [];
    }
    return [
      normalizeSchemaDoc(JSON.parse(readFileSync(path, 'utf8')) as SchemaDoc),
    ];
  });

  if (missing.length > 0) {
    throw new Error(
      `curated.json 白名单存在 generated 缺失资源: ${missing.join(', ')}`,
    );
  }
  if (docs.length === 0) {
    throw new Error('curated.json 白名单为空或未匹配到任何 generated 资源。');
  }
  return docs;
}

export const SCHEMA_DOCS = loadSchemaDocs();

/** 按 kind 找对应的 schema 文档。 */
export function getSchemaForKind(kind: string): SchemaDoc | undefined {
  return SCHEMA_DOCS.find((d) => (d.kind ?? d.resource) === kind);
}
