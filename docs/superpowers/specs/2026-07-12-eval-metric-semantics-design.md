# Eval Metric Semantics 纠偏设计

> 状态：已自审，对应 implementation plan 已落盘，待执行。
> 用途：定义指标的方向、分母、空样本语义、可比较条件和 baseline 晋升门禁。
> 对应计划：`docs/superpowers/plans/2026-07-12-eval-metric-semantics.md`。
> 顺序：第四项实施。依赖 Artifact Protocol 和各 evaluator 的最终指标输出，完成 compare/promote 后再重建 baseline。

## 1. 目标

指标不能只是 `Record<string, number>`。每个数字必须能回答：测量对象是什么、分母是什么、越高还是越低越好、何时不可比较。

## 2. 当前问题

- compare 把所有负 delta 当作退化，导致 hallucination/error 下降反而报警。
- 没有适用样本时，repair success 被写成 100%，而 console 显示 N/A。
- 缺失指标只被跳过，可能把 evaluator 未产出关键指标误报成“无退化”。
- policy/smoke/targeted run 可以被直接晋升为 full baseline。
- generation/fix 没有 dataset hash，修改 case 后仍可能和旧 baseline 比较。

## 3. 非目标

- 不定义单条 Judge 或 Generation case 如何判定。
- 不自动决定某次模型或 corpus 变更是否应上线。
- 不在本轮建立 CI 强制门禁；先输出准确结论供人工审核。

## 4. Metric Definition

每个稳定指标必须注册定义：

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

interface MetricObservation {
  value: number | null;
  numerator?: number;
  denominator?: number;
}
```

`revision` 表达公式/判定语义版本。即使 key、方向和单位不变，只要 numerator/denominator、applicable case 或 pass 判定改变，也必须递增；它参与 metric definition version。

`null` 表示不适用或样本不足，不得用 0 或 1 代替。ratio 必须保存成对的 numerator/denominator，避免只看百分比无法判断样本规模；denominator 为 0 时 value 为 null。

## 5. Compare 规则

- kind、metric definition version、dataset hash 或测量参数不同：不输出改进/退化结论，只报告不可直接比较。当前 retrieval 的 k 必须相同，不能比较 Recall@3 与 Recall@5。
- model、corpus、index 或 prompt 变化：允许比较，因为这些通常就是实验变量，但必须列出变化项。
- 只比较双方都有定义且都有非 null observation 的指标。
- baseline 有而当前缺失的稳定指标视为 harness 输出缺口，不得报告“无退化”。
- regression 根据 definition.direction 判断；neutral 指标只展示 delta。
- ratio 同时展示百分比与样本数。

## 6. Baseline 晋升

允许的 scope：

- retrieval、faith、generation、fix：仅 `full`。
- judge：仅完整 calibration dataset 对应的 `calibration`。

晋升前必须满足：

- run status 为 `completed`。
- dataset hash、case count、metric definition version 完整。
- harness error 必须为 0；第一版不提供 override，先修复或重跑，避免把不完整证据晋升为 baseline。
- 当前稳定指标集合没有意外缺失。

promote CLI 负责执行门禁，不能只打印提醒。

晋升结果写为 Artifact Protocol 定义的独立 baseline snapshot，不复制 source run 的 artifact path。旧 baseline 无法满足新 identity 时先失效，等待同版本 full run 重建。

## 7. 初始方向约定

- Recall、MRR、faithful rate、refusal correct rate、valid YAML、kind/value/consistency/intent pass：越高越好。
- retrieval/rerank miss、hallucination、dual cause、judge invalid/error/indeterminate/unstable、max-round failure、harness error、latency、token、cost：越低越好。
- case count、judged count、failed-first count：neutral，仅用于解释分母。
- repair attempted 不默认代表好坏，先标 neutral；它可能表示模型首轮差，也可能表示 repair loop 正常工作。

## 8. 反例验收

- hallucination 从 2 降到 1 必须显示改善。
- max-round failure 从 20% 降到 10% 必须显示改善。
- 没有首轮失败样本时 repair-success-after-fail 显示 N/A。
- policy/smoke run promote 必须被拒绝。
- dataset hash 改变时不得输出“无退化”。
- baseline 有 consistency 指标而当前缺失时必须报告 harness 缺口。
