import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
import {
  decodeRequiredEvidenceGroups,
  evaluateEvidenceRanking,
  exactEvidenceGroups,
} from './evidence-groups';

test('exact evidence creates one required group per chunk', () => {
  assert.deepEqual(exactEvidenceGroups(['schema-a', 'schema-b']), [
    { anyOfChunkIds: ['schema-a'] },
    { anyOfChunkIds: ['schema-b'] },
  ]);
});

test('evidence groups reject empty groups, blank IDs, and duplicates within one group', () => {
  for (const value of [
    [],
    [{ anyOfChunkIds: [] }],
    [{ anyOfChunkIds: ['   '] }],
    [{ anyOfChunkIds: ['schema-a', 'schema-a'] }],
  ]) {
    assert.throws(
      () => decodeRequiredEvidenceGroups(value),
      (error: unknown) => error instanceof ZodError,
    );
  }
});

test('one explicit alternative satisfies its group without satisfying unrelated groups', () => {
  const groups = decodeRequiredEvidenceGroups([
    { anyOfChunkIds: ['schema-a', 'docs-a'] },
    { anyOfChunkIds: ['schema-b', 'docs-b'] },
  ]);

  assert.deepEqual(
    evaluateEvidenceRanking(groups, ['docs-a', 'noise', 'schema-b'], 2),
    {
      topKIds: ['docs-a', 'noise'],
      matches: [{ groupIndex: 0, chunkId: 'docs-a', rank: 1 }],
      firstRelevantRank: 1,
      recall: 0.5,
      reciprocalRank: 1,
      fullRecall: false,
    },
  );
});

test('one source may satisfy multiple facts only when each group explicitly lists it', () => {
  const groups = decodeRequiredEvidenceGroups([
    { anyOfChunkIds: ['schema-pvc', 'docs-expansion'] },
    { anyOfChunkIds: ['schema-sc', 'docs-expansion'] },
  ]);

  assert.deepEqual(
    evaluateEvidenceRanking(groups, ['docs-expansion'], 1),
    {
      topKIds: ['docs-expansion'],
      matches: [
        { groupIndex: 0, chunkId: 'docs-expansion', rank: 1 },
        { groupIndex: 1, chunkId: 'docs-expansion', rank: 1 },
      ],
      firstRelevantRank: 1,
      recall: 1,
      reciprocalRank: 1,
      fullRecall: true,
    },
  );
});

test('reciprocal rank remains zero when the first allowed source is outside k', () => {
  const groups = decodeRequiredEvidenceGroups([
    { anyOfChunkIds: ['schema-a', 'docs-a'] },
  ]);

  assert.deepEqual(
    evaluateEvidenceRanking(groups, ['noise', 'docs-a'], 1),
    {
      topKIds: ['noise'],
      matches: [],
      firstRelevantRank: 2,
      recall: 0,
      reciprocalRank: 0,
      fullRecall: false,
    },
  );
});
