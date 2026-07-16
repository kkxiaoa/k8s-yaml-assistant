import { CORPUS } from '../src/knowledge/corpus';
import { chunkResources } from '../src/knowledge/chunk';
import {
  GROUNDED_ANSWER_CASES,
  decodeGroundedAnswerCases,
} from '../src/eval/cases/grounded-answer-cases';
import {
  RETRIEVAL_CASES,
  decodeSemanticRetrievalCases,
} from '../src/eval/cases/retrieval-cases';

const chunkIds = new Set(CORPUS.map((chunk) => chunk.id));
const corpusKinds = new Set(CORPUS.flatMap((chunk) => chunkResources(chunk)));
const problems: string[] = [];

let semanticCases = RETRIEVAL_CASES;
try {
  semanticCases = decodeSemanticRetrievalCases(RETRIEVAL_CASES, {
    knownChunkIds: chunkIds,
  });
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
}

let groundedCases = GROUNDED_ANSWER_CASES;
try {
  groundedCases = decodeGroundedAnswerCases(
    GROUNDED_ANSWER_CASES,
    semanticCases,
  );
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
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
const standalone = groundedCases.filter(
  (evalCase) => evalCase.input.kind === 'standalone_question',
);
const covered = new Set(semanticCases.map((evalCase) => evalCase.target.kind));
const uncovered = [...corpusKinds].filter((kind) => !covered.has(kind)).sort();

console.log('=== eval case contracts 校验 ===');
console.log(`semantic retrieval : ${semanticCases.length}`);
console.log(
  `grounded answer    : ${groundedCases.length}(检索引用 ${referenced.length} / 独立拒答 ${standalone.length})`,
);
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
  `\n✓ semantic expected IDs 均命中 CORPUS;grounded references 均对齐。`,
);
