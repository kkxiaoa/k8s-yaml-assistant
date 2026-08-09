import { extractSourceUri } from '../retrieval/sources';
import type { Chunk, Provenance, SourceAuthority } from './chunk';
import { schemaChunkId, type KnowledgeTarget } from './identity';
import {
  resolveSchemaNode,
  SCHEMA_DOCS,
  type SchemaDoc,
  type SchemaNode,
  type SchemaSource,
} from './schemas';

const MAX_SCHEMA_DEPTH = 8;

const SCHEMA_AUTHORITIES: Record<SchemaSource, SourceAuthority> = {
  builtin: 'kubernetes_official',
  cluster: 'cluster_api',
  crd: 'extension_provider',
};

function referenceTypeName(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  const name = ref.split('/').at(-1)?.split('.').at(-1);
  return name && name.length > 0 ? name : undefined;
}

function schemaTypes(node: SchemaNode): string[] {
  const candidates = [
    node.type,
    ...(node.oneOf ?? []).map((item) => resolveSchemaNode(item).type),
    ...(node.anyOf ?? []).map((item) => resolveSchemaNode(item).type),
  ];
  return [...new Set(candidates.filter((value): value is string => value !== undefined))];
}

function mapConstraint(node: SchemaNode): string | undefined {
  const additional = node.additionalProperties;
  if (additional === undefined || additional === false) return undefined;
  if (additional === true) {
    return '动态键值映射，键名不固定，值类型未限定';
  }

  const resolved = resolveSchemaNode(additional);
  const reference = referenceTypeName(additional.$ref);
  const types = schemaTypes(resolved);
  const valueType = reference
    ? `${reference}${types.length === 0 ? '' : ` (${types.join(' / ')})`}`
    : types.join(' / ');
  return valueType.length > 0
    ? `动态键值映射，键名不固定，值类型 ${valueType}`
    : '动态键值映射，键名不固定，值受 additionalProperties 约束';
}

function chunkText(
  kind: string,
  path: string,
  node: SchemaNode,
  required: boolean,
): string {
  const parts = [
    `${kind} 的字段 ${path}:${node.description ?? '(无描述)'}`,
  ];

  if (node.type) parts.push(`类型 ${node.type}`);

  const map = mapConstraint(node);
  if (map) parts.push(map);

  const enumVals = node.enum ?? node.items?.enum;
  if (enumVals && enumVals.length > 0) {
    parts.push(`可选值 ${enumVals.join(' / ')}`);
  }

  if (required) parts.push('该字段必填');
  return parts.join('。');
}

function schemaProvenance(
  doc: SchemaDoc,
  description: string | undefined,
): Provenance {
  const sourceUri = extractSourceUri(description ?? '');
  return {
    authority: SCHEMA_AUTHORITIES[doc.source],
    ...(sourceUri === undefined ? {} : { sourceUri }),
    ...(doc.version === undefined ? {} : { version: doc.version }),
  };
}

function walk(
  doc: SchemaDoc,
  node: SchemaNode,
  prefix: string,
  out: Chunk[],
  depth: number,
): void {
  if (depth > MAX_SCHEMA_DEPTH || !node.properties) return;
  const kind = doc.kind ?? doc.resource;
  const requiredSet = new Set(node.required ?? []);

  for (const [name, child] of Object.entries(node.properties)) {
    const resolved = resolveSchemaNode(child);
    const items = resolved.items
      ? resolveSchemaNode(resolved.items)
      : undefined;
    const forText = items ? { ...resolved, items } : resolved;
    const path = prefix ? `${prefix}.${name}` : name;
    const target: KnowledgeTarget = {
      apiVersion: doc.apiVersion,
      kind,
      path,
    };
    out.push({
      id: schemaChunkId(target),
      title: `${kind} · ${path}`,
      text: chunkText(kind, path, forText, requiredSet.has(name)),
      sourceType: 'schema',
      provenance: schemaProvenance(doc, forText.description),
      targets: [target],
    });

    const nested = resolved.properties
      ? resolved
      : items?.properties
        ? items
        : null;
    if (nested) walk(doc, nested, path, out, depth + 1);
  }
}

export function buildSchemaCorpusForDoc(doc: SchemaDoc): Chunk[] {
  const out: Chunk[] = [];
  walk(doc, resolveSchemaNode(doc.schema), '', out, 0);
  return out;
}

export function buildSchemaCorpus(): Chunk[] {
  return SCHEMA_DOCS.flatMap((doc) => buildSchemaCorpusForDoc(doc));
}
