import { z } from 'zod';

export const FaithOutcomeSchema = z.enum([
  'faithful_hit',
  'faithful_miss',
  'hallucination',
  'dual_cause',
  'refused_correctly',
  'refused_wrong',
  'judge_failed',
  'error',
]);

const VerdictSchema = z.strictObject({
  faithful: z.boolean(),
  unsupported: z.array(z.string()),
  reason: z.string(),
  policy: z
    .strictObject({
      distinguished: z.boolean(),
      conflictExplained: z.boolean(),
      misstatedAsOfficial: z.boolean(),
    })
    .optional(),
});

export const FaithTraceSchema = z.strictObject({
  id: z.string().min(1),
  question: z.string(),
  context: z.string().optional(),
  answerable: z.boolean(),
  resource: z.string().optional(),
  retrieval: z.strictObject({
    routed: z.string().optional(),
    expectedChunkIds: z.array(z.string()),
    topIds: z.array(z.string()),
    foundCount: z.int().nonnegative(),
    fullRecall: z.boolean(),
  }),
  answer: z.string(),
  verdict: VerdictSchema.nullable(),
  outcome: FaithOutcomeSchema,
});

export type FaithOutcome = z.infer<typeof FaithOutcomeSchema>;
export type FaithTrace = z.infer<typeof FaithTraceSchema>;

export function decodeFaithTrace(value: unknown): FaithTrace {
  return FaithTraceSchema.parse(value);
}
