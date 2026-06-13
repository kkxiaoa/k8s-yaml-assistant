// 语料知识库。Phase A 起,CORPUS 不再硬编码,而是从真实 K8s OpenAPI schema 自动生成
// (见 schema-corpus.ts)。Chunk 接口与 resource 元数据保持不变,retrieve/router/rerank 无需改动。

export type { Chunk } from './schema-corpus';
import { buildSchemaCorpus } from './schema-corpus';

export const CORPUS = buildSchemaCorpus();
