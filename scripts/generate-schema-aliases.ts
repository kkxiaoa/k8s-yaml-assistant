// A3:离线生成 schema-field alias 草稿。输出必须人工 review 后才可用于 A/B。

import { config } from 'dotenv';
config({ override: true });
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS } from '../src/knowledge/corpus';
import { primaryPath, primaryResource } from '../src/knowledge/chunk';
import { getClient } from '../src/server/pipeline';
import { textOf } from '../src/eval/llm';

const MODEL = 'claude-sonnet-4-6';
const TARGETS_PATH = join(
  process.cwd(),
  'data',
  'aliases',
  'schema-field-alias-targets.json',
);
const ALIASES_PATH = join(
  process.cwd(),
  'data',
  'aliases',
  'schema-field-aliases.jsonl',
);

interface AliasTarget {
  id: string;
  resource: string;
  path: string;
  chunkId: string;
}

interface ModelAliasDraft {
  fieldTerms: string[];
  weakZhAliases: string[];
  strongZhAliases: string[];
}

interface SchemaFieldAlias {
  id: string;
  resource: string;
  path: string;
  chunkId: string;
  fieldTerms: string[];
  weakZhAliases: string[];
  strongZhAliases: string[];
  source: 'llm_offline';
  reviewed: false;
  reviewedAt: null;
  reviewNote: '';
}

const SYSTEM = `你为 Kubernetes schema 字段生成检索 alias 草稿。
只根据给定 resource/path/chunk text 生成:
- fieldTerms: 英文字段术语,只能来自 path、description、enum/type 中出现或直接派生的术语。
- weakZhAliases: 中文用户可能问法,适合在已明确 resource 相同时扩展,不得跨 resource 改写意图。
- strongZhAliases: 中文用户可能问法,必须足够具体,可在无 route 或 route 可能错误时定位到该 resource/path。
禁止加入字段没有表达的行为、建议、平台策略或 Kubernetes 常识。
输出严格 JSON,格式:
{"fieldTerms":["..."],"weakZhAliases":["..."],"strongZhAliases":["..."]}`;

function readTargets(): AliasTarget[] {
  if (!existsSync(TARGETS_PATH)) throw new Error(`target 文件不存在: ${TARGETS_PATH}`);
  const parsed = JSON.parse(readFileSync(TARGETS_PATH, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('target 文件必须是数组');
  return parsed.map((row) => row as AliasTarget);
}

function parseModelAliasDraft(text: string): ModelAliasDraft {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`模型未返回 JSON: ${text}`);
  const parsed = JSON.parse(match[0]) as Partial<ModelAliasDraft>;
  if (!Array.isArray(parsed.fieldTerms)) throw new Error('fieldTerms 必须是数组');
  if (!Array.isArray(parsed.weakZhAliases)) throw new Error('weakZhAliases 必须是数组');
  if (!Array.isArray(parsed.strongZhAliases)) throw new Error('strongZhAliases 必须是数组');
  return {
    fieldTerms: parsed.fieldTerms
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean),
    weakZhAliases: parsed.weakZhAliases
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean),
    strongZhAliases: parsed.strongZhAliases
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean),
  };
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

async function generateAlias(target: AliasTarget): Promise<SchemaFieldAlias> {
  const chunk = CORPUS.find((c) => c.id === target.chunkId);
  if (!chunk) throw new Error(`chunk 不存在: ${target.chunkId}`);
  if (chunk.sourceType !== 'schema') throw new Error(`非 schema chunk: ${target.chunkId}`);
  if (
    primaryResource(chunk) !== target.resource ||
    primaryPath(chunk) !== target.path
  ) {
    throw new Error(`target 与 chunk 不一致: ${target.id}`);
  }

  const user = `resource: ${target.resource}
path: ${target.path}
chunkId: ${target.chunkId}
chunk text:
${chunk.text}`;
  let draft: ModelAliasDraft | null = null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      draft = parseModelAliasDraft(await textOf(getClient(), MODEL, SYSTEM, user));
      break;
    } catch (e) {
      lastError = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!draft) throw lastError;

  return {
    id: target.id,
    resource: target.resource,
    path: target.path,
    chunkId: target.chunkId,
    fieldTerms: uniq([...draft.fieldTerms, target.path]),
    weakZhAliases: uniq(draft.weakZhAliases),
    strongZhAliases: uniq(draft.strongZhAliases),
    source: 'llm_offline',
    reviewed: false,
    reviewedAt: null,
    reviewNote: '',
  };
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY 未设置');

  const targets = readTargets();
  const aliases: SchemaFieldAlias[] = [];
  for (const target of targets) {
    const alias = await generateAlias(target);
    aliases.push(alias);
    console.error(
      `✓ ${alias.id}: terms=${alias.fieldTerms.length}, weak=${alias.weakZhAliases.length}, strong=${alias.strongZhAliases.length}`,
    );
  }

  writeFileSync(ALIASES_PATH, aliases.map((a) => JSON.stringify(a)).join('\n') + '\n');
  console.error(`\n已写 alias 草稿 ${aliases.length} 条 → ${ALIASES_PATH}`);
  console.error('注意:全部 reviewed=false,人工审计通过前不会进入 A/B。');
}

main().catch((e: unknown) => {
  console.error('aliases:generate 失败:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
