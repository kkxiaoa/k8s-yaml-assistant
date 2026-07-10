# Faithfulness Bad-case Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 faithfulness eval 产生的 `hallucination`、`dual_cause`、`refused_wrong`、`judge_failed` 等生成层失败，确定性回灌到 `data/eval/bad-cases.jsonl`，形成可去重、可关联、可复测的问题台账。

**Architecture:** 本轮不改 Ask、retrieval、generation、judge 行为。新增 faith bad-case converter，从指定 `data/eval/faith/<runId>.jsonl` 和 `data/eval/runs/<runId>.json` 读取诊断结果，默认 preview，显式 `--write` 才合并写入。Bad case identity 从旧的 question/source-id 维度升级为 `evalCaseId + failure.layer + failure.type`，允许同一 eval case 同时拥有 retrieval issue 和 generation issue。

**Tech Stack:** TypeScript strict、Node.js ESM、`node:assert/strict`、tsx、JSONL、现有 `EVAL_SET` / `run-store` / `faith-store` / `bad-cases`。

---

## 执行约束

- 严格按 Task 顺序执行。
- 每个 Task 完成验证后停止，汇报结果并等待人工 review。
- 未经用户明确指示，不执行 `git commit`。
- 不调用模型、embedding、rerank 或网络；本轮测试全部是本地 IO / 纯函数。
- 不从 faith top-k 反推 coarse retrieval 或 rerank 责任。
- 不自动推断 `knowledge_missing`。
- 不自动关闭、重开或修改人工 triage 状态。
- 不新增重复 eval case。

## Hash 口径

当前 `faithfulness-eval.ts` 的历史 run 行为是：

- full run：`evalSetHash = computeEvalSetHash(EVAL_SET)`。
- `--policy` / smoke run：`evalSetHash = computeEvalSetHash(selectedCases)`。

因此本轮采用两个 hash 语义：

- `evalSetHash`：本次实际评估的 selection hash，用于校验 run 元数据和 trace 文件一致。
- `evalSetVersionHash`：新增字段，全量 `EVAL_SET` hash，用于新 run 的 eval-set 版本闸。

历史 run 没有 `evalSetVersionHash` 时，只要 trace 每条 case 能与当前 `EVAL_SET` 的同 ID case 按 `id + question + expectedChunkIds` 对齐，就允许 preview/write，并输出 legacy warning。

---

## File Structure

### Create

- `src/eval/bad-cases.test.ts`：canonical ID、旧 retrieval-eval 记录迁移、repository merge、`retrievalMiss()` 行为测试。
- `src/eval/faith-bad-cases.ts`：faith trace 到 bad-case candidate 的纯转换逻辑。
- `src/eval/faith-bad-cases.test.ts`：outcome 映射、关联、幂等、历史 policy run fixture 测试。
- `scripts/faith-bad-cases.ts`：`npm run badcases:faith -- <runId> [--write]` CLI。

### Modify

- `src/eval/bad-cases.ts`：扩展 BadCase schema、canonical ID、迁移与合并函数。
- `src/eval/run-store.ts`：增加 `evalSetVersionHash`、`judgeModel`、`faithSelection` 类型字段。
- `src/eval/faithfulness-eval.ts`：新 run 写入 `evalSetVersionHash`、`judgeModel`、`faithSelection`。
- `src/eval/retrieve-eval.ts`：调用 `retrievalMiss()` 时传入 `evalCaseId`。
- `package.json`：新增 `badcases:faith` 脚本，并把新增测试加入 `npm test`。
- `data/eval/bad-cases.jsonl`：在 Task 4 `--write` 后迁移旧 retrieval-eval issue，并新增历史 policy run 暴露的 generation issue。

---

## Task 1: BadCase Canonical Schema 与 Retrieval 迁移

**Files:**
- Create: `src/eval/bad-cases.test.ts`
- Modify: `src/eval/bad-cases.ts`
- Modify: `src/eval/retrieve-eval.ts`
- Modify: `package.json`

- [x] **Step 1: 写 failing tests 锁定 canonical identity**

测试目标：

- `canonicalBadCaseId(evalCaseId, layer, type)` 对 question 和 expected source ID 变化稳定。
- 同一 `evalCaseId` 的 `retrieval/retrieval_miss` 与 `generation/hallucination` 生成不同 ID。
- `retrievalMiss()` 必须接收 `evalCaseId`，并使用 canonical ID。
- `retrievalMiss()` 不允许缺少 `evalCaseId` 时退回旧 question-based ID。

- [x] **Step 2: 写旧 bad-case 迁移测试**

用当前 `data/eval/bad-cases.jsonl` 的旧 retrieval-eval issue 作为真实 fixture，断言：

- 每条旧记录能唯一映射到 `EVAL_SET`。
- 迁移后写入 `origin.evalCaseId`、`origin.source='retrieval_eval'`。
- 迁移后 `convertedEvalId=origin.evalCaseId`。
- 迁移后 ID 唯一。
- 保留 `createdAt`、`input`、`expected`、`actual`、`failure.note`、`severity`、`status`。
- 匹配失败时返回具体旧 ID、question、expected source IDs、匹配数量，而不是只抛泛化错误。

- [x] **Step 3: 运行测试确认失败**

Run:

```bash
npx tsx src/eval/bad-cases.test.ts
```

Expected: FAIL，因为 canonical schema 和迁移函数尚未实现。

- [x] **Step 4: 扩展 BadCase schema**

在 `src/eval/bad-cases.ts` 中新增：

```ts
export interface BadCaseOrigin {
  evalCaseId: string;
  source: 'retrieval_eval' | 'faith_eval';
  firstSeenAt: string;
  lastSeenAt: string;
  firstSeenRunId?: string;
  lastSeenRunId?: string;
  observedRunIds: string[];
  occurrenceCount: number;
  scope?: 'full' | 'policy' | 'smoke';
  models?: {
    embedding?: string;
    rerank?: string;
    answer?: string;
    judge?: string;
  };
}
```

扩展 `BadCase`：

```ts
origin?: BadCaseOrigin;
relatedBadCaseIds?: string[];
```

`origin` 在类型上可先允许 optional，以便读旧文件；写入和迁移后的 canonical issue 必须有 `origin`。

- [x] **Step 5: 实现 canonical ID 与迁移函数**

新增：

```ts
export function canonicalBadCaseId(params: {
  evalCaseId: string;
  layer: BadCase['failure']['layer'];
  type: BadCase['failure']['type'];
}): string;

export function migrateBadCasesToCanonical(params: {
  cases: BadCase[];
  evalSet: Array<{ id: string; question: string; expectedChunkIds: string[] }>;
  manualMap?: Record<string, string>;
  now?: string;
}): { cases: BadCase[]; warnings: string[] };
```

迁移规则：

- 已有 `origin.evalCaseId` 的记录视为已迁移，不重复改写。
- 旧 retrieval 记录先按 `manualMap[oldId]` 找 eval case；没有映射时按 question 精确匹配。
- 0 个或多个匹配时整批失败，并带具体失败记录。
- canonical ID 冲突必须失败，不能静默覆盖。

- [x] **Step 6: 修改 `retrievalMiss()` 和调用点**

`retrievalMiss()` 参数新增 `evalCaseId`，并用完整 ranked IDs 做逐 expected
chunk 归因：

```ts
evalCaseId: string;
rankedIds: string[];
```

归因规则：

- 任一 expected chunk 不在 `rankedIds` 中：`layer='retrieval'`、
  `type='retrieval_miss'`。
- 所有 expected chunk 都在 `rankedIds` 中、但未全进 top-k：
  `layer='rerank'`、`type='rerank_miss'`。
- note 必须写清 `top-k 命中 x/y`、未进候选项和 top-k 外项。

`src/eval/retrieve-eval.ts` 调用处传 `ec.id` 和完整 ranked IDs。

- [x] **Step 7: 更新测试脚本并验证**

Run:

```bash
npx tsx src/eval/bad-cases.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
```

Stop and report:

- canonical ID 是否稳定。
- 当前旧 retrieval-eval issue 是否全部可迁移。
- `npm test` 是否通过。

---

## Task 2: Faith Candidate 纯转换器

**Files:**
- Create: `src/eval/faith-bad-cases.ts`
- Create/Modify: `src/eval/faith-bad-cases.test.ts`

- [x] **Step 1: 写 outcome 映射 failing tests**

覆盖 8 种 `FaithOutcome`：

- `faithful_hit` -> `skip`
- `faithful_miss` -> `link_only` 或 `warning`
- `hallucination` -> `create/recur generation/hallucination`
- `dual_cause` -> `create/recur generation/hallucination` + link retrieval issue
- `refused_correctly` -> `skip`
- `refused_wrong` -> `create/recur generation/refusal_error`
- `judge_failed` -> `create/recur judge/judge_error`
- `error` -> 不写 bad case，但 preview 中有 visible error row

- [x] **Step 2: 写关联与状态保护 tests**

测试目标：

- `dual_cause` 找到 existing retrieval issue 时，generation issue 的 `relatedBadCaseIds` 包含 retrieval issue ID。
- `faithful_miss` 找到 existing retrieval issue 时，只输出 `link_only`，不创建 generation issue。
- 缺少 retrieval issue 时只输出 `missing_retrieval_issue` warning，不伪造 retrieval issue。
- 已存在 issue 在新 run 再现时是 `recur`。
- 同一 run 已观察过时是 `already_imported`。
- 已人工标记 `fixed` 的 issue 再现时仍是 `recur`，但不自动改 status。

- [x] **Step 3: 运行测试确认失败**

Run:

```bash
npx tsx src/eval/faith-bad-cases.test.ts
```

Expected: FAIL，因为转换器尚未实现。

- [x] **Step 4: 实现转换器类型**

在 `src/eval/faith-bad-cases.ts` 中定义：

```ts
export type FaithBadCaseAction =
  | 'create'
  | 'recur'
  | 'already_imported'
  | 'link_only'
  | 'resolved_in_run'
  | 'skip'
  | 'warning'
  | 'error';

export interface FaithBadCaseCandidate {
  action: FaithBadCaseAction;
  evalCaseId: string;
  issueId?: string;
  issue?: BadCase;
  relatedBadCaseIds?: string[];
  message?: string;
  unsupportedClaims?: string[];
}
```

核心函数：

```ts
export function buildFaithBadCaseCandidates(params: {
  traces: FaithTrace[];
  existingBadCases: BadCase[];
  run: EvalRun;
  scope: 'full' | 'policy' | 'smoke';
  now?: string;
}): FaithBadCaseCandidate[];
```

- [x] **Step 5: 实现 outcome 映射**

生成类 issue 的关键字段：

- `taskType='ask_free'`
- `input.question=trace.question`
- `expected.sourceIds=trace.retrieval.expectedChunkIds`
- `actual.answer=trace.answer`
- `actual.sourceIds=trace.retrieval.topIds`
- `actual.evaluation.runId=run.id`
- `actual.evaluation.scope=scope`
- `actual.evaluation.outcome=trace.outcome`
- `actual.evaluation.unsupportedClaims=trace.verdict?.unsupported ?? []`
- `actual.evaluation.judgeReason=trace.verdict?.reason`
- `origin.source='faith_eval'`
- `convertedEvalId=trace.id`

severity 默认：

- `hallucination` / `dual_cause`: `high`
- `refused_wrong`: `high`
- `judge_failed`: `medium`

- [x] **Step 6: 验证**

Run:

```bash
npx tsx src/eval/faith-bad-cases.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
```

Stop and report:

- outcome matrix 是否全通过。
- retrieval link/warning 是否符合设计。
- 是否没有触碰真实 `bad-cases.jsonl`。

---

## Task 3: Run Selection 元数据与 CLI Preview

**Files:**
- Create: `scripts/faith-bad-cases.ts`
- Modify: `src/eval/run-store.ts`
- Modify: `src/eval/faithfulness-eval.ts`
- Modify: `src/eval/faith-bad-cases.ts`
- Modify: `src/eval/faith-bad-cases.test.ts`
- Modify: `package.json`

- [x] **Step 1: 扩展 EvalRun 类型**

在 `src/eval/run-store.ts` 中新增：

```ts
export interface FaithRunSelection {
  scope: 'full' | 'policy' | 'smoke';
  caseIds: string[];
}
```

扩展 `EvalRun`：

```ts
evalSetVersionHash?: string;
judgeModel?: string;
faithSelection?: FaithRunSelection;
```

- [x] **Step 2: 修改新 faith run 元数据**

`src/eval/faithfulness-eval.ts` 写 run 时：

- 保持 `evalSetHash: computeEvalSetHash(cases)`，表示 selection hash。
- 新增 `evalSetVersionHash: computeEvalSetHash(EVAL_SET)`。
- 新增 `judgeModel: JUDGE_MODEL`。
- 新增 `faithSelection: { scope, caseIds }`。

`selectCases()` 返回值补明确 `scope`。

- [x] **Step 3: 写输入校验 tests**

覆盖：

- run 文件缺失失败。
- trace 文件缺失失败。
- run ID 不匹配失败。
- `runKind(run) !== 'faith'` 失败。
- trace ID 重复失败。
- trace case ID 不存在于当前 `EVAL_SET` 失败。
- trace 同 ID 但 question / expectedChunkIds 漂移失败。
- `evalSetHash` 与 trace 选择集 hash 不匹配失败。
- 新 run `evalSetVersionHash` 与当前全量 `EVAL_SET` 不匹配失败。
- 历史 run 缺少 `evalSetVersionHash` 不失败，但产生 legacy warning。
- `-policy` / `-smoke` 历史 run 可从 run ID 后缀推断 scope。

- [x] **Step 4: 实现 read/validate input**

新增：

```ts
export function readFaithBadCaseInput(params: {
  runId: string;
  runsDir?: string;
  faithDir?: string;
  evalSet?: EvalCase[];
}): {
  run: EvalRun;
  traces: FaithTrace[];
  scope: 'full' | 'policy' | 'smoke';
  warnings: string[];
};
```

校验顺序：

1. 读取 run 和 trace。
2. 校验 run id/kind。
3. trace 去重。
4. trace 每条对齐当前 `EVAL_SET`。
5. 用已对齐 case 重算 selection hash，对比 `run.evalSetHash`。
6. 如果有 `evalSetVersionHash`，对比当前全量 hash；没有则 warning。

- [x] **Step 5: 实现 preview CLI**

新增脚本：

```bash
npm run badcases:faith -- <runId>
```

默认只 preview，不写入。输出至少包含：

```text
run: <runId>  scope: policy  cases: 9

action             eval case                    issue
create             policy-conflict-latest       generation/hallucination
link_only          policy-conflict-privileged   retrieval/retrieval_miss
skip               policy-deploy-limits         faithful_hit

warnings:
- legacy run missing evalSetVersionHash

summary:
create=1 recur=0 already_imported=0 link_only=1 skip=7 warning=1 error=0
```

- [x] **Step 6: 验证历史 policy run preview**

Run:

```bash
npm run badcases:faith -- 2026-07-09T07-09-12-222Z-policy
git diff -- data/eval/bad-cases.jsonl
```

Expected:

- `policy-conflict-latest`: `create generation/hallucination`
- `policy-conflict-privileged`: `link_only retrieval/retrieval_miss`
- 其余 7 条: `skip`
- 显示 legacy warning。
- `data/eval/bad-cases.jsonl` 无 diff。

Stop and report preview 输出，不进入 `--write`。

---

## Task 4: `--write` 幂等合并与真实回灌

**Files:**
- Modify: `src/eval/bad-cases.ts`
- Modify: `src/eval/faith-bad-cases.ts`
- Modify: `scripts/faith-bad-cases.ts`
- Modify: `data/eval/bad-cases.jsonl`

- [x] **Step 1: 写 merge tests**

覆盖：

- `--write` 只处理 `create` 和 `recur`。
- `link_only`、`skip`、`warning`、`error` 不写入新 bad case。
- 新 issue 写入时 status 默认 `new`。
- 已存在 issue 新 run 再现时追加 `observedRunIds`、增加 `occurrenceCount`、更新 `lastSeenAt/lastSeenRunId/actual`。
- 同一 run 重复导入不增加 occurrence count。
- 不覆盖 `failure.note`、`severity`、`status`、`convertedEvalId`。
- 写入前先在内存完成迁移和合并；任何校验失败不产生部分写入。

- [x] **Step 2: 实现 merge/write**

新增：

```ts
export function mergeBadCaseIssues(params: {
  existing: BadCase[];
  candidates: FaithBadCaseCandidate[];
  evalSet: EvalCase[];
  now?: string;
}): { cases: BadCase[]; summary: Record<string, number>; warnings: string[] };
```

`scripts/faith-bad-cases.ts` 支持：

```bash
npm run badcases:faith -- <runId> --write
```

写入路径固定为 `BAD_CASES_PATH`。

- [x] **Step 3: 执行真实历史 run 写入**

Run:

```bash
npm run badcases:faith -- 2026-07-09T07-09-12-222Z-policy --write
```

Expected:

- 旧 retrieval-eval issue 迁移到 canonical schema。
- 新增 1 条 generation issue：`policy-conflict-latest / generation/hallucination`。
- `policy-conflict-privileged` 不新增 generation issue，仅 `link_only`。

- [x] **Step 4: 验证幂等**

Run:

```bash
npm run badcases:faith -- 2026-07-09T07-09-12-222Z-policy --write
```

Expected:

- 第二次输出 `already_imported` 或等价幂等结果。
- `data/eval/bad-cases.jsonl` 记录数不增加。
- `occurrenceCount` 不增加。

- [x] **Step 5: 输出 diff 供 review**

Run:

```bash
git diff -- data/eval/bad-cases.jsonl
```

Stop and report:

- 迁移了多少条旧 retrieval issue。
- 新增了多少条 generation issue。
- 是否出现 warning。
- 幂等验证是否通过。

---

## Task 5: 回归、文档对齐与最终验收

**Files:**
- Modify: `package.json`
- Optional Modify: `docs/AI应用开发能力训练实现方案.md`

- [x] **Step 1: 将新增测试加入 `npm test`**

`package.json` 的 `test` 脚本追加：

```bash
tsx src/eval/bad-cases.test.ts
tsx src/eval/faith-bad-cases.test.ts
```

- [x] **Step 2: 全量本地验证**

Run:

```bash
npx tsx src/eval/bad-cases.test.ts
npx tsx src/eval/faith-bad-cases.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
npm run build
git diff --check
```

- [x] **Step 3: 文档对齐**

如果实现后接口、命令或 hash 口径与设计有出入，更新：

- `docs/superpowers/specs/2026-07-09-faithfulness-bad-case-feedback-design.md`
- `docs/AI应用开发能力训练实现方案.md`

只记录最终工程状态，不写对话过程。

- [x] **Step 4: 最终汇报**

Stop and report:

- 新命令用法。
- `bad-cases.jsonl` 变化摘要。
- 历史 policy run 的 preview/write 结果。
- 测试与 build 结果。
- 剩余风险：历史 run 缺少 `evalSetVersionHash`，只能依赖逐 case 对齐。

未经用户 review，不提交 commit。
