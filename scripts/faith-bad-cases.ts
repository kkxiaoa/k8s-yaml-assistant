import {
  BAD_CASES_PATH,
  readBadCases,
  verifyBadCaseLatestEvidence,
  writeBadCases,
} from '../src/eval/bad-cases';
import {
  buildFaithBadCaseCandidates,
  mergeBadCaseIssues,
  readFaithBadCaseInput,
  type FaithBadCaseAction,
  type FaithBadCaseCandidate,
} from '../src/eval/faith-bad-cases';

const ACTIONS: FaithBadCaseAction[] = [
  'create',
  'recur',
  'already_imported',
  'link_only',
  'resolved_in_run',
  'skip',
  'warning',
  'error',
];

function usage(): never {
  throw new Error('用法: npm run badcases:faith -- <runId> [--write]');
}

function issueLabel(candidate: FaithBadCaseCandidate): string {
  if (candidate.issue) {
    return `${candidate.issue.failure.layer}/${candidate.issue.failure.type}`;
  }
  if (candidate.issueId) {
    return candidate.issueId;
  }
  return candidate.message ?? '';
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + ' '.repeat(width - value.length);
}

function printPreview(params: {
  runId: string;
  scope: string;
  caseCount: number;
  warnings: string[];
  candidates: FaithBadCaseCandidate[];
  wrote?: boolean;
}): void {
  const { runId, scope, caseCount, warnings, candidates, wrote = false } =
    params;
  console.log(`run: ${runId}  scope: ${scope}  cases: ${caseCount}\n`);
  console.log(
    `${pad('action', 18)}${pad('eval case', 34)}issue`,
  );
  for (const candidate of candidates) {
    console.log(
      `${pad(candidate.action, 18)}${pad(candidate.evalCaseId, 34)}${issueLabel(candidate)}`,
    );
  }

  const unsupported = candidates.filter(
    (candidate) => candidate.unsupportedClaims?.length,
  );
  if (unsupported.length > 0) {
    console.log('\nunsupported:');
    for (const candidate of unsupported) {
      console.log(
        `- ${candidate.evalCaseId}: ${candidate.unsupportedClaims!.join(' / ')}`,
      );
    }
  }

  const allWarnings = [
    ...warnings,
    ...candidates
      .filter((candidate) => candidate.action === 'warning')
      .map((candidate) => `${candidate.evalCaseId}: ${candidate.message ?? ''}`),
  ];
  if (allWarnings.length > 0) {
    console.log('\nwarnings:');
    for (const warning of allWarnings) {
      console.log(`- ${warning}`);
    }
  }

  const summary = Object.fromEntries(ACTIONS.map((action) => [action, 0])) as Record<
    FaithBadCaseAction,
    number
  >;
  for (const candidate of candidates) {
    summary[candidate.action]++;
  }
  summary.warning += warnings.length;
  console.log('\nsummary:');
  console.log(ACTIONS.map((action) => `${action}=${summary[action]}`).join(' '));
  if (wrote) {
    console.log(`\nwritten: ${BAD_CASES_PATH}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const runId = args.find((arg) => arg !== '--write');
  const write = args.includes('--write');
  if (!runId) usage();

  const input = readFaithBadCaseInput({ runId });
  const existing = readBadCases();
  const canonicalExisting = mergeBadCaseIssues({
    existing,
    candidates: [],
  });
  const candidates = buildFaithBadCaseCandidates({
    observations: input.observations,
    existingBadCases: canonicalExisting.cases,
    run: input.run,
    scope: input.scope,
  });
  const writeResult = write
    ? mergeBadCaseIssues({
        existing,
        candidates,
      })
    : null;

  if (writeResult) {
    for (const candidate of candidates) {
      if (
        (candidate.action === 'create' || candidate.action === 'recur') &&
        candidate.issue
      ) {
        verifyBadCaseLatestEvidence(candidate.issue);
      }
    }
    writeBadCases(writeResult.cases);
  }

  printPreview({
    runId,
    scope: input.scope,
    caseCount: input.observations.length,
    warnings: [
      ...input.warnings,
      ...(writeResult?.warnings ?? canonicalExisting.warnings),
    ],
    candidates,
    wrote: write,
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
