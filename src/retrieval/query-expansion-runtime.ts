import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_ALIASES_PATH,
  expandQueryWithAliases,
  parseSchemaFieldAliasesJsonl,
  type MatchedAlias,
  type ResourceSelectionReason,
  type SchemaFieldAlias,
} from './query-expansion';

export type QueryExpansionErrorCode =
  | 'aliases_missing'
  | 'aliases_invalid';

export type QueryExpansionStatus =
  | 'applied'
  | 'no_match'
  | 'disabled'
  | 'skipped_exact'
  | 'failed';

export interface QueryExpansionTrace {
  enabled: boolean;
  status: QueryExpansionStatus;
  originalQueryText: string;
  expandedQueryText: string;
  matchedAliases: MatchedAlias[];
  expansionTerms: string[];
  routedResource?: string;
  selectedResource?: string;
  resourceSelectionReason?: ResourceSelectionReason;
  registryHash?: string;
  reviewedAliasCount?: number;
  errorCode?: QueryExpansionErrorCode;
}

export interface AliasRegistrySnapshot {
  aliases: SchemaFieldAlias[];
  registryHash: string;
  reviewedAliasCount: number;
}

export type AliasRegistryLoadResult =
  | { ok: true; snapshot: AliasRegistrySnapshot }
  | { ok: false; errorCode: QueryExpansionErrorCode };

export interface PreparedQueryExpansion {
  queryText: string;
  boostResource?: string;
  boostPath?: string;
  trace: QueryExpansionTrace;
}

export function skippedExactQueryExpansionTrace(
  queryText: string,
  routedResource: string | undefined,
  enabled: boolean,
): QueryExpansionTrace {
  return {
    enabled,
    status: enabled ? 'skipped_exact' : 'disabled',
    originalQueryText: queryText,
    expandedQueryText: queryText,
    matchedAliases: [],
    expansionTerms: [],
    routedResource,
    selectedResource: routedResource,
  };
}

export function resolveQueryExpansionEnabled(
  override: boolean | undefined,
  raw = process.env.ENABLE_QUERY_EXPANSION,
): boolean {
  return override ?? raw !== 'false';
}

export function loadAliasRegistrySnapshot(
  path = DEFAULT_ALIASES_PATH,
): AliasRegistryLoadResult {
  if (!existsSync(path)) {
    return { ok: false, errorCode: 'aliases_missing' };
  }

  try {
    const raw = readFileSync(path, 'utf8');
    const aliases = parseSchemaFieldAliasesJsonl(raw).filter(
      (alias) => alias.reviewed,
    );
    return {
      ok: true,
      snapshot: {
        aliases,
        registryHash: createHash('sha256').update(raw).digest('hex'),
        reviewedAliasCount: aliases.length,
      },
    };
  } catch {
    return { ok: false, errorCode: 'aliases_invalid' };
  }
}

let cachedRegistry: AliasRegistryLoadResult | undefined;
let warnedRegistryFailure = false;

export function getCachedAliasRegistry(): AliasRegistryLoadResult {
  cachedRegistry ??= loadAliasRegistrySnapshot();
  if (!cachedRegistry.ok && !warnedRegistryFailure) {
    warnedRegistryFailure = true;
    console.warn(
      `[query-expansion] registry unavailable: ${cachedRegistry.errorCode}; falling back to original query`,
    );
  }
  return cachedRegistry;
}

export function prepareQueryExpansion(
  queryText: string,
  routedResource: string | undefined,
  enabled: boolean,
  registry?: AliasRegistryLoadResult,
): PreparedQueryExpansion {
  const base = {
    enabled,
    originalQueryText: queryText,
    expandedQueryText: queryText,
    matchedAliases: [],
    expansionTerms: [],
    routedResource,
    selectedResource: routedResource,
  } satisfies Omit<
    QueryExpansionTrace,
    'status' | 'resourceSelectionReason' | 'errorCode'
  >;

  if (!enabled) {
    return {
      queryText,
      boostResource: routedResource,
      trace: { ...base, status: 'disabled' },
    };
  }

  if (!registry?.ok) {
    return {
      queryText,
      boostResource: routedResource,
      trace: {
        ...base,
        status: 'failed',
        errorCode: registry?.errorCode ?? 'aliases_invalid',
      },
    };
  }

  try {
    const result = expandQueryWithAliases(
      queryText,
      routedResource,
      registry.snapshot.aliases,
      { resourceStrategy: 'alias-aware' },
    );
    const selectedResource =
      result.aliasSelectedResource ?? routedResource;
    const onlyMatch =
      result.matchedAliases.length === 1
        ? result.matchedAliases[0]
        : undefined;
    return {
      queryText: result.expandedQueryText,
      boostResource: selectedResource,
      boostPath:
        selectedResource && onlyMatch?.resource === selectedResource
          ? onlyMatch.path
          : undefined,
      trace: {
        ...base,
        status:
          result.matchedAliases.length > 0 ? 'applied' : 'no_match',
        expandedQueryText: result.expandedQueryText,
        matchedAliases: result.matchedAliases,
        expansionTerms: result.expansionTerms,
        selectedResource,
        resourceSelectionReason: result.resourceSelectionReason,
        registryHash: registry.snapshot.registryHash,
        reviewedAliasCount: registry.snapshot.reviewedAliasCount,
      },
    };
  } catch {
    return {
      queryText,
      boostResource: routedResource,
      trace: {
        ...base,
        status: 'failed',
        errorCode: 'aliases_invalid',
      },
    };
  }
}
