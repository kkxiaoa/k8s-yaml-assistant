// 共享 schema 加载层:把 data/schemas/*.json 读进来,供「知识库切片」和「校验」共用。
// 这是 Phase B 的设计闭环 —— 同一份 schema,既当问答知识源,又当校验规则。
// 产品化后优先读取 data/schemas/generated/*.json;没有生成产物时回退到当前 fixture。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import storageClass from '../../data/schemas/storageclass.json';
import pvc from '../../data/schemas/persistentvolumeclaim.json';
import pv from '../../data/schemas/persistentvolume.json';
import vsc from '../../data/schemas/volumesnapshotclass.json';
import vac from '../../data/schemas/volumeattributesclass.json';

export interface SchemaNode {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
}

export interface SchemaDoc {
  resource: string;
  apiVersion: string;
  group?: string;
  version?: string;
  kind?: string;
  schema: SchemaNode;
  source?: 'builtin' | 'cluster' | 'crd';
}

const FIXTURE_SCHEMA_DOCS = [storageClass, pvc, pv, vsc, vac] as unknown as SchemaDoc[];

function normalizeSchemaDoc(doc: SchemaDoc): SchemaDoc {
  return {
    ...doc,
    kind: doc.kind ?? doc.resource,
    resource: doc.resource ?? doc.kind,
    source: doc.source ?? 'builtin',
  };
}

export function loadSchemaDocs(): SchemaDoc[] {
  const generatedDir = join(process.cwd(), 'data', 'schemas', 'generated');
  if (!existsSync(generatedDir)) return FIXTURE_SCHEMA_DOCS.map(normalizeSchemaDoc);

  const generatedDocs = readdirSync(generatedDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(generatedDir, file), 'utf8');
      return normalizeSchemaDoc(JSON.parse(raw) as SchemaDoc);
    });

  if (generatedDocs.length === 0) return FIXTURE_SCHEMA_DOCS.map(normalizeSchemaDoc);

  const byKey = new Map(generatedDocs.map((doc) => [`${doc.apiVersion}/${doc.kind ?? doc.resource}`, doc]));
  for (const doc of FIXTURE_SCHEMA_DOCS.map(normalizeSchemaDoc)) {
    byKey.set(`${doc.apiVersion}/${doc.kind ?? doc.resource}`, doc);
  }
  return Array.from(byKey.values());
}

export const SCHEMA_DOCS = loadSchemaDocs();

/** 按 kind 找对应的 schema 文档。 */
export function getSchemaForKind(kind: string): SchemaDoc | undefined {
  return SCHEMA_DOCS.find((d) => (d.kind ?? d.resource) === kind);
}
