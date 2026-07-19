# Eval Artifact Protocol 实施计划

> 状态：已实施并完成逐 Task（任务）审核。
> 对应设计：`docs/superpowers/specs/2026-07-12-eval-artifact-protocol-design.md`。
> 顺序：纠偏计划 1/4；四份纠偏计划均已完成。

## Goal

把 retrieval、faith、judge、generation、fix 收敛到同一套可移植、可校验、可追踪的证据协议：一次 run 有明确生命周期，每个 case 有真实 TraceEnvelope，baseline 是独立 snapshot，bad case 只能引用真实证据。

本计划只定义 metric observation 的序列化形态，不实现指标方向、完整 compare 语义和最终 promote 门禁。后者属于第四份 Metric Semantics plan。

## Execution Rules

- 严格按 Task 顺序执行，每个 Task 完成后停止并汇报，等待 review。
- 未经用户明确要求不 commit，不 promote baseline。
- 所有单元测试不调用模型、embedding、rerank 或网络。
- 模型类 runner 只做类型和本地 fixture 验证，真实 run 留到四份纠偏计划完成后。
- 不新增 legacy reader。ignored artifacts 清理重跑；提交数据只做一次性诚实迁移。
- 注释只说明不显然约束，不记录本轮历史过程。

## Architecture

```text
EvalDatasetIdentity + kind config
          |
          v
startRun() -> running EvalRun
          |
          +-> append TraceEnvelope per case
          |
          +-> completeRun(metrics) -> completed
          |
          `-> failRun(stage, error) -> failed

completed run --promote gates--> portable EvalBaseline snapshot
                         (no ignored artifact path)
```

协议分层：

- `protocol.ts`：纯类型、Zod schema、runtime decoder，不做文件 IO。
- `artifacts.ts`：相对路径解析、JSON/JSONL、原子写，不知道 evaluator 业务。
- `run-store.ts`：run/baseline repository，不执行模型。
- `run-session.ts`：生命周期和 trace/run 关联。
- evaluator runner：只组装 kind-specific config、payload 和 metrics。

## Target Contracts

核心结构：

```ts
type EvalKind = 'retrieval' | 'faith' | 'judge' | 'generation' | 'fix';
type EvalRunStatus = 'running' | 'completed' | 'failed';

interface MetricObservation {
  value: number | null;
  numerator?: number;
  denominator?: number;
}

interface EvalDatasetIdentity {
  id: string;
  hash: string;
  caseIds: string[];
  caseCount: number;
}

interface TraceEnvelope<TPayload> {
  schemaVersion: number;
  traceId: string;
  runId: string;
  evalCaseId: string;
  kind: EvalKind;
  createdAt: string;
  outcome: 'success' | 'failed' | 'error' | 'skipped';
  payload: TPayload;
  error?: { stage: string; message: string };
}
```

`EvalRun` 使用 `kind` 判别联合。所有 kind 共用 dataset、scope、status、artifact path、metric definition version 和 metrics；模型、corpus、index、query expansion、vote count、validation identity、prompt/tool schema identity 等进入 kind-specific config。

`EvalBaseline` 由 completed run 派生，保留比较所需 identity/config/metrics 和 `sourceRunId/promotedAt`，不保留 trace path。

## File Structure

### Create

- `src/eval/protocol.ts`
- `src/eval/protocol.test.ts`
- `src/eval/run-session.ts`
- `src/eval/run-session.test.ts`

### Modify

- `package.json`
- package lockfile
- `.gitignore`
- `src/eval/artifacts.ts`
- `src/eval/artifacts.test.ts`
- `src/eval/run-store.ts`
- `src/eval/run-store.test.ts`
- `src/eval/retrieval-eval.ts`
- `src/eval/faithfulness-eval.ts`
- `src/eval/faith-store.ts`
- `src/eval/judge-eval.ts`
- `src/eval/generation-eval.ts`
- `src/eval/fix-eval.ts`
- `src/eval/bad-cases.ts`
- `src/eval/bad-cases.test.ts`
- `src/eval/faith-bad-cases.ts`
- `src/eval/faith-bad-cases.test.ts`
- `scripts/build-calibration.ts`
- `scripts/eval-compare.ts`
- `scripts/eval-promote.ts`
- `data/eval/bad-cases.jsonl`
- `README.md`（更新评估 artifact 路径说明）

### Remove / Invalidate

- `data/eval/baseline.json`：旧文件缺少新 dataset/metric identity，不能伪造迁移；第四份 plan 后用 full run 重建。
- ignored `data/eval/runs/*`、`data/eval/traces/*`、`data/eval/faith/*`：执行清理前先汇报并获得确认。

## Task 1: Runtime Protocol 与判别联合

**Files:**

- Create: `src/eval/protocol.ts`
- Create: `src/eval/protocol.test.ts`
- Modify: `package.json`
- Modify: package lockfile

- [ ] **Step 1: 引入 runtime schema 依赖**

使用 Zod 定义持久化边界。依赖通过 package manager 正常写入 semver 和 lockfile，不手写 lockfile，不使用 `latest` 作为新依赖版本声明。

- [ ] **Step 2: 先写失败测试**

至少覆盖：

- run 缺 `schemaVersion/kind/status/scope/dataset/artifactPaths/metricDefinitionVersion` 时拒绝。
- dataset caseIds 必须唯一，caseCount 必须与长度一致；hash 由对应 canonical case snapshot 计算，不能只 hash IDs。
- retrieval run 缺 corpus/index/embedding/rerank/k 配置时拒绝。
- faith run 缺 answer/judge model 时拒绝。
- judge run 缺 calibration dataset/vote config 时拒绝。
- generation/fix run 缺 answer model 或 validation identity 时拒绝。
- `MetricObservation.value` 只允许 finite number 或 null。
- numerator/denominator 只用于比例类 observation，必须同时出现且为非负 finite number；denominator 为 0 时 value 必须为 null 且 numerator 为 0。
- failed run 必须有 failure；completed run 不能带 running-only 状态。
- schemaVersion 必须是当前支持版本，时间字段必须是有效 ISO-8601，status 与 completedAt/failure 状态一致。
- baseline 不能出现 artifact path。
- TraceEnvelope 的 kind/runId/evalCaseId/traceId/outcome 必填。
- error outcome 必须有 error，非 error outcome 不能夹带 error。

Run：

```bash
npx tsx src/eval/protocol.test.ts
```

Expected：FAIL，协议模块尚不存在。

- [ ] **Step 3: 实现 schema 与 decoder**

导出：

- `EVAL_SCHEMA_VERSION`。
- `EvalKind/EvalScope/EvalRun/TraceEnvelope/EvalBaseline/MetricObservation` 类型。
- `decodeEvalRun()`、`decodeTraceEnvelope()`、`decodeEvalBaseline()`。
- `metricObservation(value, numerator?, denominator?)` 仅负责结构构造；比例公式一致性由 Metric Semantics plan 校验。
- `computeDatasetHash()`：对 evaluator 的 canonical case snapshot 做稳定 JSON hash；具体 snapshot 由各 case 模块提供。

禁止：

- `kind?:`、`scope?:`、`artifactPaths?:` 一类关键可选字段。
- `runKind()` 对缺 kind 的默认回退。
- 使用 `as EvalRun` 代替 runtime decode。

- [ ] **Step 4: 验证**

```bash
npx tsx src/eval/protocol.test.ts
npx tsc --noEmit -p tsconfig.json
```

Stop and report：协议字段、Zod 依赖影响、仍需由后续 plan 定义的 metric semantics。

## Task 2: 可移植 Artifact Store

**Files:**

- Modify: `src/eval/artifacts.ts`
- Modify: `src/eval/artifacts.test.ts`

- [ ] **Step 1: 写路径和原子性反例测试**

覆盖：

- run 中只接受 POSIX 相对路径 `traces/<runId>.<kind>.jsonl`。
- 拒绝绝对路径、`..`、反斜杠越界和 eval root 外路径。
- 工作区 root 改变后，相对路径仍能解析。
- JSON 写入使用同目录临时文件加 atomic rename。
- JSONL 空文件、损坏行、重复 traceId 明确失败。
- baseline 路径固定为 `data/eval/baselines/<kind>.json`。

- [ ] **Step 2: 实现 artifact resolver**

目标 API：

- `evalArtifactPath(relativePath, evalRoot?)`。
- `traceRelativePath(runId, kind)`。
- `runPath(runId, evalRoot?)`。
- `baselinePath(kind, evalRoot?)`。
- `writeJsonAtomic()`、`appendTraceEnvelope()`、`readTraceEnvelopes()`。

测试必须可注入临时 eval root，不修改真实 `data/eval`。

- [ ] **Step 3: 验证**

```bash
npx tsx src/eval/artifacts.test.ts
npx tsc --noEmit -p tsconfig.json
```

本 Task 只新增无业务依赖的 artifact primitives，不切换现有 `run-store` 或 runner，确保停止 review 时仓库仍可编译。

现有 artifact exports 在本 Task 保持行为不变，仅作为尚未切换调用方的短期过渡；Task 4 原子切换全部调用方后立即删除。不得为旧 ignored artifact 增加 reader 或格式 fallback。

Stop and report：最终目录布局、路径穿越测试、原子写策略。

## Task 3: Run Session 生命周期

**Files:**

- Create: `src/eval/run-session.ts`
- Create: `src/eval/run-session.test.ts`

- [ ] **Step 1: 写生命周期测试**

覆盖：

- `startRun` 立即写 `running` run。
- 每个 evalCaseId 只能写一个最终 envelope，重复写明确失败。
- envelope 的 runId/kind 必须与 session 一致。
- `complete` 后不可 append/fail；`fail` 后不可 append/complete。
- complete 前 trace case IDs 必须与 dataset selection 对齐；允许 `skipped/error`，但不能缺行。
- case-scoped 异常先写 error envelope；run-level 异常将 run 标为 failed，并保存稳定 error stage/message，不保存 stack、secret 或伪造 case trace。
- run 更新始终原子写。

- [ ] **Step 2: 实现 session**

目标 API：

```ts
const run = startEvalRun(definition, { evalRoot? });
run.appendCase(envelope);
run.complete(metrics);
run.fail(stage, error);
```

`traceId` 使用统一 helper 生成并在同一 run 内唯一。不要让 runner 手拼 `${runId}:${evalCaseId}`。

Session 直接依赖 `protocol.ts` 和 artifact primitives，并使用临时 eval root 测试。本 Task 不替换现有 runner；协议切换集中在 Task 4 原子完成。

- [ ] **Step 3: 验证**

```bash
npx tsx src/eval/run-session.test.ts
npx tsc --noEmit -p tsconfig.json
```

Stop and report：状态机、case 完整性检查、错误脱敏策略。

## Task 4: 五类 Runner 接入统一协议

**Files:**

- Modify: `src/eval/retrieval-eval.ts`
- Modify: `src/eval/faithfulness-eval.ts`
- Modify: `src/eval/faith-store.ts`
- Modify: `src/eval/judge-eval.ts`
- Modify: `src/eval/generation-eval.ts`
- Modify: `src/eval/fix-eval.ts`
- Modify: `src/eval/run-store.ts`
- Modify: `src/eval/run-store.test.ts`
- Modify: `scripts/build-calibration.ts`
- Modify: `scripts/eval-compare.ts`
- Modify: `scripts/eval-promote.ts`
- Modify: `src/eval/faith-bad-cases.ts`
- Modify: `src/eval/faith-bad-cases.test.ts`
- Modify: runner 相关测试

- [ ] **Step 1: 为每类数据集提供 canonical snapshot/hash**

- retrieval：实际进入 Recall/MRR 的可答案例；拒答案例不属于 retrieval run selection，也不写 skipped retrieval trace。
- faith：当前实际选择的 faith cases；Evaluator Validity plan 会将其迁移为独立 GroundedAnswerCase dataset。
- judge：calibration case 的 question/context/answer/human labels。
- generation：requirement 和 expected contract。
- fix：broken YAML、defect、target 和 expected contract。

同一 dataset 的 case 顺序变化不改变 hash；语义字段变化必须改变 hash。

- [ ] **Step 2: 迁移 run definition**

每个 runner 在模型调用前：

1. 解析 scope/selection。
2. 构造 dataset identity。
3. 构造 kind-specific config。
4. 启动 running run。

暂时使用明确的 `metricDefinitionVersion='legacy-v1'`，说明这些 observation 尚未进入最终 Metric Semantics；不得 promote。

kind-specific config 至少记录实际影响结果的 identity：retrieval/faith 的 corpus/index/model/query-expansion，faith/judge 的 prompt 与 parser schema，generation/fix 的 system prompt、tool schema 和 validation schema。identity 从实际输入稳定计算，不使用手填版本占位。

prompt/tool identity 对实际发送的 system instructions、共享 source rules、tool input schema 和固定模型参数做 canonical hash；case question/requirement 属于 dataset，不重复混入 prompt hash。provider 无法导出 parser/tool schema 时使用受测试保护的显式 schema revision，不根据文件时间生成版本。

- [ ] **Step 3: 迁移 per-case trace**

- retrieval payload 保存当前 RetrievalTrace 和 expected/rank 诊断。
- faith payload 保存当前 FaithTrace；context snapshot 的补齐在 Evaluator Validity plan。
- judge payload 保存当前 calibration result/votes。
- generation/fix payload 保存当前 case result。
- case 异常写 `outcome='error'` 和 error stage，再按 runner 当前策略继续或终止。

- [ ] **Step 4: 迁移 metrics**

所有 `Record<string, number>` 改为 `Record<string, MetricObservation>`。本 plan 只保持现有值和分子/分母能确定的结构，不判断方向，不把 N/A 强行变成 0/1。

- [ ] **Step 5: 验证 runner 不执行副作用 import**

共享 dataset/hash/payload builder 必须放无 `main()` 模块。单元测试不得 import 后触发模型 run。

本 Step 同时原子切换所有 `run-store` 直接调用方：读写都经过 decoder，删除 retrieval baseline 特例、`runKind()` 默认回退和绝对路径字段。不得留下“新 store + 旧 runner/consumer”导致中间 Task 无法编译的半迁移状态。

同时删除 Task 2 保留的旧 artifact exports；此后当前代码只能通过 resolver、repository 和 session 使用新协议。

```bash
npx tsc --noEmit -p tsconfig.json
npm test
```

Stop and report：五类 run 必填配置、trace payload 列表、仍为 legacy semantics 的指标。

## Task 5: Consumers、BadCase Evidence 与提交数据迁移

**Files:**

- Modify: `src/eval/bad-cases.ts`
- Modify: `src/eval/bad-cases.test.ts`
- Modify: `src/eval/faith-bad-cases.ts`
- Modify: `src/eval/faith-bad-cases.test.ts`
- Modify: `scripts/build-calibration.ts`
- Modify: `scripts/eval-compare.ts`
- Modify: `scripts/eval-promote.ts`
- Modify: `data/eval/bad-cases.jsonl`
- Remove: `data/eval/baseline.json`

- [ ] **Step 1: BadCase 增加可验证 evidence reference**

用明确结构替换 `actual.traceId` 字符串：

```ts
latestEvidence?: {
  runId: string;
  traceId: string;
}
```

新 observation 写入前，通过 source run 的 trace artifact 验证 traceId 存在且 evalCaseId 一致。该字段表达“最近一次已核验 lineage”，不是跨 clone 永久外键；BadCase 自身的 expected/actual/failure 必须足以解释问题。历史 bad case 的伪 traceId 删除，保留 issue/tracking 事实，不伪造 evidence。

- [ ] **Step 2: BadCase runtime decoder**

读取和写入都校验 canonical ID、tracking、failure 组合和 latestEvidence 结构。普通读取只做自包含结构校验；从 run 回灌新 observation 时额外解析本地 lineage。非法记录整批失败，不部分写入。

- [ ] **Step 3: Faith converter 改读 envelope payload**

- 通过 run metadata 解析 trace 相对路径。
- 校验 run kind、dataset case IDs 和 envelope case IDs。
- 不再读取 `faithSelection` 或绝对 `tracePath`。
- create/recur 后保存写入时已核验的 latestEvidence。

- [ ] **Step 4: Calibration builder 改读 snapshot**

从 faith envelope 读取当时的 payload，不从当前 corpus 重建 context。Evaluator Validity plan 会补齐完整 context 字段；在此之前若 payload 不含 context，明确失败，不回退旧行为。

- [ ] **Step 5: 收口 compare/promote 的结构行为**

- compare 能读取 observation 并只显示 raw value/delta，不宣称改进或退化。
- promote 至少执行 completed、scope、dataset、trace 存在等结构门禁，并写独立 baseline snapshot。
- 完整方向和稳定指标门禁留给 Metric Semantics plan。

- [ ] **Step 6: 一次性数据迁移**

- 更新 `bad-cases.jsonl` 到新 decoder 可读结构。
- 删除无法诚实迁移的旧 `baseline.json`。
- 不保留 `runKind`、旧字段 fallback 或 legacy migration runtime 分支。

- [ ] **Step 7: 验证**

```bash
npx tsx src/eval/bad-cases.test.ts
npx tsx src/eval/faith-bad-cases.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
```

Stop and report：迁移记录数、无 evidence 的历史 issue 数、被失效的 baseline 及原因。

## Task 6: Artifact Cleanup 与总回归

**Files:**

- Modify: `.gitignore`
- Modify: docs 中 artifact 路径说明

- [ ] **Step 1: 清理 ignore 规则**

只保留当前路径：

- `data/eval/runs/`
- `data/eval/traces/`
- `data/observability/`

删除全局 `traces.jsonl` 和旧 `data/eval/faith/` 的历史注释/规则。

- [ ] **Step 2: 先预览 ignored artifact**

列出待清理文件、大小和用途，确认没有唯一人工数据。得到用户确认后再删除并保持空目录由运行时创建。

- [ ] **Step 3: 全回归**

```bash
npx tsc --noEmit -p tsconfig.json
npm test
npm run build
git diff --check
```

不运行 retrieval/faith/judge/generation/fix 的真实模型 eval。

- [ ] **Step 4: 最终审计**

```bash
rg "faithSelection|tracePath|runKind\(|as EvalRun|data/eval/faith|traces\.jsonl" src scripts docs package.json .gitignore
```

Expected：只允许 design/plan 历史记录命中；当前代码无旧协议 fallback。

Stop and report：协议版本、artifact 树、测试结果、下一 plan 的输入条件。

## Completion Gate

- 五类 runner 都产出 decoder 可读的 run 和 per-case envelope。
- run 只保存相对路径，移动工作区仍可解析。
- case-scoped 失败留下 error trace；run-scoped 失败留下 failed run，二者都不留下无主 artifact。
- baseline snapshot 无 trace path；旧 baseline 已诚实失效。
- 新 bad case lineage 写入时经过解析验证；提交记录脱离 ignored artifact 仍可理解，历史 issue 不伪造 evidence。
- 当前代码没有旧 run/trace/baseline 兼容分支。
- 所有本地测试、类型检查和 build 通过。
