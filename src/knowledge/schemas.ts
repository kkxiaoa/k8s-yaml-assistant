// 共享 schema 加载层:把 data/schemas/*.json 读进来,供「知识库切片」和「校验」共用。
// 这是 Phase B 的设计闭环 —— 同一份 schema,既当问答知识源,又当校验规则。
// 加一个资源/CRD:往 data/schemas/ 丢 JSON,在下面 SCHEMA_DOCS 加一行,问答+校验同时就懂。

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
  schema: SchemaNode;
}

export const SCHEMA_DOCS = [storageClass, pvc, pv, vsc, vac] as unknown as SchemaDoc[];

/** 按 kind 找对应的 schema 文档。 */
export function getSchemaForKind(kind: string): SchemaDoc | undefined {
  return SCHEMA_DOCS.find((d) => d.resource === kind);
}
