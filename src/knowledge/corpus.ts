// 语料知识库:schema 单源(schema-corpus)+ Stage 6 起并入 policy 源(policy-corpus)。
// Chunk 接口统一,下游 retrieve/rerank/校验只认接口,不感知来源差异。

export type { Chunk } from './schema-corpus';
import { buildSchemaCorpus } from './schema-corpus';
import { buildPolicyCorpus } from './policy-corpus';

export const CORPUS = [...buildSchemaCorpus(), ...buildPolicyCorpus()];
