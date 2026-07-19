import { CORPUS } from '../src/knowledge/corpus';
import { chunkResources } from '../src/knowledge/chunk';
import { canonicalJson } from '../src/shared/json';
import {
  assertGenerationCasesContract,
  preflightFixCases,
} from '../src/eval/assertions';
import { FIX_CASES } from '../src/eval/cases/fix-cases';
import { GENERATION_CASES } from '../src/eval/cases/generation-cases';
import type { EvalCaseGovernance } from '../src/eval/cases/governance';
import { formatGovernanceCoverage } from '../src/eval/governance-report';
import {
  GROUNDED_ANSWER_CASES,
  decodeGroundedAnswerCases,
  resolveGroundedAnswerCase,
  type ResolvedGroundedAnswerCase,
} from '../src/eval/cases/grounded-answer-cases';
import {
  RETRIEVAL_CASES,
  decodeSemanticRetrievalCases,
} from '../src/eval/cases/retrieval-cases';

const chunkIds = new Set(CORPUS.map((chunk) => chunk.id));
const corpusKinds = new Set(CORPUS.flatMap((chunk) => chunkResources(chunk)));
const problems: string[] = [];

function sameGovernance(
  left: EvalCaseGovernance,
  right: EvalCaseGovernance,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

let semanticCases = RETRIEVAL_CASES;
try {
  semanticCases = decodeSemanticRetrievalCases(RETRIEVAL_CASES, {
    knownChunkIds: chunkIds,
  });
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
}

let groundedCases = GROUNDED_ANSWER_CASES;
let resolvedGroundedCases: ResolvedGroundedAnswerCase[] = [];
try {
  groundedCases = decodeGroundedAnswerCases(
    GROUNDED_ANSWER_CASES,
    semanticCases,
  );
  resolvedGroundedCases = groundedCases.map((evalCase) =>
    resolveGroundedAnswerCase(evalCase, semanticCases),
  );
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
}

try {
  assertGenerationCasesContract(GENERATION_CASES);
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
}

try {
  preflightFixCases(FIX_CASES);
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
}

const semanticById = new Map(
  semanticCases.map((evalCase) => [evalCase.id, evalCase] as const),
);
for (const resolved of resolvedGroundedCases) {
  if (resolved.input.kind !== 'retrieval_case') continue;
  const semantic = semanticById.get(resolved.input.retrievalCaseId);
  if (semantic && !sameGovernance(resolved.governance, semantic.governance)) {
    problems.push(
      `[${resolved.id}] grounded governance 与 retrieval case 不一致`,
    );
  }
}

for (const evalCase of groundedCases) {
  if (evalCase.input.kind !== 'validation_error') continue;
  for (const chunkId of evalCase.input.expectedChunkIds) {
    if (!chunkIds.has(chunkId)) {
      problems.push(`[${evalCase.id}] unknown expected chunk id: ${chunkId}`);
    }
  }
}

for (const evalCase of semanticCases) {
  if (!corpusKinds.has(evalCase.target.kind)) {
    problems.push(
      `[${evalCase.id}] target kind "${evalCase.target.kind}" 不在语料`,
    );
  }
}

const referenced = groundedCases.filter(
  (evalCase) => evalCase.input.kind === 'retrieval_case',
);
const validationErrors = groundedCases.filter(
  (evalCase) => evalCase.input.kind === 'validation_error',
);
const standalone = groundedCases.filter(
  (evalCase) => evalCase.input.kind === 'standalone_question',
);
const covered = new Set(semanticCases.map((evalCase) => evalCase.target.kind));
const uncovered = [...corpusKinds].filter((kind) => !covered.has(kind)).sort();

console.log('=== eval case contracts 校验 ===');
console.log(`semantic retrieval : ${semanticCases.length}`);
console.log(
  `grounded answer    : ${groundedCases.length}(检索引用 ${referenced.length} / 错误解释 ${validationErrors.length} / 独立拒答 ${standalone.length})`,
);
console.log(`generation         : ${GENERATION_CASES.length}`);
console.log(`fix                : ${FIX_CASES.length}`);
console.log(formatGovernanceCoverage('retrieval governance', semanticCases));
console.log(
  formatGovernanceCoverage('grounded governance', resolvedGroundedCases),
);
console.log(
  formatGovernanceCoverage('generation governance', GENERATION_CASES),
);
console.log(formatGovernanceCoverage('fix governance', FIX_CASES));
console.log(
  `覆盖资源 (${covered.size}/${corpusKinds.size}) : ${[...covered].sort().join(', ')}`,
);
if (uncovered.length > 0) {
  console.log(`未覆盖资源        : ${uncovered.join(', ')}`);
}

if (problems.length > 0) {
  console.log(`\n✗ 发现 ${problems.length} 处问题:`);
  for (const problem of problems) console.log(`  ${problem}`);
  process.exit(1);
}

console.log(
  `\n✓ semantic/validation expected IDs 均命中 CORPUS;grounded references 与 governance 均对齐。`,
);
