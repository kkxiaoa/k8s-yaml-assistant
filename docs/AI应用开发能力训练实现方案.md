# AI 应用开发能力训练实现方案

> 目标：把 `k8s-yaml-assistant` 作为 K8s YAML Copilot 训练场，按阶段训练 AI 应用开发能力。  
> 原则：不以“做成完整 K8s AI 产品”为当前验收标准，而以“可测、可追踪、可诊断、可迭代、可证据化”为训练目标。  
> 价值主张：**在编辑器里，基于当前 YAML 和集群 schema，提供带依据、可拒答、可校验的字段解释、错误解释、生成与修复辅助。**

---

## 1. 总体实施原则

本方案不是产品发布计划，而是能力训练落地计划。

每个阶段都必须产出三类结果：

- **代码能力**：项目中新增或改造的真实工程能力。
- **评估能力**：能证明该阶段能力有效的 eval、trace、baseline 或测试。
- **复盘材料**：能解释为什么这么做、怎么判断好坏、还有什么不足。

阶段推进规则：

- 先让系统可测，再继续加功能。
- 先修尺子，再追求指标。
- 先能解释 bad case，再追求指标提升。
- 先在 K8s YAML Copilot 场景内做深，不扩到泛 K8s AI 平台。
- 新增方案优先采用业界通用实现；如果使用临时方案，需要明确收益和边界。

---

## 2. Stage 0：训练场 Scope 与评估代表性决策

## 2.1 目标

先决定训练场语料范围和 eval 覆盖策略，避免让 ingestion 体量反过来绑架训练路线。

当前硬伤：

- 当前语料约 `88,879 chunks / 997 resources`。
- 当前检索 eval set 只有 13 条，且主要是 PVC / StorageClass 等存储类问题。
- 即使 eval 能跑完，13 条手写存储题也不能代表 997 个资源的检索质量。

这不是性能问题，而是测量有效性问题。

## 2.2 必须显式选择的路线

### 路线 A：精选语料训练场（推荐先做）

目标：

- 用约 20-40 个与 YAML Copilot 强相关的核心资源 kind 打磨完整 AI 应用链路。
- 保证 eval 能测准、跑得动、能解释。

建议范围：

- 核心 workload：Pod、Deployment、StatefulSet、DaemonSet、Job、CronJob、HorizontalPodAutoscaler、PodDisruptionBudget。
- 暴露与网络：Service、Ingress、NetworkPolicy、Endpoints。
- 配置与权限：ConfigMap、Secret、ServiceAccount、Role、RoleBinding、ClusterRole、ClusterRoleBinding。
- 资源治理：ResourceQuota、LimitRange。
- 存储：PVC、PV、StorageClass。
- 选择 3-5 个真实 CRD 作为 CRD 训练样本。

落地机制（list 怎么生效）：

- 把选中的资源写进 `data/schemas/curated.json` 白名单。
- `schemas.ts` / `schema-corpus.ts` 仅加载白名单内资源构建 `CORPUS`，而不是全量遍历 `data/schemas/generated/*`。
- 全量 `generated/*` 仍保留在仓库，路线 B 或后续扩展时直接切换数据源即可，无需重新 ingestion。

清退玩具残留（与本 Stage 一并做，禁止玩具思维落盘）：

- **删除 `FIXTURE_SCHEMA_DOCS` 覆盖层**（`schemas.ts` 中 `storageclass / pvc / pv / vsc / vac` 5 个顶层手写 schema 的 import 与覆盖逻辑）。核实结论：这 5 个是玩具时代产物，字段数已**低于** generated（如 PVC fixture 仅 8 个 description vs generated 77 个），当前覆盖逻辑反而把丰富 generated 盖成低质，必须退场。
- 删除后这 5 个资源**统一从 `generated/*` 流出**，和其它 curated 资源同款，消除“5 个特例”的突兀与质量不一致。
- **`VolumeAttributesClass` 无 generated 来源**，走 ingestion pipeline 正常生成进 `generated/`，不保留孤立手写文件。生成前它是唯一容忍的临时特例，必须显式标注。
- 删 fixture 必须与 §2.3 重建 eval set **同步**：旧 13 条用例的 `expectedChunkIds` 源自 fixture 切片，换 generated 后 chunk id 会变，否则 eval 失配。
- 同时清理 `src/cli/gen.ts` 顶部 `submit_storageclass` / `validateStorageClass` 旧注释等单资源时代遗留口径。

适合训练：

- RAG 可测性
- trace
- generation / fix eval
- bad case 回灌
- grounded answer

### 路线 B：全量大语料规模化压测（后期里程碑，不是路线 A 的替代）

> 路线 A 与路线 B **不是二选一，而是有优先级的先后**：A 打底、B 压测。
> A 先把整条训练链路（检索统一、baseline、compare、trace）在可控语料上跑稳、测准；
> B 是后期一次**明确的 scale-up 动作**——把语料放回全量，专门压测路由 / scope / rerank 在大语料下的退化与成本。
> 因为那时已有 baseline 与 `eval:compare`，B 的退化/收益是**可测**的，而不是一上来就在 88k 上瞎调。

目标：

- 专门训练大规模检索工程，量化大语料下的召回退化、延迟与成本。

前置条件（必须先在路线 A 上完成，才进入 B）：

- 统一的 eval == serving 检索路径（§4.1）。
- 持久化索引（§4.3）+ baseline / `eval:compare`（§4.2）。
- 半自动 eval 生成、分层采样、覆盖率统计。
- 成本和延迟观测（§4.4 trace）。

不把路线 B 作为主线起步，否则会出现“大语料很多，但尺子测不准”的问题。全量 `generated/*` 始终保留在仓库，进入 B 时直接切换数据源即可，无需重新 ingestion。

## 2.3 Eval 代表性策略

Stage 0 要明确 eval 不是简单“手写 50 条”。

推荐组合：

- **人工核心集**：覆盖真实 YAML Copilot 高频任务，数量 50-100 条。
- **半自动 schema 派生集**：从 schema field description 反向生成 question，覆盖更多资源和字段。
- **bad case 回灌集**：从实际失败样本转入 eval。

每条 eval case 至少标记：

```ts
interface EvalCase {
  id: string;
  taskType: 'explain_field' | 'explain_error' | 'ask_free' | 'refusal' | 'crd';
  resource?: string;
  apiVersion?: string;
  path?: string;
  question?: string;
  context?: EditorContext;
  expectedChunkIds?: string[];
  answerable: boolean;
  source: 'human' | 'schema_generated' | 'bad_case';
}
```

> 注意：`EvalCase` 只覆盖**检索与解释类**任务(其评估单位是"检索是否命中正确 chunk")。
> **生成与修复类**用例不走 `EvalCase`,使用 Stage 4 的 `GenerationEvalCase`(评估单位完全不同:parse / validate / 跨资源一致性,字段是 `requirement / expectedKinds / mustHavePaths`)。
> 两类 case 分文件存放,不要混在一个结构里。

## 2.4 语料统计口径

文档中所有语料规模数字必须可复现。

当前 `88,879 chunks / 997 resources` 的含义：

- `chunks`：运行时 `CORPUS.length`。
- `resources`：`CORPUS` 中 unique `resource` 数量。
- 它不等于 `data/schemas/generated` 文件数，因为 generated 文件可能包含 `*List` 变体、不同 group/version 或被 fixture 覆盖。

验收时应提供统计命令或脚本，例如：

```bash
npm run corpus:stats
```

## 2.5 验收标准

- 默认先落地路线 A（路线 B 标为后期规模化压测里程碑，不删、不并行起步）。
- 产出 `data/schemas/curated.json` 白名单，并让 `schemas.ts` / `schema-corpus.ts` 仅加载白名单内资源(`CORPUS` 随之收敛)。
- 文档写明语料统计口径（`npm run corpus:stats` 可复现）。
- 至少建立 `data/eval/baseline.json` 的字段结构。

---

## 3. Stage 1：稳住真实场景与基础闭环

## 3.1 目标

把 K8s YAML Copilot 固定为稳定训练场，确保 `ask / check / gen / fix` 形成真实闭环。

## 3.2 实现内容

- README、AGENTS、CLAUDE、docs 统一使用“AI 应用开发训练 + K8s YAML Copilot 训练场”口径。
- 避免继续使用“完整 K8s AI 平台”“泛 Kubernetes 智能助手”“懂集群所有资源/CRD”作为当前主目标。
- Ask 请求必须包含 `EditorContext`。
- Ask 动作显式区分 `free`、`explain_field`、`explain_error`。
- `/api/ask` 通过 SSE 返回 `sources`、`delta`、`done`。
- 前端展示 answer 与 sources。
- 保持 `check / gen / fix` 基础闭环，生成和修复结果必须再次进入校验。

## 3.3 验收标准

- 用户不需要复制 YAML 到问题里。
- “解释当前字段”能基于 `cursorPath` 命中 schema。
- “解释当前错误”能基于 validation errors 回答。
- 每个可答问题至少展示 1 个 source。
- `README / AGENTS / CLAUDE / docs` 不再出现与新目标冲突的旧口径。

---

## 4. Stage 2：质量工程底座

## 4.1 目标

建立 AI 应用训练项目的质量工程底座：baseline、eval compare、trace、成本延迟、轻量反馈闭环。

Stage 2 不只是“让 eval 跑完”，而是让每次改动都能被比较、诊断和复盘。

> **前置（本 Stage 最高优先）：检索路径统一（eval == serving），且必须在持久化索引之前完成。**
>
> 问题：当前 `eval.ts` 在**全量 `CORPUS`** 上软加权排序（路由只加分、不删候选），而线上 `pipeline.ts` 走 `chunksForResource` **硬过滤到单资源子集**再建索引（路由错=候选池里没有正确 chunk=Recall 0）——这是两套不同的检索算法，eval 数字不代表线上行为。
>
> **收敛目标（不可选）**：eval 与 serving 共用**同一段 `retrieve / boost / rerank` 代码**和**同一份 index**。否则 baseline 和 trace 测的是一个线上没人用的系统，后续一切对比都失去意义。
>
> **采用行为：取向 A —— 全量软加权（线上向 eval 看齐）**。即去掉 `pipeline.ts` 的 `chunksForResource` 硬过滤分支，路由结果改为喂给软加权（`命中资源 ? +RESOURCE_BOOST : 0`）。理由：
> 1. 硬过滤本是 88k 大语料下的性能 hack；路线 A 收敛到 ~20-40 kind 后，全量软加权已足够便宜，hack 失去必要性。
> 2. 硬过滤违背设计支柱③“**不赌完美路由**，误路由也不丢答案”；软加权与之一致。
> 3. 收敛成本最低：eval 现状即全量软加权，让线上向它看齐只改一处。
> 路由误差仍会以“少加分→掉排名”反映到 Recall@k / MRR，无需靠硬过滤“暴露”。
>
> 落地：抽一个共享 `retrieve(query, { softBoostResource })`，CLI / Web / eval 全部走它；硬过滤 / hybrid 留到路线 B 规模化压测时作为大语料优化的候选，届时用 baseline + `eval:compare` 量化其召回损失与成本收益。

## 4.2 Baseline 与对比

必须产出：

```text
data/eval/
  baseline.json
  runs/
    2026-xx-xx-xxxx.json
  bad-cases.jsonl
```

`baseline.json` 建议结构：

```ts
interface EvalBaseline {
  id: string;
  createdAt: string;
  corpusHash: string;
  indexHash: string;
  embeddingModel: string;
  answerModel: string;
  rerankModel?: string;
  metrics: Record<string, number>;
}
```

新增命令：

```bash
npm run eval:compare
```

输出至少包含：

- 当前指标
- baseline 指标
- Δ Recall@k
- Δ MRR
- Δ Faithfulness
- Δ parse success
- Δ validation pass
- Δ repair success

初期可以只提示退化，不一定阻塞 CI；但必须能看到 diff。

`metrics` 是**跨 Stage 并集**：Stage 2 只有检索类指标（Recall@k / MRR），Stage 4 起才会有 parse / validation / repair / consistency。`eval:compare` 只 diff baseline 与当前 run **都存在**的 key，缺失的指标跳过，不报错。

`corpusHash` / `indexHash` 的定义（保证可复现）：

- `corpusHash`：对 `CORPUS` 按 `id` 排序后拼接 `id + '\n' + text`，取 sha256。
- `indexHash`：`corpusHash + embeddingModel + 索引参数`（如归一化方式）取 sha256；embedding 模型或语料任一变化都会让 hash 变化，从而提示需要重建索引。

**baseline 晋升工作流**（一次 run 怎么变成新 baseline）：

```bash
npm run eval            # 跑评估,结果写入 data/eval/runs/<时间戳>.json
npm run eval:compare    # 与 baseline.json 对比,打印 Δ
npm run eval:promote -- data/eval/runs/<时间戳>.json   # 确认是正收益后,显式晋升为新 baseline
```

晋升必须是**显式动作**，不允许 `eval` 自动覆盖 baseline，避免"把退化当成新基线"。

## 4.3 持久化索引

> **前置顺序（不可提前）**：持久化必须在 Stage 0（语料收敛到 `curated.json`）**且** §4.1（检索路径合一为单一共享 `retrieve` + 单一索引）之后做。
> 否则会把错误的东西烤进磁盘：要么持久化又大又无代表性的 88k 索引，要么持久化两条分裂路径产出的两份不一致索引。
> 依赖链：`Stage 0 收敛语料 → §4.1 合并检索路径 → 持久化（本节）→ baseline / compare / promote / trace`。
> 这一步做完才真正解决“eval 每次重嵌全量 CORPUS 跑不完”的根因（见 §4.2 的 `corpusHash` / `indexHash` 失效判定）。

新增本地索引构建命令：

```bash
npm run index:build
```

索引格式不要默认使用纯文本 `embeddings.jsonl` 承载全量 88k × 1024 float。

推荐策略：

- 精选语料训练场：可以先使用 JSONL prototype。
- 全量大语料：优先使用 `Float32Array` binary、SQLite blob、Parquet、LanceDB、sqlite-vec 或真实向量库。

建议目录：

```text
data/index/
  manifest.json
  chunks.jsonl
  embeddings.f32
```

## 4.4 Retrieval Trace

Trace 必须同时记录质量、延迟和成本。

```ts
interface RetrievalTrace {
  question: string;
  mode: AskMode;
  resourceHint?: string;
  fieldPathHint?: string;
  queryText: string;
  coarseHits: TraceHit[];
  rerankHits: TraceHit[];
  finalHits: TraceHit[];
  latencyMs: {
    embed?: number;
    dense?: number;
    sparse?: number;
    rerank?: number;
    llm?: number;
    total: number;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  };
  cache?: {
    embeddingHit?: boolean;
    indexHit?: boolean;
  };
}
```

## 4.5 轻量反馈闭环前置

反馈闭环不是最后才开始，而是最后成熟。

Stage 2 必须先建立离线版：

```text
data/eval/bad-cases.jsonl
```

Bad case 结构不要只存 `question + wrongAnswer`，否则无法归因，也无法回灌 eval。

建议使用一个跨任务的 superset 结构：Stage 2 先填写检索/解释类字段，Stage 4 再补生成/修复类字段。不要为 RAG、generate、fix 各自设计完全不同的 bad case 格式，否则后续无法统一做分类、统计和回灌。

```ts
interface BadCase {
  id: string;
  createdAt: string;

  taskType: 'explain_field' | 'explain_error' | 'ask_free' | 'generate' | 'fix' | 'refusal';

  input: {
    question?: string;
    requirement?: string;
    yaml?: string;
    context?: {
      kind?: string;
      apiVersion?: string;
      cursorPath?: string;
      selectedText?: string;
      validationErrors?: Array<{ path: string; message: string }>;
    };
  };

  expected?: {
    answerSummary?: string;
    sourceIds?: string[];
    expectedKinds?: string[];
    mustHavePaths?: string[];
    consistencyChecks?: Array<'selector_label_match' | 'service_target_port_match' | 'ingress_service_match'>;
  };

  actual: {
    answer?: string;
    yaml?: string;
    sourceIds?: string[];
    traceId?: string;
    diagnostics?: Array<{ stage: string; message: string }>;
  };

  failure: {
    layer:
      | 'retrieval'
      | 'rerank'
      | 'chunking'
      | 'knowledge'
      | 'context'
      | 'prompt'
      | 'generation'
      | 'validation'
      | 'judge'
      | 'ui'
      | 'unknown';
    type:
      | 'retrieval_miss'
      | 'rerank_error'
      | 'chunk_gap'
      | 'knowledge_missing'
      | 'context_missing'
      | 'prompt_error'
      | 'hallucination'
      | 'schema_gap'
      | 'parse_error'
      | 'validation_error'
      | 'consistency_error'
      | 'refusal_error'
      | 'judge_error'
      | 'ui_misleading'
      | 'unknown';
    note?: string;
  };

  severity: 'low' | 'medium' | 'high';
  status: 'new' | 'triaged' | 'converted_to_eval' | 'fixed' | 'wont_fix';
  convertedEvalId?: string;
}
```

字段设计理由：

- `taskType`：区分解释、拒答、生成、修复，因为评估标准不同。
- `input`：保留当时的问题、YAML 和编辑器上下文，保证失败可复现。
- `expected`：描述正确行为，后续才能转成 eval case。
- `actual`：保留当时回答、YAML、sources 和 trace 入口，方便复盘。
- `failure.layer`：判断应该改哪一层。
- `failure.type`：沉淀更细的错误类型，用于统计是否需要引入 Hybrid、改 prompt、补知识源或修生成闭环。
- `status`：确保 bad case 有闭环，不只是失败日志。

Stage 2 的最小可填版本：

```ts
{
  id,
  createdAt,
  taskType,
  input: { question, yaml, context },
  expected: { answerSummary, sourceIds },
  actual: { answer, sourceIds, traceId },
  failure: { layer, type },
  severity,
  status
}
```

Stage 4 才需要补齐 `requirement`、`expectedKinds`、`mustHavePaths`、`consistencyChecks`、`diagnostics` 等生成/修复字段。

## 4.6 验收标准

- **eval 与线上 `pipeline` 走同一检索入口、同一份索引**（不再是"全量软加权 vs 硬过滤子集"两套逻辑）。
- 采用路线 A 时，精选语料 eval 能稳定跑完。
- 不重新 embedding 全量 corpus 也能跑 eval。
- `eval:compare` 能输出 baseline diff，`eval:promote` 能显式晋升基线。
- 每次 eval 能输出 baseline diff。
- 每条 eval case 能输出 trace。
- trace 包含 latency 和可获得的 token / cost 信息。
- 至少 5 条 bad case 完成归因。

---

## 5. Stage 3：条件触发的 Hybrid Retrieval

## 5.1 目标

Hybrid 不是无条件必做项，而是由 Stage 2 的 trace 和 bad case 触发的工程解法。

只有确认 dense + rerank 在以下场景失败时，才进入本阶段：

- 字段名失召回
- apiVersion / kind 失召回
- validation error 文本失召回
- CRD 专有名词失召回
- enum value 精确匹配失败

## 5.2 实现内容

- 增加 BM25 / sparse index。
- 使用 RRF 合并 dense / sparse。
- 在 trace 中同时展示 dense hits、sparse hits、fused hits、rerank hits。
- 对比 dense-only 与 hybrid 的指标。

## 5.3 验收标准

- 至少 10 条关键词类 bad case 证明 dense-only 存在问题。
- Hybrid 后这些 bad case 的 Recall/MRR 或命中排序改善。
- 如果没有改善，Hybrid 不应继续扩大实现范围。

---

## 6. Stage 4：Generate / Fix 生成层

## 6.1 目标

系统训练 AI 应用中的生成层能力：把自然语言需求、当前 YAML、校验错误和知识检索结果转化为可校验、可修复、可解释的 Kubernetes YAML。

生成层是与 RAG 检索问答并列的能力线，不是 RAG 的附属功能。

## 6.2 实现内容

### 结构化请求与输出

```ts
interface GenerateRequest {
  requirement: string;
  target?: {
    kind?: string;
    apiVersion?: string;
  };
  context?: {
    currentYaml?: string;
    selectedText?: string;
    validationErrors?: Array<{ path: string; message: string }>;
  };
}

interface GenerateResult {
  yaml: string | null;
  rounds: number;
  diagnostics: Array<{
    stage: 'generate' | 'parse' | 'validate' | 'repair';
    message: string;
  }>;
}
```

### 校验闭环

```text
generate YAML
  ↓
parse YAML
  ↓
schema validate
  ↓
if invalid: repair with validation errors
  ↓
validate again
  ↓
return final YAML + diagnostics
```

边界：

- 最大修复轮次默认为 2。
- 如果仍失败，返回失败原因，不伪装成功。
- 修复 prompt 必须包含具体 validation errors。
- 修复结果必须再次校验。

### 多资源一致性生成

必须覆盖 K8s YAML Copilot 的核心生成难点：

- Deployment + Service
- Deployment + Service + Ingress
- labels / selector 一致
- containerPort / targetPort / service port 一致
- serviceName / backend service name 一致
- 多资源 YAML 文档分隔符正确

### Generation / Fix Eval

新增 eval case：

```ts
interface GenerationEvalCase {
  id: string;
  requirement: string;
  expectedKinds: string[];
  mustHavePaths: string[];
  consistencyChecks?: Array<'selector_label_match' | 'service_target_port_match' | 'ingress_service_match'>;
}
```

指标：

- YAML parse success rate
- schema validation pass rate
- expected kind/apiVersion match rate
- required paths coverage
- multi-resource consistency pass rate
- repair success rate
- average rounds

## 6.3 验收标准

- 至少 20 条 generation / fix eval case 可稳定运行。
- 包含至少 5 条多资源一致性生成用例。
- 生成结果能通过 YAML parse 和 schema validation。
- fix 尽量保留用户原始意图和已有字段。
- eval 能输出 parse success、validation pass、repair success、consistency pass、average rounds。

---

## 7. Stage 5：Grounded Answer 与 Judge 校准

## 7.1 目标

从 evidence-visible 升级到 citation-grounded，同时避免重复复盘-03 的错误：在使用 LLM-as-judge 前先校准裁判。

## 7.2 Judge 校准

先建立 judge calibration set：

- 10-20 条人工判定样本。
- 覆盖 faithful、hallucinated、correct refusal、unsupported default、示例值灰区。
- 记录人工判定与 judge 判定的一致率。

只有裁判达到可接受一致率后，才扩大 claim-level grounding eval。

## 7.3 Claim-level Grounding

- sources 增加 `sourceType`、`sourceUri`、`version`、`trustLevel`。
- 答案使用 `[S1] [S2]` 引用来源。
- eval 中执行 claim extraction 和 claim-source verification。
- unsupported claim 必须能被报告。

## 7.4 验收标准

- judge calibration set 有人工标注。
- judge 与人工判定不一致的样本有复盘。
- 答案关键事实带 source 引用。
- Faithfulness eval 能识别 unsupported claim。
- 文档没写的默认值不会被自由补全。

---

## 8. Stage 6：多知识源融合

## 8.1 目标

从 schema facts 扩展到更真实的 AI 应用知识层。

Stage 6 是 AI 应用开发训练里的必修能力，因为真实 RAG 不可能长期只依赖 schema。它不是可有可无的产品增强，但执行上应排在 Scope、baseline、trace、Generate / Fix 和 judge 校准之后，避免在尺子不准时继续扩大知识源。

## 8.2 知识源

- `schema`：字段事实、类型、枚举、required。
- `doc`：官方文档、概念、行为语义。
- `example`：YAML 示例、模板、反例。
- `policy`：组织规范、平台推荐、禁用项。

## 8.3 Source Precedence

建议优先级：

```text
policy > schema > official docs > examples
```

## 8.4 验收标准

- 能回答字段事实。
- 能回答行为语义。
- 能给出 YAML 示例。
- 能区分官方事实和组织建议。

---

## 9. Stage 7：反馈闭环成熟化

## 9.1 目标

把 Stage 2 的离线 bad case 机制升级为持续反馈系统。

## 9.2 实现内容

- query log
- source hit log
- answer log
- latency / cost log
- UI feedback
- fix / generate 采纳记录
- bad case taxonomy
- eval additions

## 9.3 验收标准

- 至少沉淀 20 条 bad case。
- 每条 bad case 有分类和处理结论。
- 至少 10 条 bad case 回灌到 eval set。
- 改动前后能生成对比报告。

---

## 10. 推荐执行顺序

> Stage 编号是**主题分类，不代表时序**。实际执行顺序如下（Stage 1 作为贯穿约束，不单独排期）。

当前推荐顺序：

1. **Stage 0：Scope 与 eval 代表性决策**
   - 默认先采用路线 A：精选语料训练场。

2. **Stage 2：质量工程底座**
   - baseline、eval compare、trace、latency/cost、bad-cases。

3. **Stage 4：Generate / Fix 生成层**
   - 这是与 RAG 并列的能力线，应尽早补齐。

4. **Stage 3：条件触发 Hybrid**
   - 仅在 bad case 证明关键词失召回后实施。

5. **Stage 5：Grounded Answer 与 Judge 校准**
   - 先校准裁判，再扩大 LLM-as-judge。

6. **Stage 6：多知识源融合**
   - 在基础可测可诊断后再扩。

7. **Stage 7：反馈闭环成熟化**
   - Stage 2 已有离线反馈，Stage 7 做产品化增强。

Stage 1 作为持续约束，保持文档、UI、README、AGENTS、CLAUDE 口径一致。

---

## 11. 当前下一步任务清单

下一轮优先做 Stage 0 + Stage 2 的最小闭环。

最小任务：

- **统一 eval 与 serving 的检索路径（前置，先做）**：删 `pipeline.ts` 的 `chunksForResource` / `FALLBACK_RESOURCES` / `CORPUS.slice(0, 1000)` 硬过滤与玩具 fallback，收敛为单一软加权 `retrieve`。
- **清退玩具 fixture**：删 `schemas.ts` 的 `FIXTURE_SCHEMA_DOCS` 覆盖层，5 个存储资源改从 generated 流出，VAC 走 ingestion 补进 generated（与 eval set 重建同步）。
- 明确采用精选语料训练场，写出 `data/schemas/curated.json` 白名单并让 `CORPUS` 据此收敛。
- 增加 `npm run corpus:stats`，说明 chunk/resource 统计口径。
- 建立 `data/eval/baseline.json` 与 `data/eval/bad-cases.jsonl`。
- 新增 `npm run eval:compare` 与 `npm run eval:promote`。
- retrieval trace 增加 latency / cache / cost 字段。
- 先扩充 eval set 到代表性核心集，而不是只手写 50 条同类问题。

最小验收：

- eval 与线上检索走同一入口与索引。
- eval 能和 baseline 输出差异，且基线晋升是显式动作。
- 每条 eval case 有 trace，trace 有耗时数据。
- 至少 5 条 bad case 能归因。
- 文档说明为什么当前选择精选语料，而不是全量 88k 语料。

---

## 12. 成功标准

这个训练项目的阶段性成功标准不是“产品成熟”，而是：

- 你能讲清楚一条 RAG 请求从知识源到答案的完整链路。
- 你能定位一次错误回答发生在哪一层。
- 你能设计 eval case 证明改动有效。
- 你能解释为什么某个问题应该拒答。
- 你能解释为什么一段 YAML 生成失败，以及失败发生在需求理解、YAML 结构、schema 校验还是修复闭环。
- 你能用 baseline diff 证明一次改动是正收益还是负收益。
- 你能让系统从 bad case 中持续变好。

达到这些标准，就说明这个项目完成了当前阶段的核心使命：

**用 K8s 场景训练自己成为 AI 应用开发者。**
