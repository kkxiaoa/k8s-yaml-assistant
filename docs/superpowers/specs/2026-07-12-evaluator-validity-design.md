# Evaluator Validity 纠偏设计

> 状态：已实施并完成用户审核；Faith（忠实度）回答行为已与忠实性独立判定，Judge（裁判模型）问题与生成输入边界已分离。
> 用途：定义 retrieval、faith、judge、generation、fix 的单 case 判定有效性；不负责 artifact 路径和通用指标比较。
> 对应计划：`docs/superpowers/plans/2026-07-12-evaluator-validity.md`。
> 顺序：第三项实施。依赖 Artifact Protocol 和最终 knowledge identity，产出 Metric Semantics 所需的稳定指标集合。

## 1. 目标

同一 artifact 协议不能掩盖不同 evaluator 的测量对象。每种 evaluator 必须有独立 case contract、失败语义和反例测试，避免“文件写出来了，但尺子测错了”。

## 2. Retrieval 分层

### 2.1 语义检索质量

`RETRIEVAL_CASES` 继续评估 `searchCorpusTraced()`：

```text
self-contained question
  -> dense / routing / query expansion
  -> coarse candidates
  -> rerank
  -> Recall / MRR / retrieval bad case
```

问题本身必须包含足以检索的语义，例如“Deployment 里容器镜像写在哪个路径”。该层不注入 EditorContext，不测 exact-field 短路。

语义 retrieval dataset 只保留可计算 Recall/MRR 的可答案例，并要求非空 expected IDs。现有 81 条可答案例迁移为 `SemanticRetrievalCase`；5 条拒答案例不再冒充 retrieval case，迁入 Grounded Answer dataset。知识 ID 变化时执行一次可审计映射。

### 2.2 编辑器上下文检索分流

真实 `retrieveContext()` 还包含：

```text
kind + cursorPath
  -> exact-field hit
  -> 未命中才 fallback search
```

这是确定性分流逻辑，当前继续由 `pipeline-retrieval.test.ts` 覆盖 exact 命中、fallback、trace sink 和 schema/policy 分层。它不进入语义检索 Recall/MRR，避免 exact case 抬高检索指标。

当前不新增 `ServingRetrievalCase`、独立 run 或 baseline。只有满足以下任一条件才升级：

- editor-context case 扩大到需要统计代表性指标；
- 需要长期观察 exact-hit/fallback rate；
- selectedText、errors、YAML context 开始产生大量真实 bad case；
- serving feedback 需要离线回放。

不得把 question、mode、cursorPath、selectedText、errors、YAML 全部堆入一个可选字段 superset，再用同一个 evaluator 混算 Recall/MRR。

## 3. Faith / Grounded Answer

Faith 可以复用 retrieval 问题，但需要显式选择和期望行为，不能默认“所有 retrieval case 都具有相同生成评估语义”。目标结构：

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

当前 81 条可答问题通过 `retrieval_case` 引用避免复制 question；原有 5 条拒答问题以 `standalone_question` 迁入 Grounded Answer。两类输入由判别联合约束，不使用大量可选字段的 superset。

`allow_missing_with_disclosure` 用于检索缺少某类来源时的诚实降级：答案必须明确说明缺失，不能编造该来源结论。它与“全部 required sources 已进入 context 并完成冲突表达”分别统计，不能混成一个通过状态。

source expectation 的 types 必须非空、去重并经过 runtime 校验。

Faith trace 必须保存实际送入生成和 judge 的 context/source snapshot、检索诊断或可解析 retrieval trace ID、query-expansion 配置和 error phase。不能从未来的当前 corpus 重建旧 context。

Faith 判定必须分开保存和计算以下事实：

- `faithful` 只表示回答中的具体事实是否都有当前证据支持。
- `responseBehavior` 只表示实际输出是 `answer | refusal | non_answer`。
- `expectedBehavior` 是否满足由评估器按用例契约计算，不能从 `faithful` 推导。
- retrieval `fullRecall`、source coverage 和 schema/policy 冲突表达分别保留，不互相冒充。

当前完整通过要求：

- Judge（裁判）形成有效结论且 `faithful=true`；
- `answer_with_sources` 实际为 `answer`；
- `refuse_insufficient_context` 实际为 `refusal`；
- `explain_schema_policy_conflict` 实际为 `answer`，且 `distinguished=true`、`conflictExplained=true`、`misstatedAsOfficial=false`；
- 可答用例达到 `fullRecall`；
- 必需来源覆盖状态为 `complete`。

`allow_missing_with_disclosure` 在引入经过校准的 disclosure（缺失披露）判定前不能算完整通过，不能仅凭回答忠实就推断已经披露。Faith trace 的粗粒度 outcome（结果）只使用 `passed | failed | judge_failed | error`；unsupported response（无依据回答）、behavior mismatch（行为不符）、retrieval incomplete（检索不完整）和 source incomplete（来源不完整）作为并列诊断，不使用 `hallucination`、`dual_cause` 等名称声称已证明因果。旧 Faith run/trace（忠实度运行 / 轨迹）属于 Git 忽略产物，已在重新评估前删除，当前解码器不维护旧 outcome（结果）或缺失回答行为的兼容分支。

## 4. Judge Calibration

- Judge JSON 必须经过严格 schema 校验；缺字段、字符串布尔值、非字符串 unsupported item 均视为无效票。
- 当前 Judge 输出必须独立给出 `responseBehavior: answer | refusal | non_answer`；`faithful=true` 不代表正确拒答，`faithful=false` 也不决定实际回答行为。Faith trace 必须保存该字段，缺失时严格拒绝。
- 每次计划投票数、有效票、失败票和失败原因全部写 trace。
- 默认 5 次投票，至少 3 次有效票才形成 case 结论。
- 有效票平票返回不可判定，不能归为 false。
- `responseBehavior` 使用独立法定人数和投票诊断；只有人工标签显式标注该维度时才计算一致率，没有人工标签时必须报告 N/A（不适用），不得从 category（类别）、回答文本或既有 faithful 标签自动生成“人工”答案。
- policy 每个维度独立计算 quorum；只返回部分 policy 字段不能被当成完整成功。
- agreement 的分母只包含达到 quorum 的 case；不足 quorum 单独计入 judge failure。
- human label 绑定明确的 source faith run ID；同名用例的新回答不能自动继承旧标签。
- calibration snapshot 保存实际 context、answer、human label、source faith run/trace ID 和版本指纹。
- Faith（忠实度）和 Judge Calibration（裁判校准）调用必须把 `question` 作为独立边界传给 Judge（裁判模型）。生成输入快照继续原样保存和传入，以覆盖 `<docs>`、`<current_yaml>` 和 `<editor_context>` 中的真实回答依据；其中重复的问题、提示说明和 `<ask_mode>` 不得被当作事实依据。
- Judge parser（裁判解析器）为每次 parser-invalid response（解析无效响应）保存归一化停止原因、文本块数量和非文本块数量，用于命令行按错误码聚合诊断；不保存原始响应、推理内容或用量。该元数据在 runtime decoder（运行时解码器）中保持可选，只用于继续读取当前已审核的旧 Faith trace（忠实度轨迹）；当前生产者必须写入。
- Judge（裁判）使用独立的 8,192 token（令牌）输出预算，其他文本调用继续使用共享的 1,024 token（令牌）。该预算与模型、系统提示和实际用户消息模板共同进入 `judgePromptHash`，不再增加重复配置身份。
- `judgePromptHash` 必须覆盖系统提示、实际用户消息模板、模型和输出预算；问题、生成输入和回答的逐用例内容继续由 dataset/run/trace identity（数据集 / 运行 / 轨迹身份）约束，不重复进入提示模板身份。
- Judge（裁判）的通用主张边界必须把字段、资源、API、参数、键、命令和校验 / 准入 / 拒绝 / 运行结果视为具体主张；“示例”只允许为依据已说明可配置的字段或参数给出明确占位值，不能引入新的具体名称或行为。披露来源不足不能抵消同一回答中的无依据主张。问题只有在依据已明确列出有限选项时才可从中限定一个选项。
- 当前 DeepSeek Anthropic-compatible API（深度求索 Anthropic 兼容接口）的官方支持字段未列出 OpenAI-compatible API（OpenAI 兼容接口）专用的 `response_format`，因此不切换客户端、不增加平行网络层，也不声称已启用供应商 JSON mode（数据格式模式）。Judge（裁判）提示必须提供合法 JSON（数据格式）对象示例，禁止使用 `true 或 false` 等不可解析伪格式；无 `[policy]` 来源时必须完全省略 `policy`，不得输出 `null` 或空对象。严格解析器继续拒绝前后说明、多对象和契约外字段。
- `eval:judge`（裁判评估）无选择参数时使用完整人工校准集并记录 `calibration` 范围；重复 `--case <case-id>` 时从同一校准文件按标识严格选择并记录 `targeted`（定向）范围。未知、重复或非法参数必须在模型客户端初始化前失败。定向运行复用正式 5 票、法定人数、trace（轨迹）和指标协议，但不能晋升 baseline（基线）。
- 上述预算依据 DeepSeek（裁判模型）官方 [Anthropic API compatibility（Anthropic 接口兼容说明）](https://api-docs.deepseek.com/guides/anthropic_api)、[Thinking Mode（思考模式）](https://api-docs.deepseek.com/guides/thinking_mode)和 [JSON Output（JSON 输出）](https://api-docs.deepseek.com/guides/json_mode)：思考模式默认开启，`max_tokens` 受支持，结构化 JSON（数据格式）输出需要足够预算避免截断。8,192 是针对 4,096 预算下再次观测到 9 次 `max_tokens`（令牌上限）无效票的有界项目预算，不声称是供应商上限。

## 5. Generation

保留现有 requirement，但 expected contract 改为资源定向断言：

```ts
interface ExpectedResource {
  ref: string;
  identity: {
    apiVersion: string;
    kind: string;
    name?: string;
  };
  assertions: FieldAssertion[];
}

interface GenerationCase {
  id: string;
  requirement: string;
  expectedResources: ExpectedResource[];
  relations?: ResourceRelation[];
}
```

FieldAssertion 至少支持 path existence、具体值、集合包含和 predicate。ResourceRelation 至少覆盖当前真实 case 所需的 selector/label、Service targetPort/containerPort、Ingress/Service、StatefulSet/serviceName、HPA/scaleTargetRef 和 ConfigMap 引用。

一致性检查必须先确认参与资源存在并唯一匹配；空资源集合、缺少关系一端、匹配到错误 workload 都必须失败。不得用全局任意文档的同名 path/value 代替目标资源断言。

## 6. Fix

保留 broken YAML、defectType 和人工意图，但断言绑定到目标资源：

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

调用模型前必须执行 fixture preflight：YAML 必须真实包含声明的缺陷。非 parse-error fixture 必须能唯一定位目标资源；parse-error fixture 必须真实解析失败，目标 identity 和 preserve/correction 在修复结果上验证，不能伪称已从损坏输入完成结构定位。fixture 无效时整个 run 失败，不能跳过后继续计算指标。修复结果出现额外资源、目标 kind/name 改变或只在其他文档中碰巧保留值，都不能算通过。

## 7. Error 语义

- 模型、网络、解析器、validator、judge 的异常必须区分阶段。
- error case 不进入质量指标分母，但必须进入 harness error 指标和 trace。
- 单 case error 不应默认终止全批；无法保证后续结果可信的初始化/数据集错误必须终止 run。

## 8. 反例验收

- exact-field 和拒答案例不进入 search Recall/MRR。
- Judge 的 `"faithful":"false"`、缺字段、1/5 有效票和 1:1 平票均不可形成有效结论。
- 只返回 ConfigMap 时，Deployment+Service 的所有 consistency checks 必须失败。
- Deployment 镜像、replicas 或端口值错误时 content pass 必须失败。
- StatefulSet `serviceName` 指向错误 Service 时 relation 必须失败。
- Fix fixture 没有声明缺陷时 run 必须失败。
- preserve 值只出现在无关文档时 intent-preserved 必须失败。
