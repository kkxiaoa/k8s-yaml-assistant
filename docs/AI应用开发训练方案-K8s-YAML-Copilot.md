# AI 应用开发训练方案 · K8s YAML Copilot

> 新目标：**你不是在做 K8s AI 产品，你是在用 K8s 场景训练自己成为 AI 应用开发者。**  
> 本文不再以“能否做成完整 K8s AI 产品”为第一评价标准，而是定义一个真实、受控、可评估的 AI 应用训练场。

---

## 1. 核心结论

当前项目最重要的意义不是立刻做成一个成熟 K8s AI 产品，而是作为从传统 K8s 平台开发转向 AI 应用开发的训练项目。

更准确地说，当前项目应该被定义为：

**用 K8s YAML Authoring Copilot 这个真实场景，系统训练 AI 应用开发中的 RAG、上下文工程、证据化、评估、生成修复和反馈闭环能力。**

这个定位下，项目是否成功不再主要看：

- 是否能商业化
- 是否能打败 K8sGPT / Lens / Komodor
- 是否覆盖完整 Kubernetes 知识域
- 是否具备企业级平台能力

而是看：

- 是否能解释每一次答错是检索、切片、知识缺失、上下文、prompt 还是生成问题
- 是否能用 eval 证明每一次改动有效
- 是否能把 schema、docs、examples、policy 这类知识源纳入一条可控链路
- 是否能让回答有证据、有边界、可拒答、可追踪
- 是否能把传统平台开发经验迁移到 AI 应用工程能力

因此，当前最合理的执行主线是：

```text
学习 AI 应用开发
        ↓
选择 K8s YAML Copilot 作为真实训练场
        ↓
围绕 RAG / context / eval / grounding / generation / feedback 做能力训练
        ↓
产品化只作为约束真实度的手段，不作为当前唯一成功标准
```

---

## 2. 三层目标边界

## 2.1 第一目标：AI 应用开发能力迁移

这是当前阶段的主目标。

你已经具备 K8s 平台开发背景，但 AI 应用开发需要新增一套工程能力：

- 知识摄取与知识建模
- chunking 与 metadata 设计
- dense / sparse / hybrid retrieval
- rerank 与候选集治理
- prompt 与上下文工程
- grounded answer 与 citation
- RAG eval 与 LLM-as-judge
- bad case 分析与反馈回灌
- 成本、延迟、缓存、trace

当前项目的意义就是把这些能力放在一个你熟悉的 K8s 领域里练出来。

## 2.2 第二目标：真实训练场景

训练场景定义为：

**K8s YAML Authoring Copilot**

它服务的不是泛 Kubernetes 智能平台，而是一个更窄的真实场景：

- 解释当前 YAML
- 解释字段和校验错误
- 检查并修复 YAML
- 根据自然语言生成资源 YAML
- 给出答案依据

这个场景足够真实：

- 有真实 schema / OpenAPI / CRD
- 有真实编辑器上下文
- 有真实 YAML 错误
- 有真实生成和修复任务
- 有可构造的 eval set

这个场景也足够收敛：

- 不需要马上做运行时排障
- 不需要马上接多集群治理
- 不需要马上做日志 / 事件分析
- 不需要马上做自治执行

## 2.3 第三目标：产品化可能性

产品化是长期可能性，不是当前压力源。

当前可以参考真实产品，但不要被真实产品的完整能力牵着走。

市场产品的作用是：

- 提供能力参照
- 提供交互参照
- 提供可信度和工作流参照

不是要求当前项目立即达到：

- K8sGPT 的故障分析能力
- Lens 的完整 IDE 集成
- Komodor 的运行态诊断闭环
- Portainer 的治理和 guardrails

当前阶段只需要保证训练场不是玩具。

---

## 3. 当前项目作为训练场的价值

## 3.1 已经具备的训练价值

当前项目已经不是纯 demo，具备作为 AI 应用训练场的基础。

已有能力：

- `ask / check / gen / fix` 已形成基础闭环
- schema 同时服务问答、校验、生成修复，具备事实源一致性
- Monaco 编辑器提供真实工作流入口
- Ask 已接入 editor context、sources、字段解释、错误解释
- generated schema 已将语料推进到大规模资源覆盖
- 已有检索评估和 Faithfulness 评估意识

这些能力对应的 AI 应用训练点是：

| 当前能力                | 对应训练点               |
| ----------------------- | ------------------------ |
| schema ingestion        | 知识摄取与标准化         |
| schema corpus           | 结构化 chunking          |
| vector retrieval        | dense retrieval          |
| resource / path boost   | metadata-aware retrieval |
| Voyage rerank           | cross-encoder reranking  |
| sources 展示            | evidence-backed answer   |
| AskMode + EditorContext | 上下文工程               |
| check / fix / gen       | agentic generation loop  |
| eval / faithfulness     | RAG 质量评估             |

## 3.2 当前还缺的训练模块

从学习 AI 应用开发角度看，当前最重要的缺口不是“产品还不够大”，而是以下训练模块还没有闭环：

- 大语料索引持久化
- hybrid retrieval
- retrieval trace
- eval set 扩展和任务分桶
- score threshold 与拒答策略
- claim-level grounding
- bad case 归因和回灌
- docs / examples / policy 多知识层融合
- 线上反馈和观测

这些不是产品 KPI，而是 AI 应用开发者需要掌握的核心工程能力。

---

## 4. 当前不做什么

为了避免目标再次发散，当前阶段明确不做：

- 不做完整 K8s AI 平台
- 不做集群运行时排障
- 不做日志 / 事件 / Prometheus 分析
- 不做自动执行 `kubectl`
- 不做多集群治理
- 不做完整企业级权限模型
- 不以商业化产品成功作为当前验收标准

这些方向不是没价值，而是会让训练目标失焦。

当前要先把一个 AI 应用的核心链路练扎实。

---

## 5. 能力训练路线 Roadmap

## Stage 0：训练场 Scope 与评估代表性决策

目标：

**先决定语料范围和评估覆盖方式，避免让 ingestion 体量绑架训练路线。**

训练内容：

- 在“精选语料训练场”和“全量大语料规模化训练”之间显式决策
- 默认先选择精选语料训练场：核心 workload / service / ingress / config / rbac / storage + 少量真实 CRD
- 明确 `88,879 chunks / 997 resources` 的统计口径
- 不用 13 条或 50 条手写同类问题代表全语料能力
- eval 采用人工核心集 + schema 派生集 + bad case 回灌集
- 建立 `data/eval/baseline.json` 和 baseline diff

验收标准：

- 明确当前阶段采用精选语料，而不是全量 88k 语料
- 有 curated resource list
- 有 eval 覆盖策略
- 有 baseline 文件结构

## Stage 1：稳住真实场景与基础闭环

目标：

**把 K8s YAML Copilot 作为稳定训练场，而不是继续扩大产品叙事。**

训练内容：

- 明确 UI、README、AGENTS、文档都使用 YAML Copilot 口径
- 保持 `ask / check / gen / fix` 闭环
- Ask 默认带 editor context
- 每个回答展示 sources
- 快捷动作围绕当前字段、当前错误、当前 YAML

验收标准：

- 用户不需要把 YAML 复制进问题里
- “解释当前字段”能基于 cursorPath 命中 schema
- “解释当前错误”能基于 validation errors 回答
- 回答能展示来源片段

## Stage 2：质量工程底座

目标：

**训练 AI 应用开发中最核心的质量工程能力。**

训练内容：

- 持久化 embeddings / vector index
- 改造 eval，避免每次对 88,879 chunks 全量重算
- 增加 `eval:compare`，输出当前指标相对 baseline 的变化
- 增加 retrieval trace，记录 coarse hits、rerank hits、final hits
- trace 同时记录 latency、cache hit、token / cost
- 建立 `data/eval/bad-cases.jsonl`
- eval case 按字段解释、错误解释、生成、修复、拒答、CRD 分桶

验收标准：

- 能稳定跑完检索评估
- 能看到每个问题的 coarse hits、rerank hits、final hits
- 能看到每次评估相对 baseline 的指标变化
- 能看到每次请求的核心延迟和成本数据
- 能解释 bad case 是检索问题、切片问题、知识缺失还是生成问题

## Stage 3：条件触发 Hybrid Retrieval

目标：

**Hybrid 不是必做项，只有 Stage 2 的 trace 证明关键词类失召回时才上。**

训练内容：

- 从 bad case 中确认 dense + rerank 的失败类型
- 增加 BM25 / keyword index
- 用 RRF 或 weighted fusion 合并 dense / sparse
- coarse retrieval 扩到 top-50 / top-100
- rerank 只处理候选集
- 增加 score threshold
- 不同 AskMode 使用不同检索策略：
  - `explain_field`：exact path + schema 优先
  - `explain_error`：error message + schema + validation docs
  - `free`：hybrid + docs / examples / policy

验收标准：

- 至少 10 条关键词类 bad case 证明 dense-only 存在问题
- 字段名、apiVersion、错误文本、CRD 专有名词能被关键词检索兜底
- dense 与 sparse 各自命中的结果能在 trace 中看到
- 低相关结果能触发拒答或提示“资料不足”

## Stage 4：训练 YAML Generate / Fix

目标：

**先训练 YAML Generate / Fix 生成层，再训练答案证据化。**

训练内容：

- 将自然语言需求转成结构化生成请求
- 生成 YAML 后必须进入 parse / schema validate
- 基于 validation errors 自动 repair
- 记录生成轮次、失败阶段和 diagnostics
- 建立 generation / fix eval set
- 区分 parse success、validation pass、repair success、intent match
- 覆盖 Deployment + Service + Ingress 的多资源一致性生成
- 检查 label / selector / port / backend service name 的跨资源一致性

验收标准：

- 生成结果能被 YAML parser 解析
- 生成结果能通过 schema validation
- 修复不会丢失用户原始意图
- eval 能输出生成与修复质量指标
- 多资源生成能通过一致性检查

## Stage 5：训练 grounded answer 与证据化

目标：

**先校准 judge，再从“展示 sources”升级到“答案事实可被 sources 支撑”。**

训练内容：

- 建立 10-20 条人工标注的 judge calibration set
- 先验证 LLM-as-judge 和人工判定的一致率
- sources 增加 `sourceType`、`sourceUri`、`version`、`trustLevel`
- 答案使用引用编号
- 增加 claim-level grounding 检查
- Faithfulness 评估扩展到更多诱导问题
- 区分 Faithfulness、Correctness、Answer Relevance

验收标准：

- judge calibration set 有人工标注
- judge 错判样本有复盘
- 答案中的关键事实能对应来源
- 文档没写的默认值不被模型自由补全
- 拒答不是失败，而是可解释的质量行为

## Stage 6：训练多知识层融合

目标：

**从 schema facts 训练到真实知识应用。**

Stage 6 是必修能力，不是可选装饰。真实 AI 应用需要处理 schema、官方文档、示例和组织策略之间的冲突、优先级和证据边界；只是它不应该早于 Stage 0 / Stage 2 / Stage 4，否则会在评估尺子和生成闭环都不稳时继续扩大复杂度。

训练内容：

- 接入 Kubernetes 官方文档
- 接入高质量 YAML examples
- 接入组织策略 / 平台规范示例
- 建立 source precedence：
  - schema：字段事实
  - official docs：行为语义
  - examples：落地写法
  - policy：组织约束

验收标准：

- 系统能回答“字段是什么”
- 系统能回答“为什么这么配”
- 系统能回答“示例怎么写”
- 系统能区分官方事实和组织建议

## Stage 7：训练反馈闭环

目标：

**让 AI 应用从一次性实现变成持续迭代系统。**

训练内容：

- Stage 2 已经有离线 `bad-cases.jsonl`
- Stage 7 将离线反馈升级为产品化反馈
- query log
- source hit log
- answer log
- 用户反馈
- bad case 分类
- 失败样本回灌 eval set

验收标准：

- 每个线上失败都能归因
- 高频失败能进入 eval
- 改动前后能用指标比较

---

## 6. 产品化如何看待

产品化不是当前第一目标，但真实产品约束仍有价值。

建议使用如下判断：

| 问题                       | 当前答案                       |
| -------------------------- | ------------------------------ |
| 要不要做真实用户场景？     | 要，否则学不到真实 AI 应用问题 |
| 要不要马上追求商业化？     | 不要                           |
| 要不要对标市场产品？       | 要，但只作为参考               |
| 要不要做完整 K8s AI 平台？ | 当前不要                       |
| 要不要持续保留产品意识？   | 要，用来约束训练场不要变玩具   |

更简洁地说：

**产品意识用于保证训练真实性，产品成功不是当前验收标准。**

---

## 7. 最终建议

当前项目应该从旧产品化口径切换为“AI 应用开发训练路线”。

最重要的不是证明它能不能成为一个 K8s AI 产品，而是通过它把下面这条链路练出来：

```text
ingestion
→ chunking
→ retrieval
→ rerank
→ context engineering
→ grounded generation
→ eval
→ trace
→ feedback
→ iteration
```

只要能做到：

- 每次答错都能定位原因
- 每次优化都能用 eval 验证
- 每次知识扩展都能进入统一检索和证据链
- 每次产品约束都能转化为 AI 应用工程能力

这个项目就达到了当前阶段的真正目标。

你不是在做 K8s AI 产品。

你是在用 K8s 场景训练自己成为 AI 应用开发者。

---

## 8. 参考文档

- `docs/RAG能力训练评估报告.md`
- `docs/RAG-复盘-01-检索原理与工程难点.md`
- `docs/RAG-复盘-02-检索硬化与评估驱动.md`
- `docs/RAG-复盘-03-生成层评估与修尺子.md`
- Ragas: https://docs.ragas.io/
- LangSmith RAG evaluation: https://docs.langchain.com/langsmith/evaluate-rag-tutorial
