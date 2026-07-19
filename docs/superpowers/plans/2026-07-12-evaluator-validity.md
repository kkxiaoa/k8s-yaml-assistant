# Evaluator Validity 实施计划

> 状态：已实施并完成逐 Task（任务）审核。
> 对应设计：`docs/superpowers/specs/2026-07-12-evaluator-validity-design.md`。
> 顺序：纠偏计划 3/4；四份纠偏计划均已完成。

## Goal

修正 retrieval、grounded answer、judge、generation、fix 的测量对象和单 case 判定，让“case 通过”确实代表目标能力通过，而不是依赖可选字段、空集合、宽松 JSON coercion 或全局任意路径碰巧命中。

本计划不调模型、不改 retrieval 排名、不增加 docs/examples，也不晋升 baseline。

## Execution Rules

- 严格按 Task 顺序执行，每个 Task 后停止汇报并等待 review。
- 每个 evaluator 先写能复现旧误判的反例，再改实现。
- 共享逻辑必须位于无 `main()` 模块，单元测试不触发模型调用。
- case fixture 无效属于 harness/data error，不计入模型质量失败。
- 单 case 模型/网络错误写 error trace 并继续；全局初始化或 dataset error 终止 failed run。
- 未经用户要求不 commit，不运行真实模型 eval，不 promote baseline。

## Evaluator Boundaries

```text
Semantic Retrieval
  self-contained question -> searchCorpusTraced -> Recall/MRR

Editor Context Routing
  kind + cursorPath -> exact-field | fallback search -> deterministic test

Grounded Answer
  selected retrieval case + expected behavior -> context -> answer -> judge

Judge Calibration
  real pipeline snapshot + human label -> strict votes/quorum/agreement

Generation
  requirement -> resources -> resource assertions + relations

Fix
  verified broken fixture -> repaired target -> corrections + preservation
```

## File Structure

### Create

- `src/eval/cases/grounded-answer-cases.ts`
- `src/eval/cases/case-contracts.test.ts`
- `src/eval/assertions.ts`
- `src/eval/assertions.test.ts`
- `src/eval/judge-votes.ts`
- `src/eval/judge-votes.test.ts`

### Modify

- `src/eval/cases/retrieval-cases.ts`
- `src/eval/cases/generation-cases.ts`
- `src/eval/cases/fix-cases.ts`
- `src/eval/retrieval-eval.ts`
- `src/eval/faithfulness-eval.ts`
- `src/eval/faith-store.ts`
- `src/eval/answer.ts`
- `src/eval/judge.ts`
- `src/eval/judge-eval.ts`
- `src/eval/judge-eval.test.ts`
- `src/eval/metrics/judge-metrics.ts`
- `src/eval/metrics/generation-metrics.ts`
- `src/eval/metrics/generation-metrics.test.ts`
- `src/eval/generation-eval.ts`
- `src/eval/fix-eval.ts`
- `src/eval/faith-bad-cases.ts`
- `src/eval/faith-bad-cases.test.ts`
- `scripts/build-calibration.ts`
- `scripts/eval-check.ts`
- `data/eval/judge-calibration-labels.jsonl`

### Regenerate Later

- `data/eval/judge-calibration.jsonl`：只从新 faith TraceEnvelope snapshot 生成。

## Task 1: Semantic Retrieval 与 Grounded Answer Case 原子分层

**Files:**

- Modify: `src/eval/cases/retrieval-cases.ts`
- Create: `src/eval/cases/grounded-answer-cases.ts`
- Create: `src/eval/cases/case-contracts.test.ts`
- Modify: `scripts/eval-check.ts`
- Modify: `src/eval/retrieval-eval.ts`
- Modify: `src/eval/faithfulness-eval.ts`
- Modify: `src/eval/faith-store.ts`
- Modify: `src/eval/faith-bad-cases.ts` and tests
- Modify: `src/server/pipeline-retrieval.test.ts`

- [ ] **Step 1: 写非法 case 反例**

语义检索只定义 `SemanticRetrievalCase`，不再用 `answerable: boolean + optional fields` 同时承载拒答：

```ts
interface SemanticRetrievalCase {
  id: string;
  question: string;
  expectedChunkIds: string[];
  target: { kind: string; apiVersion?: string };
  source: 'human' | 'schema_generated' | 'bad_case';
}
```

同时定义判别式 `GroundedAnswerCase`：可答/冲突 case 通过 retrievalCaseId 引用 semantic question，拒答 case 直接保存 standalone question。覆盖：

- expectedChunkIds 必须非空，target kind 必填。
- question 必填且必须 self-contained，不能依赖未提供 EditorContext 才能理解。
- case ID 重复、expected ID 不存在、同一 expected ID 重复明确失败。
- semantic retrieval case 不接受 cursorPath/selectedText/YAML/errors。
- `taskType='refusal'`、`answerable` 和空 expected IDs 不属于该 contract。
- grounded retrieval reference 必须存在；standalone input 必须非空且当前只允许 refusal behavior。

- [ ] **Step 2: 原子迁移两份 dataset 和直接 consumers**

- 保持 81 条可答案例的 case ID、question 和人工语义不变。
- 使用 Provenance plan 后的新 canonical chunk IDs。
- `source` 只表达 origin；task/origin/role 的完整治理在主路线 Phase B，不在本 plan 顺便扩数据。
- 对无法从 question 独立理解的 case 明确重写 question，并使 dataset hash 变化可见。
- 原有 5 条拒答案例保留 ID/question，迁入 GroundedAnswerCase，不留在 retrieval dataset。
- 显式列出当前所有 faith cases，不用运行时 map 隐式推导 expected behavior。
- 同步迁移 retrieval runner、faith runner/store/bad-case converter 和 eval check；Task 结束时不得存在仍读取 `answerable` superset 的 consumer。

- [ ] **Step 3: semantic 指标改名和归位**

官方检索指标使用：

- `retrieval.semantic.recall`
- `retrieval.semantic.mrr`

其中 Recall 的持久化 key 固定为 `retrieval.semantic.recall`，`k` 是 retrieval run config 的必填测量参数；console 可展示为 `Recall@${k}` / `MRR@${k}`。不得为每个 k 动态创造 registry key。

`none/oracle/auto` 只作为 diagnostic observations，不标成 serving 指标。因为真实 serving 还包含 exact-field 分流，semantic runner 不能宣称覆盖整个 serving。

- [ ] **Step 4: 保持 Editor Context 独立测试**

`pipeline-retrieval.test.ts` 必须继续覆盖：

- exact 命中。
- exact 未命中 fallback search。
- query expansion exact skip。
- serving trace sink fail-open。
- schema/policy 同字段返回。

这些 case 不进入 retrieval run、Recall 或 MRR。

- [ ] **Step 5: 验证**

```bash
npx tsx src/eval/cases/case-contracts.test.ts
npx tsx src/eval/faith-bad-cases.test.ts
npm run eval:check
npx tsx src/server/pipeline-retrieval.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
```

Stop and report：semantic/grounded case 数、迁出的 refusal IDs、发生语义重写的 question、semantic 与 editor 分层边界。

## Task 2: Grounded Answer 期望语义与真实 Context Snapshot

**Files:**

- Modify: `src/eval/cases/grounded-answer-cases.ts`
- Modify: `src/eval/faithfulness-eval.ts`
- Modify: `src/eval/faith-store.ts`
- Modify: `scripts/build-calibration.ts`
- Modify: `src/eval/faith-bad-cases.ts`
- Modify: related tests

- [ ] **Step 1: 固定 expected behavior 与 source expectation**

```ts
type GroundedAnswerCase =
  | {
      id: string;
      input: { kind: 'retrieval_case'; retrievalCaseId: string };
      expectedBehavior:
        | 'answer_with_sources'
        | 'explain_schema_policy_conflict';
      sourceExpectation?:
        | { mode: 'required'; types: SourceType[] }
        | { mode: 'allow_missing_with_disclosure'; types: SourceType[] };
    }
  | {
      id: string;
      input: { kind: 'standalone_question'; question: string };
      expectedBehavior: 'refuse_insufficient_context';
    };
```

Task 1 已完成结构分流。本 Step 逐条审核 expected behavior；policy conflict case 必须显式选择 required 或 allow-missing source expectation，不能由 judge 根据运行结果临时猜。

- [ ] **Step 2: 写 case 对齐测试**

覆盖：

- `retrieval_case` 的 retrievalCaseId 必须存在。
- `standalone_question` 必须提供非空 question，且当前只允许 refusal behavior。
- grounded case ID 唯一。
- source expectation 的 types 必须非空、去重且属于当前 SourceType union。
- policy conflict 必须声明 schema/policy；若产品规则允许缺 policy 后诚实降级，使用 `allow_missing_with_disclosure`，并把完整回答和诚实降级分别统计，而不是 judge 临时猜。
- full/policy/smoke selection 只从 GroundedAnswerCase 选择。
- retrieval run 的 dataset identity 只含 81 条 semantic cases；faith run 的 dataset identity 只含本次 GroundedAnswerCase selection，两者不共享一个模糊 hash。

- [ ] **Step 3: Faith payload 保存实际输入**

每条 faith trace payload 至少保存：

- input kind、可选 retrievalCaseId、最终 question、expectedBehavior。
- routed/expanded query 和 query expansion config。
- coarse/rerank/final retrieval diagnostics 或完整嵌入的 search trace payload。
- 最终选择的 context chunks/sources snapshot，包含 id/title/text/sourceType/provenance/targets。
- 实际发送给 answer model 的 context string。
- answer、judge attempts/verdict、outcome、error phase。

禁止仅保存 topIds 后从当前 corpus 重建。

- [ ] **Step 4: Calibration/BadCase consumers 使用 snapshot**

- `build-calibration` 直接复制 faith trace 中的 context/sources/answer。
- calibration row 保存 sourceFaithRunId 和 sourceFaithTraceId。
- faith bad-case converter 从 envelope payload 读 outcome/evidence。
- 缺 snapshot 的旧数据明确失败，不回退当前 corpus。

- [ ] **Step 5: 验证**

使用本地 fixture 构造 trace，不调用模型：

```bash
npx tsx src/eval/cases/case-contracts.test.ts
npx tsx src/eval/faith-bad-cases.test.ts
npx tsc --noEmit -p tsconfig.json
```

Stop and report：GroundedAnswerCase 数量/分布、context snapshot 大小、calibration lineage。

## Task 3: Strict Judge Vote 与 Quorum

**Files:**

- Create: `src/eval/judge-votes.ts`
- Create: `src/eval/judge-votes.test.ts`
- Modify: `src/eval/judge.ts`
- Modify: `src/eval/judge-eval.ts`
- Modify: `src/eval/judge-eval.test.ts`
- Modify: `src/eval/metrics/judge-metrics.ts`

- [ ] **Step 1: 写 parser 反例**

以下都必须是 invalid vote：

- `"faithful":"false"`。
- 缺 faithful/unsupported/reason。
- unsupported 包含非 string。
- policy object 字段为 string/number/null。
- JSON 外带无法可靠提取的文本。

有效 vote 必须完整保留 parsed value；失败 vote 保存错误 code/message，不用 `Boolean()` coercion。

- [ ] **Step 2: 实现 JudgeAttempt**

```ts
type JudgeAttempt =
  | { status: 'valid'; vote: JudgeVote }
  | { status: 'invalid'; reason: string }
  | { status: 'error'; stage: string; message: string };
```

所有 judge 调用共用严格 parser。Faith 可使用单次有效 verdict 语义；calibration 使用下面的多票 quorum。

- [ ] **Step 3: 实现 quorum**

- planned votes 默认 5。
- faithful 至少 3 个有效 vote 才判定。
- 偶数有效票平票 -> indeterminate。
- policy 每个维度独立统计有效票和 quorum。
- 1/5 valid、2/5 valid、2:2 tie 都不能形成 false。
- invalid/error attempts 不进入 agreement 分母，但进入 judge failure 诊断。

- [ ] **Step 4: Trace 保存完整诊断**

Judge calibration trace 保存：

- planned/valid/invalid/error counts。
- 每次 attempt 状态和解析失败原因。
- 每个维度 quorum/majority/unstable/agree。
- human label 和 source faith lineage。

- [ ] **Step 5: 校准数据 preflight**

- human label schema 严格校验。
- policy 维度只在明确人工 label 时计算。
- calibration snapshot 缺 context/answer/source trace lineage 时整批失败。

- [ ] **Step 6: 验证**

```bash
npx tsx src/eval/judge-votes.test.ts
npx tsx src/eval/judge-eval.test.ts
npx tsc --noEmit -p tsconfig.json
```

Stop and report：quorum 规则、旧 parser 误判反例、需要重新人工检查的 labels。

## Task 4: Resource-bound Generation Assertions

**Files:**

- Create: `src/eval/assertions.ts`
- Create: `src/eval/assertions.test.ts`
- Modify: `src/eval/cases/generation-cases.ts`
- Modify: `src/eval/metrics/generation-metrics.ts`
- Modify: `src/eval/metrics/generation-metrics.test.ts`
- Modify: `src/eval/generation-eval.ts`

- [ ] **Step 1: 定义无函数数据 contract**

```ts
interface ResourceIdentity {
  apiVersion: string;
  kind: string;
  name?: string;
}

type FieldAssertion =
  | { type: 'exists'; path: string }
  | { type: 'equals'; path: string; value: JsonValue }
  | { type: 'contains'; path: string; value: JsonValue }
  | { type: 'matches'; path: string; rule: NamedAssertionRule };

interface ExpectedResource {
  ref: string;
  identity: ResourceIdentity;
  assertions: FieldAssertion[];
}
```

`NamedAssertionRule` 只能来自已测试 registry，不在 case 中放任意函数或代码字符串。

- [ ] **Step 2: 写资源匹配反例**

覆盖：

- expected resource 缺失或匹配多个文档失败。
- 只返回 ConfigMap 时 Deployment+Service case 全部失败。
- 路径只存在于无关文档时失败。
- kind 正确但 apiVersion/name 错误时失败。
- replicas/image/port 值错误时 content fail。
- array 路径必须在同一个匹配元素上满足关联条件，不能跨元素拼接。

- [ ] **Step 3: 定义 ResourceRelation**

使用 ref 引用 expected resources：

- workload selector <-> pod template labels。
- Service selector -> workload labels。
- Service targetPort -> workload containerPort。
- Ingress backend -> Service name/port。
- StatefulSet serviceName -> headless Service。
- HPA scaleTargetRef -> workload identity。
- Deployment ConfigMap ref -> ConfigMap identity。

关系任一端缺失、重复或类型错误都失败，禁止 vacuous pass。

- [ ] **Step 4: 迁移 26 条 Generation case**

逐条把自然语言要求转成：

- expectedResources。
- 具体 value assertions。
- relations。

迁移验收不是“类型通过”，而是每条 requirement 中可确定的名称、版本、副本、镜像、端口、枚举、引用和配置值都被断言。无法稳定确定的要求记录 rationale，不写模糊 predicate。

- [ ] **Step 5: 重写 result builder**

Case result 保存每个 resource assertion/relation 的 pass/failure reason。`contentPass` 只在 valid YAML、所有 expected resources、assertions 和 relations 均通过时为 true。

- [ ] **Step 6: 验证**

```bash
npx tsx src/eval/assertions.test.ts
npx tsx src/eval/metrics/generation-metrics.test.ts
npx tsc --noEmit -p tsconfig.json
```

Stop and report：迁移 case 数、断言/关系覆盖、旧 vacuous pass 反例。

## Task 5: Fix Fixture Preflight 与 Targeted Corrections

**Files:**

- Modify: `src/eval/cases/fix-cases.ts`
- Modify: `src/eval/assertions.ts`
- Modify: `src/eval/assertions.test.ts`
- Modify: `src/eval/metrics/generation-metrics.ts`
- Modify: `src/eval/metrics/generation-metrics.test.ts`
- Modify: `src/eval/fix-eval.ts`

- [ ] **Step 1: 定义 FixCase**

```ts
interface FixCase {
  id: string;
  brokenYaml: string;
  defectType: DefectType;
  target: ResourceIdentity;
  preserve: FieldAssertion[];
  expectedCorrections: FieldAssertion[];
}
```

- [ ] **Step 2: 全数据集 preflight**

在任何模型调用前验证全部 fixture：

- YAML 可按预期 parse 或明确属于 parse_error。
- 非 parse_error fixture 必须命中至少一个声明缺陷。
- parse_error 修复前必须真实 parse 失败。
- 非 parse_error fixture 的 target 必须唯一存在。
- expectedCorrections 在 broken fixture 上至少有一条不满足，避免把本来正确的 YAML 当修复题。

parse_error fixture 只要求真实 parse 失败；它的 target、preserve 和 expectedCorrections 在修复结果上验证，不声称能从不可解析输入完成结构定位。

任一 fixture 无效时 run 标记 failed，列出 case，不调用模型。

- [ ] **Step 3: 迁移 8 条 Fix case**

逐条声明 target、必须保留的值和修复后必须满足的 correction。类型、枚举、required、unknown field 和 parse error 都有确定性 expected correction。

- [ ] **Step 4: 修复结果验收**

- 最终目标 kind/apiVersion/name 保持。
- expectedCorrections 全部通过。
- preserve 全部通过。
- 不允许新增未请求资源或删除无关原资源。
- 值只出现在其他文档时不算保留。

- [ ] **Step 5: 验证**

```bash
npx tsx src/eval/assertions.test.ts
npx tsx src/eval/metrics/generation-metrics.test.ts
npx tsc --noEmit -p tsconfig.json
```

Stop and report：preflight 结果、8 条 correction/preserve 覆盖、额外副作用规则。

## Task 6: Runner Error 语义与 Harness 指标输入

**Files:**

- Modify: `src/eval/retrieval-eval.ts`
- Modify: `src/eval/faithfulness-eval.ts`
- Modify: `src/eval/judge-eval.ts`
- Modify: `src/eval/generation-eval.ts`
- Modify: `src/eval/fix-eval.ts`
- Modify: runner/session tests

- [ ] **Step 1: 统一 error stage**

至少区分：

- dataset/preflight。
- index/embed/retrieve/rerank。
- answer model。
- YAML parse/schema validation。
- judge request/judge parse/quorum。
- artifact write。

- [ ] **Step 2: 单 case 与 run fatal 分层**

- 单 case 模型、网络、解析异常写 error envelope，继续下一 case。
- dataset、schema/index identity、artifact store 初始化错误使 run failed 并终止。
- error/skipped case 不进入质量指标分母，但进入 harness error observations。
- 所有 selected case 都必须有一个 envelope。

- [ ] **Step 3: 输出不再混淆失败**

console/report 分别显示 quality fail、judge indeterminate、harness error 和 skipped，不把“未判定”算 false。

- [ ] **Step 4: 验证**

通过 stub 注入每一阶段错误，不调用网络：

```bash
npm test
npx tsc --noEmit -p tsconfig.json
```

Stop and report：error taxonomy、继续/终止规则、各 evaluator 分母输入。

## Task 7: 总回归与真实 Eval 决策

- [ ] **Step 1: 本地总回归**

```bash
npx tsc --noEmit -p tsconfig.json
npm test
npm run eval:check
npm run build
git diff --check
```

- [ ] **Step 2: 反例审计**

确认以下全部由测试覆盖：

- exact case 和 refusal case 不进入 Recall/MRR。
- judge string boolean、1/5 valid、2:2 tie 不形成结论。
- 缺 Deployment/Service 的 relation 不通过。
- 关键 value 错误不通过。
- invalid fix fixture 阻止模型调用。
- preserve 值只在无关资源时不通过。

- [ ] **Step 3: 模型 eval 仅列计划**

报告 retrieval、faith、judge、generation、fix 的 case 数、调用模型和预计成本。真实 run 等 Metric Semantics plan 完成后统一执行，避免生成无法正式比较的中间 run。

Stop and report：本地验证结果、稳定 metric 候选清单、第四份 plan 输入。

## Completion Gate

- semantic retrieval 与 editor exact routing 测量边界清楚。
- Faith 使用显式 GroundedAnswerCase，并保存真实 context/source snapshot。
- Judge 严格解析并执行 quorum，invalid/indeterminate 不冒充 false。
- Generation case 绑定具体资源、值和关系，不存在空集合通过。
- Fix fixture 全量 preflight，结果验证 correction、preserve 和副作用。
- error 与质量失败分开记录，所有 selected case 有 trace envelope。
- 本地测试、类型检查和 build 通过。
