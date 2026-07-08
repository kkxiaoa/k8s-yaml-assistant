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
  weakZhAliases: string[];
  strongZhAliases: string[];
  source: 'llm_offline';
  reviewed: boolean;
  reviewedAt: string | null;
  reviewNote: string;
}

export type AliasStrength = 'weak' | 'strong';

export type ResourceSelectionReason =
  | 'same_resource'
  | 'no_route_strong_alias'
  | 'cross_resource_strong_alias'
  | 'weak_alias_no_resource_override'
  | 'no_alias_match';

export interface MatchedAlias {
  chunkId: string;
  resource: string;
  path: string;
  zhAlias: string;
  strength: AliasStrength;
}

export interface QueryExpansionResult {
  originalQueryText: string;
  expandedQueryText: string;
  matchedAliases: MatchedAlias[];
  expansionTerms: string[];
  aliasSelectedResource: string | undefined;
  resourceSelectionReason: ResourceSelectionReason;
}

type ResourceStrategy = 'routed-only' | 'alias-aware';

interface AliasHit {
  alias: SchemaFieldAlias;
  zhAlias: string;
  strength: AliasStrength;
  reason: ResourceSelectionReason;
  canSelectResource: boolean;
}

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
      aliasSelectedResource: undefined,
      resourceSelectionReason: 'no_alias_match',
    };
  }

  const matched = aliases
    .filter((alias) => alias.reviewed)
    .map((alias): AliasHit | null => {
      const match = bestAliasMatch(queryText, alias);
      if (!match) return null;

      if (alias.resource === routedResource) {
        return {
          alias,
          ...match,
          reason: 'same_resource' as const,
          canSelectResource: true,
        };
      }

      if (!routedResource && match.strength === 'strong') {
        return {
          alias,
          ...match,
          reason: 'no_route_strong_alias' as const,
          canSelectResource: true,
        };
      }

      if (!routedResource && match.strength === 'weak') {
        return {
          alias,
          ...match,
          reason: 'weak_alias_no_resource_override' as const,
          canSelectResource: false,
        };
      }

      if (
        resourceStrategy === 'alias-aware' &&
        routedResource &&
        alias.resource !== routedResource &&
        match.strength === 'strong'
      ) {
        return {
          alias,
          ...match,
          reason: 'cross_resource_strong_alias' as const,
          canSelectResource: true,
        };
      }

      return null;
    })
    .filter((hit): hit is AliasHit => hit !== null)
    .slice(0, maxFields);

  const matchedAliases: MatchedAlias[] = matched.map(({ alias, zhAlias, strength }) => ({
    chunkId: alias.chunkId,
    resource: alias.resource,
    path: alias.path,
    zhAlias,
    strength,
  }));

  const expansionTerms = uniq(
    matched.flatMap(({ alias }) => [...alias.fieldTerms, alias.path].slice(0, maxTermsPerField)),
  );
  const aliasSelectedResource =
    matched.find((hit) => hit.canSelectResource)?.alias.resource ?? routedResource;
  const resourceSelectionReason = matched[0]?.reason ?? 'no_alias_match';

  return {
    originalQueryText,
    expandedQueryText:
      expansionTerms.length > 0
        ? `${originalQueryText}\n\n字段术语: ${expansionTerms.join(' ')}`
        : originalQueryText,
    matchedAliases,
    expansionTerms,
    aliasSelectedResource,
    resourceSelectionReason,
  };
}

function bestAliasMatch(
  queryText: string,
  alias: SchemaFieldAlias,
): { zhAlias: string; strength: AliasStrength } | null {
  const strong = alias.strongZhAliases
    .filter((candidate) => queryText.includes(candidate))
    .sort((a, b) => b.length - a.length)[0];
  if (strong) return { zhAlias: strong, strength: 'strong' };

  const weak = alias.weakZhAliases
    .filter((candidate) => queryText.includes(candidate))
    .sort((a, b) => b.length - a.length)[0];
  if (weak) return { zhAlias: weak, strength: 'weak' };

  return null;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
