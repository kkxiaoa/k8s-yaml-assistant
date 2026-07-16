// A3:校验 schema-field alias target/alias 可追溯性。纯本地检查,不调用模型。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS } from '../src/knowledge/corpus';
import { primaryPath, primaryResource } from '../src/knowledge/chunk';
import { RETRIEVAL_CASES } from '../src/eval/cases/retrieval-cases';
import {
  DEFAULT_ALIASES_PATH,
  parseSchemaFieldAliasesJsonl,
  type SchemaFieldAlias,
} from '../src/retrieval/query-expansion';

const TARGETS_PATH = join(
  process.cwd(),
  'data',
  'aliases',
  'schema-field-alias-targets.json',
);
type AliasTargetSource =
  | 'retrieval_bad_case'
  | 'retrieval_eval_miss'
  | 'curated_common_field'
  | 'product_workflow_field';
type AliasPriority = 'high' | 'medium' | 'low';

const TARGET_SOURCES = new Set<AliasTargetSource>([
  'retrieval_bad_case',
  'retrieval_eval_miss',
  'curated_common_field',
  'product_workflow_field',
]);
const TARGET_PRIORITIES = new Set<AliasPriority>(['high', 'medium', 'low']);

interface AliasTarget {
  id: string;
  resource: string;
  path: string;
  chunkId: string;
  evalCaseIds: string[];
  metric: boolean;
  source: AliasTargetSource;
  priority: AliasPriority;
  note?: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function readTargets(): AliasTarget[] {
  if (!existsSync(TARGETS_PATH)) fail(`target 文件不存在: ${TARGETS_PATH}`);
  const parsed = JSON.parse(readFileSync(TARGETS_PATH, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) fail('target 文件必须是数组');
  return parsed.map((item, i) => {
    const row = item as Partial<AliasTarget>;
    if (!row.id) fail(`target[${i}].id 缺失`);
    if (!row.resource) fail(`target[${i}].resource 缺失`);
    if (!row.path) fail(`target[${i}].path 缺失`);
    if (!row.chunkId) fail(`target[${i}].chunkId 缺失`);
    if (!Array.isArray(row.evalCaseIds) || row.evalCaseIds.length === 0)
      fail(`target[${i}].evalCaseIds 必须是非空数组`);
    if (typeof row.metric !== 'boolean') fail(`target[${i}].metric 必须是 boolean`);
    if (!TARGET_SOURCES.has(row.source as AliasTargetSource))
      fail(`target[${i}].source 非法: ${String(row.source)}`);
    if (!TARGET_PRIORITIES.has(row.priority as AliasPriority))
      fail(`target[${i}].priority 非法: ${String(row.priority)}`);
    return row as AliasTarget;
  });
}

function readAliases(): SchemaFieldAlias[] {
  if (!existsSync(DEFAULT_ALIASES_PATH)) return [];
  return parseSchemaFieldAliasesJsonl(
    readFileSync(DEFAULT_ALIASES_PATH, 'utf8'),
  );
}

function main(): void {
  const targets = readTargets();
  const targetIds = new Set<string>();
  const targetByChunkId = new Map<string, AliasTarget>();
  const evalIds = new Set(RETRIEVAL_CASES.map((c) => c.id));

  for (const target of targets) {
    if (targetIds.has(target.id)) fail(`target id 重复: ${target.id}`);
    targetIds.add(target.id);

    const chunk = CORPUS.find((c) => c.id === target.chunkId);
    if (!chunk) fail(`target ${target.id}: chunk 不存在 ${target.chunkId}`);
    if (chunk.sourceType !== 'schema')
      fail(`target ${target.id}: chunk 不是 schema source ${target.chunkId}`);
    if (primaryResource(chunk) !== target.resource)
      fail(`target ${target.id}: resource 不一致 target=${target.resource}, chunk=${primaryResource(chunk)}`);
    if (primaryPath(chunk) !== target.path)
      fail(`target ${target.id}: path 不一致 target=${target.path}, chunk=${primaryPath(chunk)}`);

    for (const evalCaseId of target.evalCaseIds) {
      if (!evalIds.has(evalCaseId))
        fail(`target ${target.id}: evalCase 不存在 ${evalCaseId}`);
    }

    targetByChunkId.set(target.chunkId, target);
  }

  const aliases = readAliases();
  const aliasIds = new Set<string>();
  let reviewed = 0;
  let unreviewed = 0;

  for (const alias of aliases) {
    if (aliasIds.has(alias.id)) fail(`alias id 重复: ${alias.id}`);
    aliasIds.add(alias.id);

    const target = targetByChunkId.get(alias.chunkId);
    if (!target) fail(`alias ${alias.id}: chunkId 不在 target seed 中 ${alias.chunkId}`);
    if (alias.resource !== target.resource)
      fail(`alias ${alias.id}: resource 不一致 alias=${alias.resource}, target=${target.resource}`);
    if (alias.path !== target.path)
      fail(`alias ${alias.id}: path 不一致 alias=${alias.path}, target=${target.path}`);

    if (alias.reviewed) reviewed++;
    else unreviewed++;
  }

  console.log(`targets: ${targets.length} ok`);
  if (!existsSync(DEFAULT_ALIASES_PATH)) {
    console.log('aliases: 文件未生成');
  } else {
    console.log(`aliases: ${reviewed} reviewed / ${unreviewed} unreviewed`);
  }
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
