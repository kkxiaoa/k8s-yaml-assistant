# Evaluator Validity 纠偏设计

> 状态：已自审，对应 implementation plan 已落盘，待执行。
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

## 4. Judge Calibration

- Judge JSON 必须经过严格 schema 校验；缺字段、字符串布尔值、非字符串 unsupported item 均视为无效票。
- 每次计划投票数、有效票、失败票和失败原因全部写 trace。
- 默认 5 次投票，至少 3 次有效票才形成 case 结论。
- 有效票平票返回不可判定，不能归为 false。
- policy 每个维度独立计算 quorum；只返回部分 policy 字段不能被当成完整成功。
- agreement 的分母只包含达到 quorum 的 case；不足 quorum 单独计入 judge failure。
- calibration snapshot 保存实际 context、answer、human label、source faith run/trace ID 和版本指纹。

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
