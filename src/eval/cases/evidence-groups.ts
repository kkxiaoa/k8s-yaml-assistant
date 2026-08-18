import { z } from 'zod';

const NonBlankChunkIdSchema = z.string().trim().min(1);

export const EvidenceGroupSchema = z
  .strictObject({
    anyOfChunkIds: z.array(NonBlankChunkIdSchema).min(1),
  })
  .superRefine((group, context) => {
    const seen = new Set<string>();
    for (const [index, chunkId] of group.anyOfChunkIds.entries()) {
      if (seen.has(chunkId)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate evidence chunk id: ${chunkId}`,
          path: ['anyOfChunkIds', index],
        });
      }
      seen.add(chunkId);
    }
  });

export const RequiredEvidenceGroupsSchema = z
  .array(EvidenceGroupSchema)
  .min(1);

export type EvidenceGroup = z.infer<typeof EvidenceGroupSchema>;

export interface EvidenceMatch {
  groupIndex: number;
  chunkId: string;
  rank: number;
}

export interface EvidenceRanking {
  topKIds: string[];
  matches: EvidenceMatch[];
  firstRelevantRank: number | null;
  recall: number;
  reciprocalRank: number;
  fullRecall: boolean;
}

export function decodeRequiredEvidenceGroups(value: unknown): EvidenceGroup[] {
  return RequiredEvidenceGroupsSchema.parse(value);
}

export function exactEvidenceGroups(
  chunkIds: readonly string[],
): EvidenceGroup[] {
  return decodeRequiredEvidenceGroups(
    chunkIds.map((chunkId) => ({ anyOfChunkIds: [chunkId] })),
  );
}

export function canonicalEvidenceGroups(
  evidenceGroups: readonly EvidenceGroup[],
): EvidenceGroup[] {
  return evidenceGroups
    .map((group) => ({
      anyOfChunkIds: [...group.anyOfChunkIds].sort(),
    }))
    .sort((left, right) =>
      left.anyOfChunkIds.join('\n').localeCompare(right.anyOfChunkIds.join('\n')),
    );
}

function firstMatch(
  group: EvidenceGroup,
  rankedIds: readonly string[],
  limit: number,
): Omit<EvidenceMatch, 'groupIndex'> | null {
  const rankIndex = rankedIds
    .slice(0, limit)
    .findIndex((chunkId) => group.anyOfChunkIds.includes(chunkId));
  if (rankIndex < 0) return null;
  return {
    chunkId: rankedIds[rankIndex]!,
    rank: rankIndex + 1,
  };
}

export function evaluateEvidenceRanking(
  evidenceGroups: readonly EvidenceGroup[],
  rankedIds: readonly string[],
  k: number,
): EvidenceRanking {
  const matches = evidenceGroups.flatMap((group, groupIndex) => {
    const match = firstMatch(group, rankedIds, k);
    return match === null ? [] : [{ ...match, groupIndex }];
  });
  const relevantIds = new Set(
    evidenceGroups.flatMap((group) => group.anyOfChunkIds),
  );
  const firstIndex = rankedIds.findIndex((chunkId) => relevantIds.has(chunkId));
  const firstRelevantRank = firstIndex < 0 ? null : firstIndex + 1;
  const recall = matches.length / evidenceGroups.length;

  return {
    topKIds: [...rankedIds.slice(0, k)],
    matches,
    firstRelevantRank,
    recall,
    reciprocalRank:
      firstRelevantRank === null || firstRelevantRank > k
        ? 0
        : 1 / firstRelevantRank,
    fullRecall: matches.length === evidenceGroups.length,
  };
}
