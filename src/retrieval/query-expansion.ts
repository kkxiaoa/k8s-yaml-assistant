import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_ALIASES_PATH = join(
  process.cwd(),
  'data',
  'aliases',
  'schema-field-aliases.jsonl',
);

export interface SchemaFieldAlias {
  id: string;
  resource: string;
  path: string;
  chunkId: string;
  fieldTerms: string[];
  zhAliases: string[];
  source: 'llm_offline';
  reviewed: boolean;
  reviewedAt: string | null;
  reviewNote: string;
}

export interface MatchedAlias {
  chunkId: string;
  resource: string;
  path: string;
  zhAlias: string;
}

export interface QueryExpansionResult {
  originalQueryText: string;
  expandedQueryText: string;
  matchedAliases: MatchedAlias[];
  expansionTerms: string[];
}

type ResourceStrategy = 'routed-only' | 'alias-aware';

export function loadReviewedAliases(path = DEFAULT_ALIASES_PATH): SchemaFieldAlias[] {
  if (!existsSync(path)) return [];

  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SchemaFieldAlias)
    .filter((alias) => alias.reviewed);
}

export function expandQueryWithAliases(
  queryText: string,
  routedResource: string | undefined,
  aliases: SchemaFieldAlias[],
  options: {
    maxFields?: number;
    maxTermsPerField?: number;
    resourceStrategy?: ResourceStrategy;
  } = {},
): QueryExpansionResult {
  const maxFields = options.maxFields ?? 3;
  const maxTermsPerField = options.maxTermsPerField ?? 5;
  const resourceStrategy = options.resourceStrategy ?? 'routed-only';
  const originalQueryText = queryText;

  if (!routedResource && resourceStrategy === 'routed-only') {
    return {
      originalQueryText,
      expandedQueryText: originalQueryText,
      matchedAliases: [],
      expansionTerms: [],
    };
  }

  const matched = aliases
    .filter(
      (alias) =>
        alias.reviewed &&
        (resourceStrategy === 'alias-aware' || alias.resource === routedResource),
    )
    .map((alias) => {
      const zhAlias = alias.zhAliases
        .filter((candidate) => queryText.includes(candidate))
        .sort((a, b) => b.length - a.length)[0];
      return zhAlias ? { alias, zhAlias } : null;
    })
    .filter((hit): hit is { alias: SchemaFieldAlias; zhAlias: string } => hit !== null)
    .slice(0, maxFields);

  const matchedAliases: MatchedAlias[] = matched.map(({ alias, zhAlias }) => ({
    chunkId: alias.chunkId,
    resource: alias.resource,
    path: alias.path,
    zhAlias,
  }));

  const expansionTerms = uniq(
    matched.flatMap(({ alias }) => [...alias.fieldTerms, alias.path].slice(0, maxTermsPerField)),
  );

  return {
    originalQueryText,
    expandedQueryText:
      expansionTerms.length > 0
        ? `${originalQueryText}\n\n字段术语: ${expansionTerms.join(' ')}`
        : originalQueryText,
    matchedAliases,
    expansionTerms,
  };
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
