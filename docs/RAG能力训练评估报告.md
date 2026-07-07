# RAG 能力训练评估报告

> 评估日期：2026-06-20  
> 评估对象：当前 `k8s-yaml-assistant` 项目的 RAG 实现  
> 新评估口径：**不是评估它能不能成为成熟 K8s AI 产品，而是评估它作为 AI 应用开发训练项目，已经覆盖哪些 RAG 能力，还缺哪些训练模块。**

---

## 1. 结论

当前 RAG 实现已经具备较好的训练价值。

它不是简单调 API 的玩具 demo，因为已经覆盖了 RAG 应用中的多个关键环节：

- schema ingestion
- 结构化 chunking
- dense retrieval
- resource / field path boost
- rerank
- editor context
- sources 展示
- Recall@k / MRR
- Faithfulness
- 拒答意识

但如果从“训练自己成为 AI 应用开发者”的角度看，当前能力链还没有闭环。

最主要的缺口不是“产品还不够成熟”，而是：

- 大语料索引还不可持续
- eval 还不能稳定支撑日常迭代
- 语料规模和评估集严重不匹配，当前 13 条存储题不能代表 997 个资源
- 缺少 baseline 和指标 diff，无法证明改动是正收益还是负收益
- retrieval trace 缺失
- hybrid retrieval 缺失
- Generate / Fix 生成层还缺少独立评估
- claim-level grounding 缺失
- bad case 归因和回灌缺失
- 多知识层融合还未开始

因此，当前阶段的判断是：

**RAG 基础链路已经跑通，但还没有完成 AI 应用开发者必须掌握的“可测、可诊断、可迭代”训练闭环。**

---

## 2. 当前已经训练到的能力

## 2.1 知识摄取与 schema 建模

当前项目已经从手写少量 schema，演进到 generated schema 加载。

当前本地语料规模：

```json
{
  "total": 88879,
  "resources": 997
}
```

训练价值：

- 理解 OpenAPI / CRD 如何进入 AI 应用知识库
- 理解 schema 可以同时服务问答、校验、生成修复
- 理解统一事实源的重要性

当前不足：

- source metadata 还不完整
- 缺少 source version / sourceUri / trustLevel
- docs / examples / policy 尚未进入统一 ingestion

## 2.2 结构化 chunking

当前 `schema-corpus.ts` 采用一字段一 chunk：

- resource
- path
- title
- type
- enum
- required
- description

训练价值：

- 理解 chunk 不是简单按长度切文本
- 理解 metadata 对检索和证据展示的重要性
- 理解字段级问答适合结构化切片

当前不足：

- schema chunk 适合字段事实，不适合行为语义
- 缺少文档型 chunk、示例型 chunk、策略型 chunk
- 缺少 chunk 质量评估

## 2.3 检索链路

当前链路：

```text
question + editor context
        ↓
RetrievalQuery
        ↓
exact field hit
        ↓
dense retrieval
        ↓
resource / path boost
        ↓
Voyage rerank
        ↓
top-k docs
```

训练价值：

- 理解 dense retrieval 的基本工作方式
- 理解 metadata boost 比硬过滤更安全
- 理解 rerank 只能重排粗召回候选
- 理解字段场景可以用 exact match 降低成本和误召回

当前不足：

- 没有 BM25 / sparse retrieval
- 没有 hybrid fusion
- 没有 score threshold
- 没有持久化向量索引
- 没有检索 trace
- `COARSE_N = 10` 对大语料偏小，缺少基于指标的调参机制

## 2.4 上下文工程

当前已支持：

- `AskMode`
- `EditorContext`
- `kind`
- `apiVersion`
- `selectedText`
- `cursorPath`
- validation errors

训练价值：

- 理解 AI 应用不是只传一个 user question
- 理解上下文要结构化，而不是全部拼成一个字符串
- 理解不同用户动作应对应不同 retrieval policy

当前不足：

- 上下文还没有进入 trace
- 没有历史对话 / 最近操作上下文
- 没有上下文质量评估

## 2.5 证据化与 grounded answer

当前已支持：

- `/api/ask` 返回 sources
- 前端展示 resource、path、sourceType、snippet
- prompt 要求只依据 docs 作答

训练价值：

- 理解 RAG 回答必须暴露依据
- 理解 sources 是建立信任的起点
- 理解拒答是质量行为，不是失败

当前不足：

- sources 只是检索命中，不等于答案每个 claim 都有依据
- 没有引用编号
- 没有 claim-level grounding 检查
- 没有 source trust level
- 没有低置信度拒答策略

## 2.6 评估意识

当前已有：

- `src/eval/retrieve-eval.ts`
- `src/eval/eval-set.ts`
- `src/eval/faithfulness-eval.ts`
- Recall@k
- MRR
- Faithfulness
- 拒答正确率

训练价值：

- 理解 RAG 不能靠感觉调
- 理解检索和生成要分层评估
- 理解 Faithfulness 不等于 Correctness
- 理解 LLM-as-judge 有噪声

当前不足：

- 检索 eval set 只有 13 条
- Faithfulness set 只有 9 条
- eval case 没有覆盖足够多任务类型
- 大语料评估不可持续
- 没有实验版本记录

---

## 3. 关键训练缺口

## 3.1 大语料工程训练不足

曾尝试运行：

```bash
npm run eval -- 3
```

输出显示：

```text
评估(k=3,语料 88879 段,标注 13 条)
```

该评估长时间未完成，最终中断。

这个现象的训练意义很重要：

**小语料 RAG 满分不代表大语料 RAG 可用。**

需要补的训练能力：

- embedding 持久化
- vector index 持久化
- eval 不再全量重算
- index version 管理
- 语料规模增长后的成本和延迟治理

## 3.2 检索诊断训练不足

当前如果回答错了，还不能系统性回答：

- query 被如何改写？
- resource hint 是什么？
- coarse retrieval 命中了什么？
- rerank 前后排序怎么变？
- 哪个 source 最终进入 prompt？
- 错误是知识缺失、切片问题、检索问题还是生成问题？

需要补的训练能力：

- retrieval trace
- bad case 归因
- dense / sparse / rerank 对比
- eval report

## 3.3 Hybrid retrieval 训练不足

当前主要是 dense retrieval + rerank。

但 K8s YAML 场景里，很多问题天然适合关键词检索：

- 字段名
- kind
- apiVersion
- validation error
- CRD 名称
- 枚举值

需要补的训练能力：

- BM25 / sparse index
- dense + sparse fusion
- RRF 或 weighted score
- query type routing

## 3.4 Grounding 训练不足

当前已经展示 sources，但还没有做到 claim-level grounding。

需要补的训练能力：

- answer citation
- claim extraction
- claim-source verification
- unsupported claim rewrite
- refusal when evidence is insufficient

## 3.5 反馈闭环训练不足

当前还没有形成：

```text
bad case
→ 归因
→ 加入 eval
→ 修 retrieval / chunk / prompt
→ 回归验证
```

需要补的训练能力：

- query log
- source hit log
- answer log
- 用户反馈
- bad case taxonomy
- eval additions

---

## 4. 训练路线建议

## Stage 0：先修评估尺子

目标：

**先决定语料范围和 eval 代表性，否则后续指标都不可信。**

任务：

- 默认先采用精选语料训练场，而不是被 88k 全量语料绑架
- 写出 curated resource list
- 建立人工核心集 + schema 派生集 + bad case 回灌集
- 建立 `data/eval/baseline.json`
- 建立 `npm run eval:compare`

验收：

- eval 覆盖策略明确
- baseline 存在
- 每次改动能看到相对 baseline 的指标变化
- 不再用 13 条存储题代表全语料能力

## Stage 1：让 RAG 可稳定评估与追踪

目标：

**让系统可测、可追踪、可复现。**

任务：

- 持久化 embeddings / vector index
- 改造 `npm run eval`
- 增加 retrieval trace
- 输出 route、query、coarse hits、rerank hits、final hits
- 输出 latency、cache hit、token / cost
- 增加 bad case 分类
- 记录 prompt docs

验收：

- 任意一条错误回答都能归因
- 能区分检索失败、切片失败、知识缺失、生成幻觉
- 能看到一次改动的指标 diff

## Stage 2：条件触发 hybrid retrieval

目标：

**Hybrid 由 bad case 触发，不作为无条件必做项。**

任务：

- 先确认 dense + rerank 是否在关键词类问题上失召回
- 增加 BM25
- 合并 dense / sparse
- 调整 coarse topN
- rerank top-k
- 增加 score threshold

验收：

- 至少 10 条关键词类 bad case 证明需要 hybrid
- 字段名和错误文本可以被关键词兜底
- dense 与 sparse 命中差异可见
- 低置信度问题能拒答

## Stage 3：训练 YAML Generate / Fix

目标：

**把自然语言需求、当前 YAML 和校验错误转化为可校验、可修复、可解释的 YAML。**

任务：

- 结构化 GenerateRequest
- 生成 YAML 后执行 parse / schema validate
- 基于 validation errors 自动 repair
- 返回 rounds 和 diagnostics
- 建立 generation / fix eval set
- 覆盖 Deployment + Service + Ingress 的多资源一致性

验收：

- 生成 YAML 可解析
- 生成 YAML 可通过 schema validation
- fix 能保留用户原始意图
- eval 能输出 parse success、validation pass、repair success、consistency pass、average rounds

## Stage 4：训练 grounded answer 与 judge 校准

目标：

**先校准 LLM-as-judge，再从 evidence-visible 到 citation-grounded。**

任务：

- 建立 judge calibration set
- 验证 judge 与人工判定的一致率
- source metadata 完整化
- 答案引用 source id
- claim-level verification
- Faithfulness eval 扩容
- 拒答策略显式化

验收：

- judge 错判样本有复盘
- 答案关键事实可追溯
- 文档没写的默认值不会被自由补全
- unsupported claim 能被发现并修正

## Stage 5：训练多知识源融合

目标：

**从 schema facts 到真实知识应用。**

任务：

- 接入官方 docs
- 接入 YAML examples
- 接入 policy 示例
- 建立 source precedence

验收：

- 能回答字段事实
- 能回答行为语义
- 能给出示例
- 能区分官方事实和组织建议

---

## 5. 当前评分：按训练完整度评估

| 训练维度 | 当前水平 | 评价 |
|---|---:|---|
| RAG 基础链路 | 7/10 | 已覆盖 ingestion、chunk、retrieval、rerank、generation |
| 上下文工程 | 6/10 | AskMode 和 EditorContext 已建立，但 trace 和历史上下文不足 |
| 检索工程 | 5/10 | dense + rerank 有雏形，hybrid 和持久化缺失 |
| 生成工程 | 4/10 | 已有 gen/fix 闭环雏形，但缺少独立 generation eval 和 diagnostics |
| 评估体系 | 5/10 | 指标意识正确，但样本小，大语料不可持续 |
| Grounding | 5/10 | 能展示 sources，但没有 claim-level citation |
| 大语料工程 | 4/10 | 已进入 8.9 万 chunk 规模，但索引和 eval 未跟上 |
| 反馈闭环 | 3/10 | 还没有 bad case 回灌机制 |
| K8s 场景真实性 | 8/10 | 场景真实、熟悉、可持续扩展 |

总体判断：

**这个项目已经足够作为 AI 应用开发训练场，但还没有完成 RAG 工程能力闭环。**

下一步最重要的不是追求“产品成熟”，而是按训练路线补齐：

1. 可评估
2. 可追踪
3. 可诊断
4. 可生成
5. 可迭代
6. 可证据化

---

## 6. 最终建议

保留这份报告，但不要把它当成产品成熟度评估。

它应该被当成：

**AI 应用开发能力训练地图。**

当前最该做的不是继续扩大 K8s 产品叙事，而是用这个项目把以下能力练出来：

```text
知识摄取
→ 结构化切片
→ 检索
→ 重排
→ 上下文工程
→ 证据化生成
→ 评估
→ trace
→ bad case 回灌
```

只要这条链路能被你讲清楚、跑稳定、用指标证明改动有效，这个项目就完成了当前阶段的核心意义。

---

## 7. 参考资料

本地资料：

- `docs/AI应用开发训练方案-K8s-YAML-Copilot.md`
- `docs/RAG-复盘-01-检索原理与工程难点.md`
- `docs/RAG-复盘-02-检索硬化与评估驱动.md`
- `docs/RAG-复盘-03-生成层评估与修尺子.md`
- `src/eval/retrieve-eval.ts`
- `src/eval/faithfulness-eval.ts`
- `src/server/pipeline.ts`
- `src/retrieval/retrieve.ts`
- `src/retrieval/rerank.ts`
- `src/knowledge/schema-corpus.ts`

外部通用实践参考：

- Ragas: <https://docs.ragas.io/>
- LangSmith RAG evaluation: <https://docs.langchain.com/langsmith/evaluate-rag-tutorial>
- LlamaIndex Faithfulness Evaluator: <https://developers.llamaindex.ai/python/examples/evaluation/faithfulness_eval/>
