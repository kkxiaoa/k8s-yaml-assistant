# Eval Harness 与多源前置工程质量重构设计

> 状态：已完成第一轮结构重构，correctness review 未通过，不再作为当前纠偏实现依据。
> 用途：保留 Task 1-8 的原始设计记录；当前约束由 2026-07-12 的四份 corrective spec 定义。

当前 corrective specs：

- `2026-07-12-eval-artifact-protocol-design.md`
- `2026-07-12-eval-metric-semantics-design.md`
- `2026-07-12-evaluator-validity-design.md`
- `2026-07-12-knowledge-provenance-corpus-identity-design.md`

## 1. 背景

当前项目已经完成了 Stage 6 policy source、query expansion serving 接入、faithfulness bad-case 回灌和 canonical bad-case 简化。下一步原计划继续推进 Stage 7 反馈闭环、docs/examples ingestion 和 claim-level grounding。

但从工程质量角度看，当前 eval / trace / bad-case / source model 还有一些结构性瑕疵。如果不先收敛，后续每新增一个知识源或评估类型，都会继续复制特殊路径，导致代码越来越难读，指标也越来越难归因。

本设计的目标不是提升某个指标，而是把质量工程底座重构到能支撑后续阶段：

- retrieval / faith / judge / generation / fix 都能沉淀标准 run artifact。
- trace 与 run 有明确归属，不再混入无关请求。
- bad case 只表达长期问题台账，不承担临时 trace 或兼容历史结构。
- source/chunk 模型能承接 docs/examples，而不是继续被 schema/policy 绑死。
- serving 与 eval 尽量共用同一条 pipeline，避免“线下测的是 A，线上跑的是 B”。

## 2. 本轮范围

### 2.1 包含

- EvalRun 类型扩展与 run artifact 规范化。
- retrieval trace 从全局 `traces.jsonl` 收敛为 run-scoped artifact。
- serving trace 与 eval run trace 分流，保留 serving 观测能力但不污染 eval run。
- retrieval bad case 记录真实 run 观测来源。
- faith bad-case converter 改为优先读取 run metadata 指向的 artifact。
- judge eval、generation eval、fix eval 产出标准 run artifact。
- source/chunk 类型为 docs/examples 预留真实结构边界。
- answer prompt/source policy 从散落字符串收敛为共享构造入口。
- 测试脚本、命令入口、历史 scripts 和依赖风险做工程化收敛。
- docs 目录建立状态分层、索引和清理规则，避免历史迭代文档继续充当当前事实来源。

### 2.2 不包含

- 不直接修复 rerank_miss 排序策略。
- 不新增 docs/examples ingestion。
- 不新增 claim-level grounding。
- 不新增线上 feedback UI 或数据库。
- 不自动删除历史 run/trace 文件。
- 不自动晋升 baseline。
- 不修改模型 provider 或大规模依赖升级策略，除非单独 review。

## 3. 当前瑕疵清单

### 3.1 P0：证据链问题

1. `data/eval/traces.jsonl` 是全局追加文件，不属于任何 run。不同时间、不同入口、不同配置的 trace 会混在一起，后续很难判断某条 trace 支撑的是哪个指标。
2. `retrieveContext()` 当前总是调用 `appendTrace()`，正常 Ask serving 请求和 retrieval eval 会写入同一个全局 trace 文件。问题不在注释是否正确，而在 serving 观测和 eval run 证据共用一个 sink，导致归因污染。
3. `EvalKind` 目前只有 `retrieval | faith`，而项目已经有 `eval:judge`、`eval:gen`、`eval:fix`。这些 eval 只打印结果，不能比较、不能晋升 baseline、不能形成长期证据。
4. retrieval bad case 虽然已经 canonical 化，但 `retrievalMiss()` 仍缺少 run 观测链路。`tracking.observedRunIds` 无法稳定表达“这个问题在哪些 run 中复现过”。
5. faith bad-case converter 依赖 `data/eval/faith/<runId>.jsonl` 与 `runs/<runId>.json` 的路径约定。随着 run-scoped trace 引入，artifact 归属应由 run metadata 显式声明。

### 3.2 P1：后续多源会放大的设计问题

1. `SourceType` 只有 `schema | policy`，`TrustLevel` 只有 `k8s-official | org-policy`。docs/examples 一进来就要改多处 union 和展示逻辑。
2. `Chunk` 强假设每条知识都有 `resource` 和 `path`。schema 字段适配良好，但官方 docs、examples、概念说明可能是跨资源或概念级知识。
3. `CONFLICT_RULES` 只表达 schema/policy 的分工。docs/examples 引入后，如果 prompt 不重构，规则会继续散落和膨胀。
4. `CORPUS = [...buildSchemaCorpus(), ...buildPolicyCorpus()]` 在 import 时 eager build。知识源继续增加后，构建成本和副作用会更难控制。
5. exact field path 是 serving 特有短路路径，retrieval eval 默认不覆盖；如果该路径退化，指标不一定能暴露。

### 3.3 P2：维护性问题

1. `package.json` scripts 已经变成命令清单，eval、alias、schema、corpus、badcase、AB、test 都平铺在 npm scripts 中，入口越来越臃肿。
2. `npm test` 是长链脚本，新增测试容易漏进统一口径，也不利于按组运行或定位失败。
3. `scripts/` 目录混有长期命令、一次性 experiment、历史遗留工具，缺少生命周期分类和 cleanup 规则。
4. `package.json` 仍有大量 `latest` 依赖，长期复现性较弱。
5. 历史 eval artifacts 混在 `data/eval` 下，缺少清理/归档策略；人工查看时容易把旧口径 run 当成当前事实。
6. trace 已预留 `usage` 字段，但 embedding/rerank/LLM token 与 cost 没有贯通，成本目标仍不完整。

### 3.4 P2：文档上下文污染问题

1. `docs/` 是历史迭代产物，包含当前执行方案、学习复盘、旧产品设计、旧上下文交接、superpowers specs/plans 等多类文档，但目录层级没有表达状态。
2. `PROJECT_CONTEXT.md` 仍描述“简历级作品”“前端转型 AI”等早期上下文，和当前 AGENTS 的“训练场 + K8s YAML Copilot”口径不完全一致。
3. `产品设计-K8s智能助手.md` 已标记历史草稿，但仍放在根层，容易被误当成当前产品方案。
4. RAG 复盘文档对学习有价值，但不是当前实现计划；如果没有状态标识，后续 agent 可能把旧指标或旧路线当成当前事实。
5. docs 引用关系没有集中索引，清理时不知道哪些文件还能删、哪些只能归档。

## 4. 目标架构

### 4.1 Eval Artifact Model

统一使用一个 run 作为评估事实入口：

```text
data/eval/
  runs/
    <runId>.json
  traces/
    <runId>.<kind>.jsonl
  bad-cases.jsonl
  baseline.json
  baseline.faith.json
  baseline.generation.json
  baseline.fix.json

data/observability/
  serving-traces.jsonl
```

语义：

- `runs/<runId>.json`：一次评估的配置、版本、模型、指标和 artifact 路径。
- `traces/<runId>.<kind>.jsonl`：该 run 内每个 case 的执行 trace。所属类型以 `runs/<runId>.json` 的 `kind` 为准，文件名后缀只服务人工浏览。
- `bad-cases.jsonl`：长期问题台账，只保存可复测 issue，不保存所有临时失败日志。
- baseline 文件按 eval kind 分离，避免不同任务类型的指标互相污染。
- `data/observability/serving-traces.jsonl`：真实 Ask / API 请求的观测日志，不属于任何 eval run。

### 4.2 EvalKind 扩展

```ts
type EvalKind =
  | 'retrieval'
  | 'faith'
  | 'judge'
  | 'generation'
  | 'fix';
```

每种 eval 的职责不同：

- `retrieval`：允许自动写 retrieval/rerank bad case。
- `faith`：先生成 preview，显式确认后写 generation/judge bad case。
- `judge`：默认只沉淀 calibration run，不自动写 bad case。
- `generation`：沉淀生成层 run 和 case result，是否写 bad case 后续单独设计。
- `fix`：沉淀修复层 run 和 case result，是否写 bad case 后续单独设计。

### 4.3 Trace 写入策略

trace 不应再只有一个全局文件。

规则：

1. `retrieveContext()` 永远构造并返回 trace，不能因为关闭持久化而隐藏 serving 问题。
2. 持久化由调用方注入 trace sink 决定，不能在 pipeline 内部无条件写固定文件。
3. eval runner 必须创建 runId，并把 run-scoped trace sink 传给检索链路。
4. eval trace 写入 `data/eval/traces/<runId>.jsonl`。
5. serving trace 写入 `data/observability/serving-traces.jsonl` 或后续真实 observability backend，不能写入 `data/eval/`，也不能混入某个 eval run。
6. 本地/dev 场景可以默认保留 serving trace 观测；CI 或生产场景可以关闭或采样。关键约束是分流，不是盲目关闭。

### 4.4 Bad Case 语义

bad case 表达长期可复测 issue，不表达每次运行的所有现象。

规则：

- bad case ID 继续使用 `evalCaseId + failure.layer + failure.type`。
- retrieval eval 写入时必须带 `runId`。
- 同一 run 重复写入不增加 `occurrenceCount`。
- 新 run 复现同一 issue 时追加 `observedRunIds`，更新 `lastSeenRunId`。
- faith converter 不再猜测 retrieval 责任，只能关联已有 retrieval/rerank issue。
- 旧兼容字段不再引入，发现非 canonical 数据直接失败。

### 4.5 Source / Chunk 模型

当前 `Chunk` 对 schema 字段友好，但对 docs/examples 不够通用。本轮只做前置重构，不 ingest 新知识源。

目标结构应支持：

```ts
type SourceType = 'schema' | 'policy' | 'docs' | 'example';

type TrustLevel =
  | 'k8s-official'
  | 'org-policy'
  | 'official-docs'
  | 'curated-example';

interface KnowledgeChunk {
  id: string;
  title: string;
  text: string;
  sourceType: SourceType;
  trustLevel?: TrustLevel;
  sourceUri?: string;
  version?: string;
  appliesTo?: {
    resources?: string[];
    paths?: string[];
    apiVersions?: string[];
  };
}
```

兼容策略：

- schema chunk 仍然保留 `resource/path` 便利字段，但下游不要假设所有 chunk 都一定有。
- `formatSources()` 只依赖 source 通用字段。
- boost/resource/path 逻辑通过 `appliesTo` 或 schema chunk helper 读取。
- docs/examples 引入前，先保证 schema/policy 现有行为不回退。

### 4.6 Docs/Examples 扩展契约

本轮不新增 docs/examples ingestion，但必须把扩展契约钉死。验收标准不是“当前回答更像 K8s 专家”，而是后续接入 docs/examples 时只新增 provider、数据文件和 eval case，不大改 retrieval / format / prompt 主链路。

#### 4.6.1 下游不得硬依赖 `resource/path`

schema chunk 可以继续保留 `resource` / `path` 便利字段，但通用下游不能假设所有 chunk 都有单一资源或字段路径。

通用读取必须通过 helper：

```ts
chunkResources(chunk): string[]
chunkPaths(chunk): string[]
primaryResource(chunk): string | undefined
primaryPath(chunk): string | undefined
```

要求：

- boost、trace、source formatting、eval 诊断优先使用 helper。
- `resource/path` 只作为 schema chunk 的兼容字段。
- docs chunk 可以是概念级，例如“Pod lifecycle”，没有字段 path。
- example chunk 可以跨资源，例如 Deployment + Service + Ingress，不允许被单一 resource/path 强行压扁。

#### 4.6.2 Corpus Provider 接口

新增知识源时不能修改检索主链路，应只新增 provider。

目标接口：

```ts
interface CorpusProvider {
  sourceType: SourceType;
  build(): KnowledgeChunk[];
  manifest(): SourceManifest;
}

interface SourceManifest {
  sourceType: SourceType;
  version?: string;
  generatedAt?: string;
  count: number;
  hash: string;
}
```

目标文件形态：

```text
src/knowledge/schema-corpus.ts
src/knowledge/policy-corpus.ts
src/knowledge/docs-corpus.ts
src/knowledge/example-corpus.ts
src/knowledge/corpus.ts
```

`corpus.ts` 只组合 providers，不写 source-specific 逻辑。

#### 4.6.3 Source-aware context 配额

多源进入同一 top-k 后会产生容量竞争，policy 已经出现过类似问题。设计上必须预留 source-aware selection，不要求本轮实现复杂排序。

目标接口：

```ts
selectContextHits(hits, {
  k,
  taskType,
  sourceQuotas,
});
```

默认原则：

- schema 是字段合法性事实，字段解释和校验错误解释必须保底。
- policy 只在命中相关资源/字段或问题涉及“允许/推荐/生产/平台规范”时保底。
- docs 用于概念、行为语义、使用限制解释；Ask 中可提升，但不能挤掉必要 schema。
- examples 默认不抢 Ask top-k，主要服务 Generate/Fix；除非问题明确要求“示例/模板/怎么写一份 YAML”。

本轮至少要保证 selection/format 层有插入点，避免后续 docs/examples 进入时直接改 `searchCorpusTraced()` 或 prompt 拼接逻辑。

#### 4.6.4 TraceHit 支持多源元数据

Trace 不应强制 `resource` 必填。未来 docs/example trace 必须能表达 sourceType、title 和 appliesTo。

目标结构：

```ts
interface TraceHit {
  id: string;
  title?: string;
  sourceType: SourceType;
  resources?: string[];
  paths?: string[];
  score?: number;
}
```

schema trace 可以继续显示单个 resource/path，但底层结构应支持多个或缺失。

#### 4.6.5 Source policy 语义

source policy 必须先定义各 source 的语义，后续 ingestion 只启用，不重写 prompt 规则。

默认语义：

- `schema`：Kubernetes API 字段事实，回答字段是否合法、类型、枚举、required。
- `docs`：官方概念、行为语义、使用限制和操作说明。
- `policy`：组织规范、平台建议、禁止项，不得说成 K8s 官方强制。
- `example`：配置范式和写法参考，不是规范，不得单独作为“必须如此配置”的依据。

冲突表达：

- schema 与 docs 冲突时，优先声明 schema 是 API 校验事实，docs 是官方行为解释；需要指出版本/适用范围。
- schema 允许但 policy 禁止/不推荐时，必须分层表达。
- example 与 schema/policy 不一致时，不能让 example 覆盖 schema/policy；只能说示例不适用或需要调整。

### 4.7 Corpus 构建策略

当前 eager `CORPUS` 在现阶段可用，但不适合继续扩源。

目标：

```ts
buildCorpus({
  sources: ['schema', 'policy'],
  curatedOnly: true,
});
```

规则：

- import 模块不应触发不可控重构建或网络请求。
- schema/policy/docs/examples 各自有 corpus builder。
- 统一 corpus builder 只做组合、统计和 hash。
- serving 与 eval 使用同一 corpus manifest。

### 4.8 Prompt 与 Source Policy

当前 `CONFLICT_RULES` 已经抽到共享模块，但还不足以承接 docs/examples。

目标：

- 抽出 `buildAnswerSystemPrompt({ sourceTypes })`。
- schema/policy/docs/examples 的职责、优先级和冲突表达在一个模块维护。
- serving `ASK_SYSTEM` 与 eval `ANSWER_SYSTEM` 共用同一个 source policy。
- 新增 sourceType 时必须有对应 label、trust 表达和 prompt 规则。

### 4.9 成本与延迟

trace 目前已有 `latencyMs` 和 `usage` 结构，但 token/cost 未贯通。本轮先规范接口，不强制每个 provider 一次性全部完成。

最低要求：

- run metadata 记录 provider/model。
- trace 记录各阶段 latency。
- 如果 provider 返回 usage，必须写入 trace/case-result。
- 如果 provider 不返回 usage，不伪造成本，只写 `usageUnavailable` 或留空。

### 4.10 命令入口与 scripts 生命周期

`package.json` 不应长期承担完整命令注册表职责。目标是保留少量稳定 npm 入口，把复杂命令收敛到 TypeScript CLI。

建议目标：

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "tsx scripts/test.ts",
    "tool": "tsx scripts/run.ts"
  }
}
```

命令示例：

```bash
npm test
npm test -- --group retrieval
npm run tool -- eval retrieval
npm run tool -- eval faith --policy
npm run tool -- aliases check
npm run tool -- schemas ingest
```

规则：

- `scripts/test.ts` 是唯一 test 入口，内部维护测试 manifest 和 group。
- `scripts/run.ts` 是工具命令入口，内部 dispatch 到 eval / alias / schema / corpus / index / badcase 等命令。
- 历史 scripts 需要做 inventory，标记为 `active`、`experiment`、`deprecated`。
- active 命令迁移到统一入口。
- experiment 命令移动到 `scripts/experiments/` 或在命令 help 中明确标注。
- deprecated 命令删除前必须确认没有 npm scripts、docs、测试或人工流程依赖。

### 4.11 Docs 生命周期与目录重构

docs 目录必须像代码一样有生命周期管理。目标不是删除历史，而是避免历史文档污染当前执行上下文。

建议目标结构：

```text
docs/
  README.md
  current/
    AI应用开发训练方案-K8s-YAML-Copilot.md
    AI应用开发能力训练实现方案.md
  reports/
    RAG能力训练评估报告.md
  learning/
    RAG-复盘-01-检索原理与工程难点.md
    RAG-复盘-02-检索硬化与评估驱动.md
    RAG-复盘-03-生成层评估与修尺子.md
  archive/
    PROJECT_CONTEXT.md
    产品设计-K8s智能助手.md
  superpowers/
    specs/
    plans/
```

规则：

- `docs/README.md` 是唯一文档入口，必须说明每类文档的状态和用途。
- 当前执行依据只能来自 `docs/current/`、`AGENTS.md` 和 active superpowers plan。
- `learning/` 是学习复盘，不作为当前实现约束。
- `archive/` 是历史资料，不作为当前执行依据。
- 每个根文档迁移前必须先做引用检查，更新 `README.md`、`AGENTS.md`、`CLAUDE.md`、`docs/*` 内部链接。
- 删除文档前必须证明没有唯一信息，且引用已清理；不确定时归档，不删除。
- 文档顶部必须有状态说明，例如 `当前执行依据`、`学习复盘`、`历史归档`、`已废弃`。
- 方案文档禁止累积对话过程。决策记录可以保留，但必须表达为当前结论、证据和边界。

## 5. 验收标准

1. retrieval / faith / judge / generation / fix 至少都能生成 `runs/<runId>.json`。
2. retrieval / faith 的 trace 均归属于 run-scoped artifact。
3. 正常 Ask 不再污染 eval run trace；如保留 serving trace，必须写入 `data/observability/serving-traces.jsonl` 或真实 observability backend。
4. retrieval bad case 的 `observedRunIds` 能反映真实 run 复现历史。
5. judge/gen/fix 不再只是 console output，至少有可读取的 case-result artifact。
6. source/chunk 类型能加入 docs/examples，而不需要改检索、source formatting 和 prompt 多处散点。
7. `npm test` 通过单一 test runner 覆盖新增 store、trace、bad-case、source policy 行为。
8. package scripts 从命令清单收敛为少量稳定入口，历史 scripts 完成 inventory 与清理计划。
9. docs 目录有清晰入口、状态分层和归档规则，历史文档不再和当前执行依据混放。
10. 所有改动保持现有 retrieval/faith 指标口径可解释，不自动 promote baseline。

## 6. 风险与取舍

- 这轮重构不会直接提高 Recall/MRR，也不会直接解决 rerank_miss；收益在于后续优化能被准确测量。
- run-scoped trace 会改 artifact 路径，历史脚本需要迁移；但继续维护全局 trace 会带来更长期的心智负担。
- serving trace 不能因为“避免污染 eval”被简单关闭。正确做法是分流和采样，否则会隐藏真实 Ask 链路问题。
- source model 泛化存在抽象过宽风险，因此本轮只做 docs/examples 所需的最小接口，不提前设计完整知识图谱。
- dependency pinning 可能影响 lockfile 和安装行为，应作为独立 task review，不和 eval harness 代码混改。
- docs 物理移动会影响大量相对链接。优先先建 index 和状态标识，再执行迁移；不能一次性移动后留下断链。
