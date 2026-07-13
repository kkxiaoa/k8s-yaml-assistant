# Eval Artifact Protocol 纠偏设计

> 状态：已实施并完成 review。
> 用途：定义 retrieval、faith、judge、generation、fix 共用的评估证据协议，不定义各任务的指标公式。
> 对应计划：`docs/superpowers/plans/2026-07-12-eval-artifact-protocol.md`。
> 顺序：第一项实施。只定义 metric observation 的序列化形态；指标方向、compare 和 promote 由 Metric Semantics plan 负责。

## 1. 目标

一次 eval 必须形成可定位、可移植、可验证的证据链：

```text
dataset/config/model/corpus identity
  -> EvalRun
  -> per-case TraceEnvelope
  -> metrics
  -> baseline / bad case
```

run 是一次评估的事实入口；trace 是逐 case 证据；bad case 是长期问题台账。三者不能依赖文件名猜测关系。

## 2. 当前问题

- `EvalRun` 关键字段大量可选，不同 kind 的必填条件无法由类型或运行时校验保证。
- artifact 保存机器绝对路径，移动工作区后不可读取。
- retrieval bad case 写了 `${runId}:${evalCaseId}`，trace 行却没有对应 ID。
- runner 中途失败会留下无主 trace，没有 failed run 和错误阶段。
- faith 同时使用通用 `scope/caseIds` 与专属 `faithSelection` 两套表达。
- ignored run/trace 没有保留 legacy 兼容的必要，但代码仍需猜旧格式。

## 3. 非目标

- 不定义 Recall、Faithfulness、Judge agreement 等指标公式。
- 不修改检索排序、prompt 或模型。
- 不引入远程 observability backend。
- 不保留本地 ignored run/trace 的长期兼容读取。

## 4. Run 契约

`EvalRun` 使用 `kind` 判别联合。通用字段至少包括：

```ts
interface EvalRunBase {
  schemaVersion: number;
  id: string;
  kind: EvalKind;
  status: 'running' | 'completed' | 'failed';
  scope: EvalScope;
  createdAt: string;
  completedAt?: string;
  dataset: {
    id: string;
    hash: string;
    caseIds: string[];
    caseCount: number;
  };
  artifactPaths: {
    trace: string;
  };
  metricDefinitionVersion: string;
  metrics: Record<string, MetricObservation>;
  failure?: {
    stage: string;
    message: string;
  };
}
```

kind-specific run 只增加该 evaluator 必需的配置。例如 retrieval/faith 记录 corpus、index、embedding、rerank、query expansion；faith 额外记录 answer/judge model 和 prompt identity；judge 记录 vote、prompt 与 parser schema identity；generation/fix 记录 answer model、system prompt、tool schema 和 validation schema identity。

不得再增加 `faithSelection` 一类平行字段。scope、case IDs 和 dataset hash 只有一处事实源。

dataset caseIds 必须唯一，caseCount 与长度一致；hash 覆盖排序后的 canonical case snapshot，而不只覆盖 ID。语义字段变化必须改变 hash，数组声明顺序变化不得改变 hash。

Artifact Protocol 负责 `MetricObservation` 的可序列化形态：`value: number | null`，以及比例类 observation 成对出现的可选 `numerator/denominator`。协议层只验证 finite/non-negative、成对出现和零分母结构；公式、方向、单位和 compare 规则由 Metric Semantics 定义。

## 4.1 Baseline Snapshot

提交到 Git 的 baseline 不是 `EvalRun` 文件副本。它是从 completed run 晋升出的可移植 snapshot：

- 保留 schemaVersion、kind、scope、dataset identity、metric definition version、参与比较的模型/corpus/index/prompt 配置和 metrics。
- 记录 `sourceRunId` 与 `promotedAt`。
- 不保留 run 的 trace artifact path，因为 runs/traces 被 gitignore，新 clone 中该路径不存在。
- promote 时必须先在本地验证 source run 和 trace；写出的 baseline snapshot 可独立解码和比较。

## 5. Artifact 路径

- run 内只保存相对 `data/eval/` 的 POSIX 路径，例如 `traces/<runId>.faith.jsonl`。
- 路径由单一 resolver 转成当前工作区绝对路径。
- resolver 必须拒绝绝对路径、`..` 和越界路径。
- run 与 trace 文件名可以包含 kind 方便人工阅读，但程序关联只依赖 run metadata。

## 6. Trace Envelope

每条 trace 使用统一 envelope，payload 保留各 evaluator 自己的类型：

```ts
interface TraceEnvelope<TKind extends EvalKind, TPayload> {
  schemaVersion: number;
  traceId: string;
  runId: string;
  evalCaseId: string;
  kind: TKind;
  createdAt: string;
  outcome: 'success' | 'failed' | 'error' | 'skipped';
  payload: TPayload;
  error?: {
    stage: string;
    message: string;
  };
}
```

BadCase 的 latest lineage 只能引用写入当时真实存在的 `traceId`；converter 必须通过 run 的 trace artifact 验证该 ID 可解析。由于 runs/traces 被 gitignore，提交的 BadCase 还必须自包含可读的 expected/actual/failure 摘要，不能把 ignored trace 当作 fresh clone 上永久可解引用的外键。

## 7. 生命周期与失败

- runner 开始时先创建 `running` run，再执行 case。
- 每个已开始执行的 case 无论成功、质量失败、模型失败还是可记录的基础设施异常，都写一条 trace。
- 正常结束转为 `completed`；未完成或异常退出转为 `failed`，保存阶段和错误摘要。
- dataset/index/artifact 初始化等 run-level failure 不伪造 case trace；failed run 保留已写 trace，并明确未执行 case。
- run 更新使用临时文件加原子 rename，避免半写 JSON。
- baseline 只能由 `completed` run 晋升；晋升规则由 Metric Semantics 定义。
- serving trace sink 的写入失败不得改变 Ask 主流程结果，但必须有可观察的错误信号。

## 8. 运行时校验与迁移

- run、trace、baseline、bad case 的读取必须经过 runtime decoder，禁止只用类型断言。
- 是否引入 schema 库在 plan 阶段评估；若不引依赖，手写 decoder 也必须覆盖判别字段与必填字段。
- `data/eval/runs`、`data/eval/traces` 和 `data/observability` 属于 ignored artifacts，直接清理后重跑，不维护 legacy reader。
- 已提交 bad case 使用一次性迁移，迁移完成后删除兼容分支。
- 旧 baseline 若缺少构造新 snapshot 所需的 dataset/metric identity，必须显式失效并在最终 full run 后重建，禁止填充伪造字段。

## 9. 反例验收

- run 缺 kind、status、dataset hash 或 trace path 时读取失败。
- policy/smoke run 的 case IDs 与 trace 不一致时读取失败。
- 工作区移动后，相对 artifact path 仍可解析。
- trace ID 不存在时，BadCase converter 失败并指出具体 ID。
- fresh clone 没有 ignored trace 时，已提交 BadCase 仍可解码和理解；lineage 不被伪装成当前可用 artifact。
- case-scoped 异常后存在 error trace；run-scoped 异常后存在 failed run，不伪造 case trace，也不留下无主 artifact。
- serving sink 抛错时 Ask 仍返回检索结果。
- baseline snapshot 不包含 ignored trace 路径，在没有 runs/traces 的新 clone 中仍可解码。
