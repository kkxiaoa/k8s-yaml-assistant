// A3:targeted query expansion 归因 A/B。只读 reviewed alias,不写 bad-cases/baseline,不接 serving。

import { config } from 'dotenv';
config({ override: true });
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_SET, type EvalCase } from '../src/eval/eval-set';
import { inferResource } from '../src/retrieval/router';
import { searchCorpusTraced } from '../src/retrieval/retrieve';
import {
  expandQueryWithAliases,
  loadReviewedAliases,
  type MatchedAlias,
  type SchemaFieldAlias,
} from '../src/retrieval/query-expansion';

const TARGETS_PATH = join(
  process.cwd(),
  'data',
  'aliases',
  'schema-field-alias-targets.json',
);

interface AliasTarget {
  id: string;
  chunkId: string;
  evalCaseIds: string[];
  metric: boolean;
}

interface ABCase {
  evalCase: EvalCase;
  metric: boolean;
  targetIds: string[];
  targetChunkIds: string[];
}

interface RetrievalSide {
  top3: string[];
  top5: string[];
  recall3: number;
  reciprocalRank: number;
}

interface QueryVariant {
  label: 'auto/no-expansion' | 'auto/alias-expansion' | 'oracle/alias-expansion' | 'forced-target-expansion';
  queryText: string;
  boostResource: string | undefined;
  matchedAliases: MatchedAlias[];
  expansionTerms: string[];
}

interface ABResult {
  evalCaseId: string;
  metric: boolean;
  expectedChunkIds: string[];
  autoResource: string | undefined;
  oracleResource: string | undefined;
  variants: Record<QueryVariant['label'], RetrievalSide>;
  diagnostics: Record<QueryVariant['label'], Omit<QueryVariant, 'label'>>;
}

function readTargets(): AliasTarget[] {
  return JSON.parse(readFileSync(TARGETS_PATH, 'utf8')) as AliasTarget[];
}

function loadABCases(): ABCase[] {
  const evalById = new Map(EVAL_SET.map((ec) => [ec.id, ec]));
  const byEvalId = new Map<string, ABCase>();

  for (const target of readTargets()) {
    for (const evalCaseId of target.evalCaseIds) {
      const evalCase = evalById.get(evalCaseId);
      if (!evalCase) throw new Error(`eval case 不存在: ${evalCaseId}`);
      const existing = byEvalId.get(evalCaseId);
      if (existing) {
        existing.metric ||= target.metric;
        existing.targetIds.push(target.id);
        existing.targetChunkIds.push(target.chunkId);
      } else {
        byEvalId.set(evalCaseId, {
          evalCase,
          metric: target.metric,
          targetIds: [target.id],
          targetChunkIds: [target.chunkId],
        });
      }
    }
  }

  return [...byEvalId.values()];
}

function recallAt(ids: string[], expected: string[], k: number): number {
  const topK = ids.slice(0, k);
  return expected.filter((id) => topK.includes(id)).length / expected.length;
}

function reciprocalRank(ids: string[], expected: string[]): number {
  const firstIdx = ids.findIndex((id) => expected.includes(id));
  return firstIdx >= 0 ? 1 / (firstIdx + 1) : 0;
}

function side(ids: string[], expected: string[]): RetrievalSide {
  return {
    top3: ids.slice(0, 3),
    top5: ids.slice(0, 5),
    recall3: recallAt(ids, expected, 3),
    reciprocalRank: reciprocalRank(ids, expected),
  };
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function forceTargetExpansion(
  queryText: string,
  targetChunkIds: string[],
  aliases: SchemaFieldAlias[],
): Pick<QueryVariant, 'queryText' | 'matchedAliases' | 'expansionTerms'> {
  const matched = aliases.filter((alias) => targetChunkIds.includes(alias.chunkId));
  const expansionTerms = uniq(matched.flatMap((alias) => [...alias.fieldTerms, alias.path]));
  return {
    queryText:
      expansionTerms.length > 0
        ? `${queryText}\n\n字段术语: ${expansionTerms.join(' ')}`
        : queryText,
    matchedAliases: matched.map((alias) => ({
      chunkId: alias.chunkId,
      resource: alias.resource,
      path: alias.path,
      zhAlias: '<forced-target>',
    })),
    expansionTerms,
  };
}

async function evaluateVariant(
  variant: QueryVariant,
  expectedChunkIds: string[],
): Promise<RetrievalSide> {
  const result = await searchCorpusTraced(variant.queryText, {
    boostResource: variant.boostResource,
  });
  return side(
    result.hits.map((hit) => hit.chunk.id),
    expectedChunkIds,
  );
}

async function evaluateCase(abCase: ABCase): Promise<ABResult> {
  const aliases = loadReviewedAliases();
  const { evalCase } = abCase;
  const autoResource = inferResource(evalCase.question) ?? undefined;
  const oracleResource = evalCase.resource;

  const autoExpansion = expandQueryWithAliases(evalCase.question, autoResource, aliases, {
    resourceStrategy: 'alias-aware',
  });
  const oracleExpansion = expandQueryWithAliases(evalCase.question, oracleResource, aliases);
  const forced = forceTargetExpansion(evalCase.question, abCase.targetChunkIds, aliases);
  const aliasSelectedResource = autoExpansion.matchedAliases[0]?.resource ?? autoResource;

  const variants: QueryVariant[] = [
    {
      label: 'auto/no-expansion',
      queryText: evalCase.question,
      boostResource: autoResource,
      matchedAliases: [],
      expansionTerms: [],
    },
    {
      label: 'auto/alias-expansion',
      queryText: autoExpansion.expandedQueryText,
      boostResource: aliasSelectedResource,
      matchedAliases: autoExpansion.matchedAliases,
      expansionTerms: autoExpansion.expansionTerms,
    },
    {
      label: 'oracle/alias-expansion',
      queryText: oracleExpansion.expandedQueryText,
      boostResource: oracleResource,
      matchedAliases: oracleExpansion.matchedAliases,
      expansionTerms: oracleExpansion.expansionTerms,
    },
    {
      label: 'forced-target-expansion',
      queryText: forced.queryText,
      boostResource: oracleResource,
      matchedAliases: forced.matchedAliases,
      expansionTerms: forced.expansionTerms,
    },
  ];

  const retrievalSides = await Promise.all(
    variants.map((variant) => evaluateVariant(variant, evalCase.expectedChunkIds)),
  );

  return {
    evalCaseId: evalCase.id,
    metric: abCase.metric,
    expectedChunkIds: evalCase.expectedChunkIds,
    autoResource,
    oracleResource,
    variants: Object.fromEntries(
      variants.map((variant, index) => [variant.label, retrievalSides[index]!]),
    ) as ABResult['variants'],
    diagnostics: Object.fromEntries(
      variants.map((variant) => [
        variant.label,
        {
          queryText: variant.queryText,
          boostResource: variant.boostResource,
          matchedAliases: variant.matchedAliases,
          expansionTerms: variant.expansionTerms,
        },
      ]),
    ) as ABResult['diagnostics'],
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printDiagnostic(result: ABResult, label: QueryVariant['label']): void {
  const diagnostic = result.diagnostics[label];
  const sideResult = result.variants[label];
  console.log(
    `${label.padEnd(24)} R@3=${pct(sideResult.recall3)} MRR=${sideResult.reciprocalRank.toFixed(3)} boost=${diagnostic.boostResource ?? '<none>'}`,
  );
  console.log(
    `  matched: ${
      diagnostic.matchedAliases
        .map((a) => `${a.resource}::${a.path} <= ${a.zhAlias}`)
        .join(' ; ') || '<none>'
    }`,
  );
  console.log(`  terms: ${diagnostic.expansionTerms.join(' ') || '<none>'}`);
  console.log(`  top3: ${sideResult.top3.join(' | ')}`);
  console.log(`  top5: ${sideResult.top5.join(' | ')}`);
}

function printCase(result: ABResult): void {
  const base = result.variants['auto/no-expansion'];
  const forced = result.variants['forced-target-expansion'];
  const delta = forced.recall3 - base.recall3;
  const marker = delta > 0 ? 'FORCED_GAIN' : delta < 0 ? 'FORCED_LOSS' : 'FORCED_SAME';
  console.log(`\n━━ ${result.evalCaseId} [${result.metric ? 'metric' : 'observation'}] ${marker}`);
  console.log(`autoResource: ${result.autoResource ?? '<none>'}; oracleResource: ${result.oracleResource ?? '<none>'}`);
  console.log(`expected: ${result.expectedChunkIds.join(' | ')}`);
  printDiagnostic(result, 'auto/no-expansion');
  printDiagnostic(result, 'auto/alias-expansion');
  printDiagnostic(result, 'oracle/alias-expansion');
  printDiagnostic(result, 'forced-target-expansion');
}

function avg(items: ABResult[], pick: (r: ABResult) => number): number {
  return items.length === 0 ? 0 : items.reduce((sum, item) => sum + pick(item), 0) / items.length;
}

function printSummary(results: ABResult[]): void {
  const metric = results.filter((r) => r.metric);
  const observations = results.filter((r) => !r.metric);
  const labels: QueryVariant['label'][] = [
    'auto/no-expansion',
    'auto/alias-expansion',
    'oracle/alias-expansion',
    'forced-target-expansion',
  ];
  const base = 'auto/no-expansion' as const;

  console.log('\n━━━━━━ A3 targeted attribution A/B 汇总 ━━━━━━');
  console.log(`metric cases: ${metric.length}; observation cases: ${observations.length}`);
  for (const label of labels) {
    console.log(
      `${label.padEnd(24)} R@3=${pct(avg(metric, (r) => r.variants[label].recall3))} MRR=${avg(metric, (r) => r.variants[label].reciprocalRank).toFixed(3)}`,
    );
  }

  for (const label of labels.filter((label) => label !== base)) {
    const gained = metric.filter((r) => r.variants[label].recall3 > r.variants[base].recall3);
    const lost = metric.filter((r) => r.variants[label].recall3 < r.variants[base].recall3);
    console.log(`gained(${label} R@3 vs base): ${gained.map((r) => r.evalCaseId).join(', ') || '无'}`);
    console.log(`lost(${label} R@3 vs base): ${lost.map((r) => r.evalCaseId).join(', ') || '无'}`);
  }

  if (observations.length > 0) {
    console.log(
      `observations(forced): ${observations.map((r) => `${r.evalCaseId}:${pct(r.variants[base].recall3)}→${pct(r.variants['forced-target-expansion'].recall3)}`).join(', ')}`,
    );
  }
}

async function main(): Promise<void> {
  const cases = loadABCases();
  console.error(`A3 targeted attribution A/B cases: ${cases.length} 条`);

  const results: ABResult[] = [];
  for (const abCase of cases) {
    const result = await evaluateCase(abCase);
    results.push(result);
    printCase(result);
  }
  printSummary(results);
}

main().catch((e: unknown) => {
  console.error('aliases:ab 失败:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
