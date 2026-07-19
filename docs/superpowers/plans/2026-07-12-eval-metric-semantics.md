# Eval Metric Semantics 实施计划

> 状态：已实施并完成逐 Task（任务）审核。
> 对应设计：`docs/superpowers/specs/2026-07-12-eval-metric-semantics-design.md`。
> 顺序：纠偏计划 4/4，已完成；正式 baseline（基线）仍待重建。

## Goal

为 retrieval、faith、judge、generation、fix 的稳定输出建立统一指标注册表，明确方向、单位、分母、N/A 和可比较条件；让 compare 正确解释 delta，让 promote 只接受完整、可验证、同口径的 run。

本计划不自动决定上线，不建立 CI 强制门禁，不把模型波动包装成确定结论。

## Execution Rules

- 严格按 Task 顺序执行，每个 Task 后停止汇报并等待 review。
- 指标定义以 Evaluator Validity plan 的最终输出为输入，不为了兼容旧 key 保留重复指标。
- `null` 表示 N/A，不用 0 或 1 填空。
- compare 不可比较时必须明确失败原因，不输出“无退化”。
- promote 是显式人工动作，默认不允许 error override。
- 真实模型 eval 和 baseline promote 分开 review；未经用户要求不 commit。

## Architecture

```text
MetricDefinition registry
  key / kind / direction / unit / denominator / stability
                 |
Evaluator raw counts -> MetricObservation(value, numerator, denominator)
                 |
EvalRun(metricDefinitionVersion)
                 |
compare compatibility -> per metric interpretation
                 |
promote gates -> portable EvalBaseline snapshot
```

## Target Types

```ts
interface MetricDefinition {
  key: string;
  evalKind: EvalKind;
  revision: number;
  direction: 'higher_is_better' | 'lower_is_better' | 'neutral';
  unit: 'ratio' | 'count' | 'milliseconds' | 'tokens' | 'usd' | 'number';
  denominator?: string;
  stability: 'required' | 'diagnostic';
}

interface MetricComparison {
  key: string;
  current: MetricObservation;
  baseline: MetricObservation;
  delta: number | null;
  verdict: 'improved' | 'regressed' | 'unchanged' | 'neutral' | 'not_comparable';
  reason?: string;
}
```

`metricDefinitionVersion` 固定为排序后 canonical registry 的 SHA-256。`revision` 表达公式/判定语义版本；公式、applicable case 或 pass 判定改变时必须递增。定义变化必须改变版本，registry 声明顺序变化不得改变版本。

## File Structure

### Create

- `src/eval/metrics/definitions.ts`
- `src/eval/metrics/definitions.test.ts`
- `src/eval/metrics/compare.ts`
- `src/eval/metrics/compare.test.ts`
- `src/eval/metrics/promotion.ts`
- `src/eval/metrics/promotion.test.ts`

### Modify

- `src/eval/protocol.ts`
- `src/eval/run-session.ts`
- `src/eval/retrieval-eval.ts`
- `src/eval/faithfulness-eval.ts`
- `src/eval/judge-eval.ts`
- `src/eval/generation-eval.ts`
- `src/eval/fix-eval.ts`
- `src/eval/metrics/judge-metrics.ts`
- `src/eval/metrics/generation-metrics.ts`
- `src/eval/metrics/generation-metrics.test.ts`
- `src/eval/metric-format.ts`
- `src/eval/metric-format.test.ts`
- `src/eval/run-store.ts`
- `scripts/eval-compare.ts`
- `scripts/eval-promote.ts`
- `package.json`
- `README.md`

### Create on Explicit Promotion Only

- `data/eval/baselines/retrieval.json`
- `data/eval/baselines/faith.json`
- `data/eval/baselines/judge.json`
- `data/eval/baselines/generation.json`
- `data/eval/baselines/fix.json`

## Task 1: Metric Registry 与 Version

**Files:**

- Create: `src/eval/metrics/definitions.ts`
- Create: `src/eval/metrics/definitions.test.ts`
- Modify: `src/eval/protocol.ts`
- Modify: `src/eval/run-session.ts`
- Modify: retrieval/faith/judge/generation/fix runners

- [ ] **Step 1: 写 registry 约束测试**

覆盖：

- metric key 全局唯一。
- key 前缀与 evalKind 一致。
- revision 必须是正整数；revision 改变必须改变 definition version。
- ratio 必须声明 denominator；count/latency/token/usd 不伪装 ratio。
- required/diagnostic 明确。
- registry 顺序不影响 definition version。
- direction/unit/denominator/stability 任一变化都会改变 version。
- numerator/denominator 或 pass 语义变化即使其他字段不变，也必须通过 revision 变化反映。
- run 中出现未注册 metric key 明确失败。

- [ ] **Step 2: 定义稳定指标集合**

至少覆盖：

Retrieval：

- semantic `retrieval.semantic.recall`、`retrieval.semantic.mrr`：higher；k 由 retrieval run config 提供。
- answerable case count：neutral。
- retrieval/rerank miss count：lower、diagnostic；它们用于归因，不重复充当主质量门禁。
- harness error count：lower、required，baseline 晋升要求为 0。
- none/oracle/auto diagnostics：higher、diagnostic，不作为 required baseline gate。

Faith：

- faithful rate、refusal correct rate：higher。
- hallucination、dual cause、judge invalid/indeterminate、harness error：lower。
- judged/refusal/case counts：neutral。

Judge：

- agreement rate 和各 policy 维度 agreement：higher。
- invalid/error/indeterminate/unstable：lower；harness error count 为 required 且晋升时必须为 0。
- planned/valid/judged counts：neutral。

Generation：

- valid YAML、resource assertion pass、relation pass、content pass：higher。
- max-round failure、harness error：lower。
- repair attempted、case count、average rounds/submits：neutral，除非后续证据证明可作为质量方向。

Fix：

- valid YAML、expected correction pass、preserve pass、side-effect-free pass：higher。
- max-round failure、harness error：lower。
- repair attempted、average rounds/submits：neutral。

Latency/usage：

- milliseconds、tokens、USD：lower，但只有 provider 返回真实 usage 或有版本化价格计算时才产出。

- [ ] **Step 3: 替换 `legacy-v1`**

所有 runner 从 registry 获取 metric definition version。协议 decoder 只验证 observation 结构；`completeRun`、compare 和 promote 通过 registry 校验 metric key、kind、完整性与当前 definition version，避免 `protocol.ts <-> definitions.ts` 循环依赖。

- [ ] **Step 4: 验证**

```bash
npx tsx src/eval/metrics/definitions.test.ts
npx tsc --noEmit -p tsconfig.json
```

Stop and report：required/diagnostic 指标表、definition version、暂不定方向的指标。

## Task 2: Observation 分母与 N/A

**Files:**

- Modify: all evaluator metric builders/runners
- Modify: metric tests

- [ ] **Step 1: 写空样本反例**

覆盖：

- 没有首轮失败时 repair-success-after-fail = null，不是 1。
- 没有 refusal case 时 refusal correct rate = null。
- judge 无 quorum 时 agreement = null，invalid 单独计数。
- 没有 relation case 时 relation pass = null。
- 所有 case error 时质量 ratio = null，harness error count 正确。
- ratio 保存 numerator/denominator，并满足 value = numerator/denominator。

- [ ] **Step 2: 从 raw counts 构造 observation**

每个 evaluator 先计算 raw accumulators，再由共享 helper 构造 ratio。普通通过率使用整数计数；MRR 等指标允许分子为明确的浮点累加值。禁止先用 `results.length || 1` 修改真实分母。

- [ ] **Step 3: 统一质量与 error 分母**

- quality ratio 分母只包含成功完成该测量阶段的 applicable cases。
- harness error 不进入质量分母，但每个 kind 必须产出 required error count；是否增加 rate 只能通过 registry 明确定义，不能临时重复计算。
- skipped 与 not-applicable 分开，不把 skipped 当成功。
- console 显示和 persisted observation 使用同一值，不出现 console=N/A、JSON=100% 的分裂。

- [ ] **Step 4: 验证**

```bash
npx tsx src/eval/metrics/generation-metrics.test.ts
npx tsx src/eval/judge-eval.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
```

Stop and report：每个 ratio 的分子/分母、所有 N/A 场景。

## Task 3: Compare Compatibility 与方向解释

**Files:**

- Create: `src/eval/metrics/compare.ts`
- Create: `src/eval/metrics/compare.test.ts`
- Modify: `scripts/eval-compare.ts`
- Modify: `src/eval/metric-format.ts`
- Modify: `src/eval/metric-format.test.ts`

- [ ] **Step 1: 写 compare 反例**

覆盖：

- hallucination 2 -> 1 显示 improved。
- max-round failure 20% -> 10% 显示 improved。
- Recall 90% -> 89% 显示 regressed。
- neutral 平均轮次只显示 delta，不判好坏。
- null 任一侧 -> not comparable。
- kind、dataset hash、metric definition version 不同 -> 整体 incompatible。
- retrieval k 不同 -> 整体 incompatible，不能比较 Recall@3 与 Recall@5。
- baseline required metric 当前缺失 -> harness gap，不是“无退化”。
- diagnostic metric 缺失只报告，不阻断 required completeness。
- ratio 同时输出 value 和 `numerator/denominator`。

- [ ] **Step 2: 定义 comparison identity**

必须相同：

- kind。
- dataset id/hash/caseCount。
- metric definition version。
- measurement 参数必须相同；当前 retrieval 的 k 是必检项，Recall@3 不能与 Recall@5 比。持久化 metric key 保持稳定，不把参数拼进 registry key。

允许变化但必须列出：

- model、prompt、corpus/index、query expansion、context selection 等被测系统配置。

这些变化是实验变量，不自动导致不可比较；报告必须明确 delta 跨越了哪些变量，避免错误归因。

- [ ] **Step 3: 实现 direction-aware compare**

compare 只从 registry 获取方向和 unit，不用 key suffix 猜百分比。删除 `isPercentMetric()` 这类命名启发式。

- [ ] **Step 4: CLI 输出与退出语义**

- incompatible/harness gap 明确打印并使用非零退出码。
- 指标 regression 只报告，不在本计划建立 CI fail gate。
- 没 baseline 时显示当前 observation，并说明需要 full run + promote。
- 不再输出笼统“无退化”，改为 required metrics 的完整 summary。

- [ ] **Step 5: 验证**

```bash
npx tsx src/eval/metrics/compare.test.ts
npx tsx src/eval/metric-format.test.ts
npx tsc --noEmit -p tsconfig.json
```

Stop and report：兼容条件、实验变量列表、CLI 示例。

## Task 4: Promote Gates 与 Portable Baseline

**Files:**

- Create: `src/eval/metrics/promotion.ts`
- Create: `src/eval/metrics/promotion.test.ts`
- Modify: `src/eval/run-store.ts`
- Modify: `scripts/eval-promote.ts`

- [ ] **Step 1: 写晋升反例**

拒绝：

- running/failed run。
- retrieval/faith/generation/fix 的 smoke/policy/targeted run。
- judge 非完整 calibration run。
- dataset identity 或 case count 缺失。
- metric definition version 不匹配当前 registry。
- required metric 缺失或 null。
- trace 文件缺失、trace 数与 dataset selection 不一致、case error 未说明。
- baseline snapshot 包含 artifact path。

- [ ] **Step 2: 明确禁止 error override**

第一版只要存在 harness error 就拒绝晋升，不提供 `--allow-errors`。若未来真实运行证明必须保留部分失败 run，需另写设计并定义可接受错误类型，不能在 CLI 中预留静默逃生口。

- [ ] **Step 3: 写 baseline snapshot**

保留：

- schemaVersion、kind、scope。
- dataset identity。
- metric definition version 和 metrics。
- 参与比较的模型/corpus/index/prompt/config identity。
- sourceRunId、promotedAt。

不保留 trace path、绝对路径或本地工作区信息。

- [ ] **Step 4: 原子晋升**

promotion 先完整验证 run/trace/metrics，再原子写 `data/eval/baselines/<kind>.json`。失败时不得覆盖旧 baseline。

- [ ] **Step 5: 验证**

```bash
npx tsx src/eval/metrics/promotion.test.ts
npx tsc --noEmit -p tsconfig.json
```

Stop and report：门禁列表、baseline schema、是否支持 error override。

## Task 5: 全 Harness 集成与文档

**Files:**

- Modify: `scripts/eval-compare.ts`
- Modify: `scripts/eval-promote.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/AI应用开发能力训练实现方案.md`

- [ ] **Step 1: 所有 runner 验证 metric completeness**

completeRun 前校验：

- 所有产出 key 已注册。
- required metric 均出现。
- observation 合法。
- metric definition version 与 registry 一致。

- [ ] **Step 2: 文档命令和成本标识**

说明：

- 哪些 eval 调模型/embedding/rerank。
- 输出 run/trace/baseline 路径。
- compare 的兼容条件。
- promote 不自动执行。
- model run 出错时如何读取 trace，不通过重跑覆盖证据。

命令说明只维护在根 `README.md`，不新建平行 `docs/CLI.md`。

- [ ] **Step 3: 本地总回归**

```bash
npx tsc --noEmit -p tsconfig.json
npm test
npm run eval:check
npm run build
git diff --check
```

- [ ] **Step 4: 审计旧 metric 逻辑**

```bash
rg "Record<string, number>|metrics: \{|isPercentMetric|delta < 0|length \|\| 1|repairSuccessAfterFail.*: 1|baseline\.json" src scripts docs package.json
```

Expected：当前代码无旧 metrics 并集、命名猜 unit、所有负 delta 都退化或 N/A=1 的逻辑。

Stop and report：registry 完整性、所有测试、尚未创建的 baseline 列表。

## Task 6: Full Eval 与 Baseline 重建（逐项审批）

本 Task 包含真实模型/embedding/rerank 调用，每个子步骤执行前单独报告 case 数、模型、预计耗时和成本并获得用户确认。

- [ ] **Step 1: Retrieval full**

```bash
npm run eval
npm run eval:compare -- <retrieval-run>
```

人工检查 trace、dataset identity、remaining retrieval/rerank bad cases 后，才决定是否 promote retrieval。

- [ ] **Step 2: Faith full**

```bash
npm run eval:faith
npm run eval:compare -- <faith-run>
```

检查 context snapshot、judge invalid/error 和各 outcome，再决定是否 promote。

- [ ] **Step 3: Judge calibration**

```bash
npm run build:calibration
npm run eval:judge
npm run eval:compare -- <judge-run>
```

检查 quorum、一致率和人工 disagreement，再决定是否 promote。

- [ ] **Step 4: Generation/Fix full**

```bash
npm run eval:gen
npm run eval:fix
```

检查 resource assertions、relations、preflight 和 side effects，再分别 compare/promote。

- [ ] **Step 5: Baseline portability 验证**

在临时目录只复制 committed baseline files，不复制 runs/traces，确认 decoder 和 compare metadata 可读取；不得访问 source run artifact。

- [ ] **Step 6: 最终报告**

按 kind 输出：

- dataset hash/caseCount。
- metric definition version。
- required metrics 与分母。
- baseline sourceRunId/promotedAt。
- harness errors。
- 与旧 baseline 不可直接比较的原因。

Stop and report：五类 baseline 是否全部晋升，未晋升项及阻塞原因。

## Completion Gate

- 所有稳定 metric 有唯一 definition、方向、单位、分母和 stability。
- N/A 用 null 表达，console 与 persisted value 一致。
- compare 能识别方向、不可比较、required metric 缺失和实验变量。
- promote 只接受完整 scope/completed/trace-consistent run。
- baseline 是可移植 snapshot，不引用 ignored artifact。
- 本地测试、类型检查和 build 通过。
- 真实 baseline 仅在逐项人工审核后晋升，并记录不可与旧基线直接比较。
