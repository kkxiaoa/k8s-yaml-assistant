# AGENTS.md

## 项目方向

本项目当前不是以“做成完整 K8s AI 产品”为第一目标，而是：

**用 K8s 场景训练自己成为 AI 应用开发者。**

训练场景收敛为：

**K8s YAML Authoring Copilot**

当前价值主张：

**在编辑器里，基于当前 YAML 和集群 schema，提供带依据、可拒答、可校验的字段解释、错误解释、生成与修复辅助。**

不要把当前阶段定位成泛化的 Kubernetes AI 平台，也不要定位成通用 K8s 知识库聊天机器人。当前场景应围绕用户在编辑器里编写、理解、检查、修复和生成 Kubernetes YAML 展开。

## 当前不承诺

第一阶段不要承诺：

- 集群运行时排障
- 多集群治理
- 日志 / 事件分析
- 自动执行 `kubectl`
- 完整 Kubernetes 运维助手能力
- 覆盖所有 Kubernetes / CRD 资源的成熟产品体验

这些能力可以作为后续产品化方向，但不是当前训练项目的验收标准。

## 训练原则

1. 训练场必须锚定当前 YAML 编辑工作流。
2. 优先提供有依据的答案，而不是流畅但不可验证的回答。
3. schema 是字段事实层，不是完整知识库。
4. 不要靠手工维护资源覆盖；资源覆盖应通过 ingestion pipeline 扩展。
5. 不用“产品成熟”作为当前验收标准，而用可测、可追踪、可诊断、可迭代、可证据化作为验收标准。
6. 失败要显式表达：如果来源不足，要说明不足并展示已检索到的内容。
7. 先修尺子，再追求指标；先解释 bad case，再追求指标提升。
8. RAG 检索层和 Generate / Fix 生成层都必须可评估，不能只训练检索。

## 当前判断

当前项目适合作为 AI 应用开发训练场，而不是完整 K8s 知识产品。

已有优势：

- `ask / check / gen / fix` 已形成基础工作流闭环。
- schema 驱动的语料和校验复用同一份事实来源。
- 已有 RAG 检索评估和 faithfulness 评估。
- Monaco 编辑器集成让产品具备明确的工作流入口。
- Ask 已开始接入 editor context、sources、字段解释和错误解释。
- generated schema 已把语料推进到较大规模，适合后续训练 ingestion、索引和 eval 工程。

当前缺口：

- 语料规模与评估集代表性不匹配，不能用 13 条存储类题目代表约 88k chunks / 997 resources 的检索质量。
- 缺少可提交的 `baseline.json`、`eval:compare` 和 bad case 回灌机制。
- trace 还缺 latency、cache、token/cost、coarse/rerank/final hits 等诊断字段。
- Generate / Fix 生成层缺少独立 eval，特别是多资源一致性生成与修复评估。
- Hybrid retrieval 是否需要尚未由 bad case 证明，不能当成无条件必做项。
- LLM-as-judge 扩展前缺少 judge calibration，不能直接把裁判结果当真。
- 多知识源融合尚未开始，schema / docs / examples / policy 的边界还需要工程化。

## 当前执行优先级

后续实现按 `docs/AI应用开发能力训练实现方案.md` 执行，不再按旧产品 P0/P1/P2 扩张。

### 1. Stage 0：训练场 Scope 与评估代表性决策

默认先采用精选语料训练场，而不是一开始被全量大语料绑架。

要求：

- 明确 curated resource list。
- 写清 `88,879 chunks / 997 resources` 的统计口径。
- eval 采用人工核心集 + schema 派生集 + bad case 回灌集。
- 不用 13 条或 50 条手写同类问题代表全语料能力。

### 2. Stage 2：质量工程底座

优先补齐可测、可比、可诊断能力。

要求：

- 落地 `data/eval/baseline.json`。
- 落地 `data/eval/runs/*.json`。
- 落地 `data/eval/bad-cases.jsonl`。
- 新增 `npm run eval:compare`，输出当前指标、baseline 指标和 delta。
- trace 记录 coarse hits、rerank hits、final hits、latency、cache、token/cost。
- 大语料索引不要默认使用纯文本 JSONL 存全量 float；全量场景优先考虑 `Float32Array` binary、SQLite blob、Parquet、LanceDB、sqlite-vec 或真实向量库。

### 3. Stage 4：Generate / Fix 生成层

Generate / Fix 与 RAG 检索并列，是 AI 应用开发训练的另一半。

要求：

- 生成结果必须经过 YAML parse。
- 生成结果必须经过 schema validation。
- fix 必须形成 repair loop，而不是一次性文本改写。
- 多资源生成要评估跨资源一致性，例如 Deployment / Service / Ingress 的 label selector、port、service name、backend 引用。
- 需要独立 generation / fix eval，指标至少包含 parse success、validation pass、repair success、consistency pass。

### 4. Stage 3：条件触发 Hybrid Retrieval

Hybrid retrieval 不是无条件必做。

只有当 Stage 2 的 bad case 和 trace 证明 dense + rerank 存在关键词型失召回时，才引入 BM25 / sparse retrieval / RRF。

### 5. Stage 5：Grounded Answer 与 Judge 校准

在扩展 claim-level grounding 或 LLM-as-judge 前，先校准裁判。

要求：

- 准备 10-20 条人工标注样本。
- 对比 LLM judge 和人工判断。
- 明确误判类型后，再扩大 faithfulness / correctness / grounding eval。

### 6. Stage 6/7：多知识源融合与反馈闭环成熟化

只有当基础链路可测、可追踪、可比较后，再扩展多知识源和反馈闭环。

要求：

- schema / docs / examples / policy 必须有明确 sourceType 和 trustLevel。
- feedback 初期可先离线进入 `bad-cases.jsonl`。
- 不急于做线上产品化反馈系统。

## 工程规则

- **禁止玩具思维落盘（最高优先）**：落盘的内容必须是当前阶段的真实工程形态，不得为了快速跑通而沉淀简化、占位或硬编码版本——例如手写少字段 schema 覆盖真实 ingestion 产物、storage-only 的 fallback 资源集、`CORPUS.slice(0, N)` 截断语料、单资源特判。临时方案必须显式标注边界并征求用户同意，不能悄悄变成既成事实。核实到历史玩具残留（如 `FIXTURE_SCHEMA_DOCS` 覆盖层、`FALLBACK_RESOURCES` / `chunksForResource` 硬过滤、旧 `validateStorageClass` / `submit_storageclass` 注释）应一并清退，不得在其上继续叠加，避免影响后续落盘。
- 变更应贴合现有 TypeScript / Next.js / Monaco 结构。
- `ask / validate / generate / fix` 尽量复用 schema 派生数据。
- 检索、生成、拒答、修复都必须可评估；改 retrieval、prompt、generation 或 fix 行为时，要同步考虑 eval 和 baseline diff。
- 不要引入过宽抽象，除非它直接服务当前训练阶段。
- 方案落盘时优先采用业界通用、可维护的实现方式；如果只是临时方案、自研替代成熟方案，或预期收益不高，执行前应先说明取舍并征求用户意见。
- 保持 schema 事实、文档说明、示例模板、组织策略之间的边界。
- 来源不足时不要静默编造答案。
- 不要手动扩充大规模 schema import；资源覆盖应通过 ingestion pipeline 和 generated schema 目录完成。
- 当前阶段优先把问题变得可测、可诊断、可复现，再追求覆盖更多能力。

## 参考文档

当前训练方案：

`docs/AI应用开发训练方案-K8s-YAML-Copilot.md`

实现路线：

`docs/AI应用开发能力训练实现方案.md`

RAG 评估：

`docs/RAG能力训练评估报告.md`
