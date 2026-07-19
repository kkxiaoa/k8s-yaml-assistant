// 校验 alias target、草稿和正式注册表的可追溯性；仅显式 --apply 时合并正式注册表。

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CORPUS } from '../src/knowledge/corpus';
import { primaryPath, primaryResource } from '../src/knowledge/chunk';
import { RETRIEVAL_CASES } from '../src/eval/cases/retrieval-cases';
import { resolveTuningEligibleCasesById } from '../src/eval/cases/governance';
import {
  DEFAULT_ALIAS_DRAFT_DIR,
  DEFAULT_ALIASES_PATH,
  mergeReviewedAliasDraft,
  parseSchemaFieldAliasesJsonl,
  serializeSchemaFieldAliasesJsonl,
  type SchemaFieldAlias,
} from '../src/retrieval/query-expansion';
import { readJsonFile, writeTextAtomic } from '../src/shared/json';

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
type Mode = 'registry' | 'draft' | 'review';

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

interface Options {
  mode: Mode;
  aliasesPath: string;
  apply: boolean;
}

interface AliasCounts {
  reviewed: number;
  unreviewed: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function resolveDraftPath(value: string): string {
  const draftRoot = resolve(DEFAULT_ALIAS_DRAFT_DIR);
  const path = resolve(process.cwd(), value);
  const relativePath = relative(draftRoot, path);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath) ||
    !relativePath.endsWith('.jsonl')
  ) {
    fail(`draft 必须是 ${DEFAULT_ALIAS_DRAFT_DIR} 下的 .jsonl 文件`);
  }
  return path;
}

function parseOptions(argv: string[]): Options {
  if (argv.length === 0) {
    return { mode: 'registry', aliasesPath: DEFAULT_ALIASES_PATH, apply: false };
  }
  if (argv[0] === '--draft' && argv.length === 2) {
    return {
      mode: 'draft',
      aliasesPath: resolveDraftPath(argv[1] ?? ''),
      apply: false,
    };
  }
  if (
    argv[0] === '--review' &&
    (argv.length === 2 || (argv.length === 3 && argv[2] === '--apply'))
  ) {
    return {
      mode: 'review',
      aliasesPath: resolveDraftPath(argv[1] ?? ''),
      apply: argv[2] === '--apply',
    };
  }
  fail(
    '用法: aliases:check [-- --draft <draft.jsonl>] 或 aliases:review -- <draft.jsonl> [--apply]',
  );
}

function readTargets(): AliasTarget[] {
  if (!existsSync(TARGETS_PATH)) fail(`target 文件不存在: ${TARGETS_PATH}`);
  const parsed = readJsonFile(TARGETS_PATH, 'alias targets');
  if (!Array.isArray(parsed)) fail('target 文件必须是数组');
  return parsed.map((item, i) => {
    const row = item as Partial<AliasTarget>;
    if (!row.id) fail(`target[${i}].id 缺失`);
    if (!row.resource) fail(`target[${i}].resource 缺失`);
    if (!row.path) fail(`target[${i}].path 缺失`);
    if (!row.chunkId) fail(`target[${i}].chunkId 缺失`);
    if (!Array.isArray(row.evalCaseIds) || row.evalCaseIds.length === 0) {
      fail(`target[${i}].evalCaseIds 必须是非空数组`);
    }
    if (typeof row.metric !== 'boolean') {
      fail(`target[${i}].metric 必须是 boolean`);
    }
    if (!TARGET_SOURCES.has(row.source as AliasTargetSource)) {
      fail(`target[${i}].source 非法: ${String(row.source)}`);
    }
    if (!TARGET_PRIORITIES.has(row.priority as AliasPriority)) {
      fail(`target[${i}].priority 非法: ${String(row.priority)}`);
    }
    return row as AliasTarget;
  });
}

function readAliases(path: string, allowMissing: boolean): SchemaFieldAlias[] {
  if (!existsSync(path)) {
    if (allowMissing) return [];
    fail(`alias 文件不存在: ${path}`);
  }
  try {
    return parseSchemaFieldAliasesJsonl(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `alias 文件无效 ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function validateTargets(targets: AliasTarget[]): Map<string, AliasTarget> {
  const targetIds = new Set<string>();
  const targetByChunkId = new Map<string, AliasTarget>();

  for (const target of targets) {
    if (targetIds.has(target.id)) fail(`target id 重复: ${target.id}`);
    if (targetByChunkId.has(target.chunkId)) {
      fail(`target chunkId 重复: ${target.chunkId}`);
    }
    targetIds.add(target.id);

    const chunk = CORPUS.find((item) => item.id === target.chunkId);
    if (!chunk) fail(`target ${target.id}: chunk 不存在 ${target.chunkId}`);
    if (chunk.sourceType !== 'schema') {
      fail(`target ${target.id}: chunk 不是 schema source ${target.chunkId}`);
    }
    if (primaryResource(chunk) !== target.resource) {
      fail(
        `target ${target.id}: resource 不一致 target=${target.resource}, chunk=${primaryResource(chunk)}`,
      );
    }
    if (primaryPath(chunk) !== target.path) {
      fail(
        `target ${target.id}: path 不一致 target=${target.path}, chunk=${primaryPath(chunk)}`,
      );
    }

    resolveTuningEligibleCasesById(
      target.evalCaseIds,
      RETRIEVAL_CASES,
      `target ${target.id}`,
    );
    targetByChunkId.set(target.chunkId, target);
  }

  return targetByChunkId;
}

function validateAliases(
  aliases: readonly SchemaFieldAlias[],
  targetByChunkId: ReadonlyMap<string, AliasTarget>,
): AliasCounts {
  const aliasIds = new Set<string>();
  let reviewed = 0;
  let unreviewed = 0;

  for (const alias of aliases) {
    if (aliasIds.has(alias.id)) fail(`alias id 重复: ${alias.id}`);
    aliasIds.add(alias.id);

    const target = targetByChunkId.get(alias.chunkId);
    if (!target) {
      fail(`alias ${alias.id}: chunkId 不在 target seed 中 ${alias.chunkId}`);
    }
    if (alias.id !== target.id) {
      fail(`alias ${alias.id}: id 与 target 不一致 ${target.id}`);
    }
    if (alias.resource !== target.resource) {
      fail(
        `alias ${alias.id}: resource 不一致 alias=${alias.resource}, target=${target.resource}`,
      );
    }
    if (alias.path !== target.path) {
      fail(
        `alias ${alias.id}: path 不一致 alias=${alias.path}, target=${target.path}`,
      );
    }

    if (alias.reviewed) reviewed++;
    else unreviewed++;
  }

  return { reviewed, unreviewed };
}

function displayPath(path: string): string {
  return relative(process.cwd(), path) || path;
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const targets = readTargets();
  const targetByChunkId = validateTargets(targets);
  console.log(`targets: ${targets.length} ok`);

  if (options.mode === 'registry') {
    const aliases = readAliases(options.aliasesPath, true);
    if (!existsSync(options.aliasesPath)) {
      console.log('aliases: 文件未生成');
      return;
    }
    const counts = validateAliases(aliases, targetByChunkId);
    console.log(
      `aliases: ${counts.reviewed} reviewed / ${counts.unreviewed} unreviewed`,
    );
    return;
  }

  const draftAliases = readAliases(options.aliasesPath, false);
  const draftCounts = validateAliases(draftAliases, targetByChunkId);
  console.log(
    `draft: ${draftCounts.reviewed} reviewed / ${draftCounts.unreviewed} unreviewed → ${displayPath(options.aliasesPath)}`,
  );
  if (options.mode === 'draft') return;

  const currentAliases = readAliases(DEFAULT_ALIASES_PATH, true);
  validateAliases(currentAliases, targetByChunkId);
  const merged = mergeReviewedAliasDraft(currentAliases, draftAliases);
  validateAliases(merged.aliases, targetByChunkId);
  console.log(
    `merge: ${merged.addedIds.length} added / ${merged.updatedIds.length} updated / ${merged.unchangedIds.length} unchanged; registry ${currentAliases.length} → ${merged.aliases.length}`,
  );

  if (!options.apply) {
    console.log('preview only: 正式 registry 未修改；确认后追加 --apply');
    return;
  }
  if (merged.addedIds.length === 0 && merged.updatedIds.length === 0) {
    console.log('apply: 没有内容变化，正式 registry 未修改');
    return;
  }

  writeTextAtomic(
    DEFAULT_ALIASES_PATH,
    serializeSchemaFieldAliasesJsonl(merged.aliases),
  );
  console.log(`apply: 已原子合并 → ${displayPath(DEFAULT_ALIASES_PATH)}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
