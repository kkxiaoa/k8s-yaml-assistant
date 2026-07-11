# Eval Harness 与多源前置工程质量重构实施计划

> 状态：暂停。Task 1-8 已实施，但 correctness review 发现评估语义与数据契约缺口；Task 9/10 不继续执行。
> 用途：保留第一轮实施记录。后续执行以 2026-07-12 corrective specs 审核通过后生成的新 plans 为准。

**Goal:** 先完成 eval / trace / bad-case / source model 的工程质量重构，再继续 Stage 7、docs/examples ingestion 和 claim-level grounding。重构目标是降低心智负担，让后续每个改动都有稳定证据链。

**Architecture:** 以 `EvalRun` 为评估事实入口，run 显式声明 trace artifact；bad case 只保存长期 issue；serving trace 与 eval run trace 分流；source/chunk/prompt 先泛化到能承接 docs/examples，但本轮不新增 docs/examples ingestion。

**Tech Stack:** TypeScript strict、Node.js ESM、tsx、JSONL、现有 retrieval/faith/judge/generation/fix eval、canonical bad-case schema。

---

## 执行约束

- 严格按 Task 顺序执行。
- 每个 Task 完成验证后停止，汇报结果并等待 review。
- 未经用户明确指示，不执行 `git commit`。
- 不自动 promote baseline。
- 不自动删除历史 eval artifacts。
- 涉及真实模型调用的验证必须提前说明成本；默认先跑本地单测和无网络验证。
- 发现旧兼容字段或历史结构污染时，优先清理，不再新增兼容分支。
- 注释和历史文档不是事实依据；实现前以当前代码路径、数据流和可验证行为为准。

## File Structure

### Create

- `src/eval/artifacts.ts`：run-scoped trace artifact 路径与读写工具。
- `src/eval/artifacts.test.ts`：artifact path、JSONL append/read、run metadata 校验测试。
- `src/retrieval/source-policy.ts`：source label、trustLevel、prompt policy 共享构造。
- `src/retrieval/source-policy.test.ts`：sourceType 覆盖和 prompt 规则测试。
- `src/server/pipeline-retrieval.test.ts`：serving/eval trace 分流与 exact-field 分支测试。
- `src/eval/judge-eval.test.ts`：judge calibration metrics 纯函数测试。
- `data/eval/judge-calibration-labels.jsonl`：judge calibration 人工标注源。
- `scripts/test.ts`：唯一测试入口，内部维护 test manifest / group。
- `scripts/run.ts`：统一工具命令入口，替代平铺 npm scripts，保留极简 usage / 错误提示。
- `scripts/script-inventory.md`：scripts 生命周期盘点结果。
- `docs/CLI.md`：主要命令引导文档，提供清晰、详细、友好的使用说明。
- `docs/README.md`：docs 入口、状态分层和当前执行依据索引。
- `docs/doc-inventory.md`：docs 生命周期盘点结果。

### Modify

- `src/eval/run-store.ts`：扩展 `EvalKind`、artifact metadata、baseline path。
- `src/retrieval/trace.ts`：支持 run-scoped trace writer，保留 `data/observability/serving-traces.jsonl` 的显式入口。
- `src/retrieval/retrieve.ts`：让 search trace 可被 eval runner 绑定到 run artifact。
- `src/server/pipeline.ts`：正常 Ask 不再写 eval run trace，serving trace 走独立 sink。
- `src/eval/cases/retrieval-cases.ts`：retrieval/faith 共用的检索问答标注集。
- `src/eval/retrieval-eval.ts`：创建 runId 后写 run-scoped trace，并把 runId 传入 bad-case 写入。
- `src/eval/faithfulness-eval.ts`：run metadata 写入 trace artifact path。
- `src/eval/faith-bad-cases.ts`：从 run metadata 读取 artifact，减少路径约定。
- `src/eval/judge-eval.ts`：写 judge calibration run 与 trace。
- `scripts/build-calibration.ts`：只从 labels + faith trace materialize calibration snapshot，不再内置人工 label。
- `src/eval/cases/generation-cases.ts` / `src/eval/cases/fix-cases.ts`：generation/fix 输入用例。
- `src/eval/metrics/generation-metrics.ts` / `src/eval/metrics/judge-metrics.ts`：无副作用指标计算。
- `src/eval/generation-eval.ts`：写 generation run 与 trace。
- `src/eval/fix-eval.ts`：写 fix run 与 trace。
- `src/knowledge/schema-corpus.ts`：抽出更通用的 knowledge chunk 类型。
- `src/knowledge/policy-corpus.ts`：适配通用 source metadata。
- `src/knowledge/corpus.ts`：从 eager 常量逐步收敛到 corpus builder。
- `src/retrieval/sources.ts`：改用共享 source policy。
- `src/server/answer-prompt.ts`：服务端和 eval 共用 answer prompt source rules。
- `package.json`：收敛为少量稳定入口，`test` 指向单一 test runner。
- `AGENTS.md`：补充注释精准铁律和 docs 规则。
- `docs/README.md`：链接 CLI 文档。
- `docs/AI应用开发能力训练实现方案.md`：在相应 Stage 记录重构后的 artifact 口径。

---

## Task 1: Eval Artifact Foundation

**Files:**
- Create: `src/eval/artifacts.ts`
- Create: `src/eval/artifacts.test.ts`
- Modify: `src/eval/run-store.ts`
- Modify: `package.json`

- [x] **Step 1: 写 artifact store 测试**

覆盖：

- `tracePathForRun(runId, kind)` 返回 `data/eval/traces/<runId>.<kind>.jsonl`。
- JSONL append/read 保持顺序。
- 非法 runId 被拒绝，避免路径穿越。
- `EvalKind` 支持 `retrieval | faith | judge | generation | fix`。
- `baselinePathFor(kind)` 为不同 kind 返回独立 baseline。

- [x] **Step 2: 扩展 EvalRun**

新增：

```ts
type EvalKind = 'retrieval' | 'faith' | 'judge' | 'generation' | 'fix';

interface EvalArtifactPaths {
  tracePath?: string;
}

interface EvalRun {
  artifactPaths?: EvalArtifactPaths;
  scope?: 'full' | 'policy' | 'smoke' | 'targeted' | 'calibration';
  caseIds?: string[];
}
```

保留历史 `kind` 缺省为 retrieval 的读取行为，但不再为新字段增加复杂兼容逻辑。

- [x] **Step 3: 实现 artifact 工具**

实现：

```ts
appendJsonl(path, value)
readJsonl<T>(path): T[]
tracePathForRun(runId, kind): string
```

只做本地 IO，不 import pipeline、CORPUS 或 runner。

- [x] **Step 4: 验证**

Run:

```bash
npx tsx src/eval/artifacts.test.ts
npx tsc --noEmit -p tsconfig.json
```

Stop and report:

- EvalKind 是否已统一。
- artifact path 是否稳定。
- 是否仍有 runner import 副作用。

---

## Task 2: Retrieval Run-scoped Trace 与 BadCase Run Link

**Files:**
- Modify: `src/retrieval/trace.ts`
- Modify: `src/eval/retrieval-eval.ts`
- Modify: `src/eval/bad-cases.ts`
- Modify: `src/eval/bad-cases.test.ts`

- [x] **Step 1: 写 run linkage 测试**

覆盖：

- `retrievalMiss()` 写入 `tracking.firstSeenRunId`、`lastSeenRunId`、`observedRunIds`。
- 同一 run 重复写入不增加 `occurrenceCount`。
- 不同 run 复现同一 issue 时增加 `occurrenceCount`。
- rerank issue 使用 `layer='rerank'` + `type='rerank_miss'`。

- [x] **Step 2: 改 retrieval eval 数据流**

流程变为：

```text
create runId
  -> tracePath = traces/<runId>.jsonl
  -> 每条 case append run-scoped trace
  -> retrievalMiss(..., runId)
  -> writeRun({ artifactPaths.tracePath })
```

不再写全局 `data/eval/traces.jsonl`。

- [x] **Step 3: 保留全局 trace 读取的退场策略**

`readRetrievalTraces()` 仅用于显式读取 retrieval trace；eval runner 不能依赖默认 serving trace path。

- [x] **Step 4: 验证**

Run:

```bash
npx tsx src/eval/bad-cases.test.ts
npm run eval
```

Stop and report:

- 最新 retrieval run 的 `artifactPaths.tracePath`。
- bad-case 的 observed run 是否写入。
- 是否仍有 `data/eval/traces.jsonl` 新增写入。

---

## Task 3: Serving / Eval Trace 分流与 Exact-field 评估入口

**Files:**
- Modify: `src/server/pipeline.ts`
- Modify: `src/retrieval/trace.ts`
- Create: `src/server/pipeline-retrieval.test.ts`
- Modify: retrieval eval 或新增 targeted script

- [x] **Step 1: 写 trace 分流测试**

覆盖：

- `retrieveContext()` 始终返回 trace。
- eval runner 注入 run-scoped sink 时，trace 写入 `data/eval/traces/<runId>.jsonl`。
- serving sink 写入 `data/observability/serving-traces.jsonl`，不写入 `data/eval/` 或任何 eval run trace。
- 未传 sink 时不落盘，但返回值里的 trace 不丢。
- exact path 命中时 trace status 为 `skipped_exact`。

- [x] **Step 2: 修改 pipeline 持久化策略**

pipeline 不再内部无条件落盘，改为调用方注入：

```ts
traceSink?.(trace)
```

内部返回值始终保留 `trace`，方便 API、serving 观测和测试使用。

API route 或上层 serving 入口可以根据环境决定是否传 `appendServingTrace`。本轮不以“关闭 serving trace”作为目标，只要求 serving trace 不污染 `data/eval/` 下的 eval artifact。

- [x] **Step 3: 补 exact-field eval 覆盖**

新增最小评估入口，用真实 `EditorContext.cursorPath` 覆盖：

- Deployment container image
- Pod privileged
- Service type
- Ingress tls
- PVC resources.requests

目标不是替代 retrieval eval，而是证明 serving 特有 exact path 没有退化。

- [x] **Step 4: 验证**

Run:

```bash
npx tsx src/server/pipeline-retrieval.test.ts
npm test
```

Stop and report:

- serving trace 是否已落到 `data/observability/serving-traces.jsonl`，且不写入 `data/eval/`。
- exact path 是否仍能返回 schema + policy。
- exact path 失败是否回到 search path。

---

## Task 4: Faith Run Artifact Alignment

**Files:**
- Modify: `src/eval/faithfulness-eval.ts`
- Modify: `src/eval/faith-store.ts`
- Modify: `src/eval/faith-bad-cases.ts`
- Modify: `src/eval/faith-bad-cases.test.ts`

- [x] **Step 1: 写 run metadata 输入测试**

覆盖：

- faith converter 优先读取 `run.artifactPaths.tracePath`。
- 缺少 artifact path 时失败并提示具体字段。
- legacy path 推断只允许在显式 legacy 测试中出现，不作为新 run 默认路径。

- [x] **Step 2: faith eval 写 trace artifact**

把当前 `data/eval/faith/<runId>.jsonl` 语义收敛到 `traces/<runId>.faith.jsonl`，run metadata 显式记录路径。

可保留旧目录输出一轮作为人工确认，但新 converter 不应依赖旧路径。

- [x] **Step 3: converter 改读 run metadata**

`readFaithBadCaseInput(runId)` 数据流：

```text
readRun(runId)
  -> assert kind=faith
  -> read tracePath
  -> validate selected cases
  -> build candidates
```

- [x] **Step 4: 验证**

Run:

```bash
npx tsx src/eval/faith-bad-cases.test.ts
npm run eval:faith -- --policy
npm run badcases:faith -- <newRunId>
```

Stop and report:

- converter 是否不再依赖硬编码 faith 目录。
- policy run 的 hash/selection 校验是否仍成立。
- 是否有新增 bad-case 候选。

---

## Task 5: Judge Eval Run-store

**Files:**
- Modify: `src/eval/judge-eval.ts`
- Create: `src/eval/judge-eval.test.ts`
- Modify: `src/eval/run-store.ts` if needed

- [x] **Step 1: 抽离 judge calibration 纯指标计算**

把 console 打印和指标计算拆开：

```ts
computeJudgeCalibrationMetrics(rows)
```

便于单测，不需要真实模型。

- [x] **Step 2: 写 judge run artifact**

`eval:judge` 运行后写：

- `runs/<runId>.json`，kind=`judge`，scope=`calibration`。
- `traces/<runId>.judge.jsonl`，记录每条 calibration case 的 votes、majority、policy dimension、disagreement。

- [x] **Step 3: 验证**

本地纯函数：

```bash
npx tsx src/eval/judge-eval.test.ts
```

真实模型调用需用户确认后再跑：

```bash
npm run eval:judge
```

Stop and report:

- judge run 是否可被 `latestRunPath('judge')` 找到。
- trace 是否足够复盘分歧。
- 是否不写 bad-case。

---

## Task 5.5: Eval Dataset Taxonomy Cleanup

**Files:**
- Create: `data/eval/judge-calibration-labels.jsonl`
- Rename: `src/eval/eval-set.ts` → `src/eval/cases/retrieval-cases.ts`
- Rename: `src/eval/retrieve-eval.ts` → `src/eval/retrieval-eval.ts`
- Move: `src/eval/generation-cases.ts` → `src/eval/cases/generation-cases.ts`
- Move: `src/eval/fix-cases.ts` → `src/eval/cases/fix-cases.ts`
- Move: `src/eval/generation-metrics.ts` → `src/eval/metrics/generation-metrics.ts`
- Move: `src/eval/judge-metrics.ts` → `src/eval/metrics/judge-metrics.ts`
- Modify: `scripts/build-calibration.ts`
- Modify: `src/retrieval/trace.ts`
- Modify: imports / npm scripts / tests

- [x] **Step 1: 统一 eval case 命名**

把 retrieval 专属的泛名收敛：

```ts
EvalCase -> RetrievalEvalCase
EVAL_SET -> RETRIEVAL_CASES
```

`faith` 继续复用 retrieval case，但命名必须显式表达“faith 是在 retrieval answer cases 上评估生成忠实度”，不再用泛化 `EvalCase` 暗示所有 eval 共用同一种 case。

- [x] **Step 2: 把 judge 人工 label 从 build 脚本移出**

`scripts/build-calibration.ts` 只做 materialize：

```text
data/eval/judge-calibration-labels.jsonl
  + latest faith trace
  -> data/eval/judge-calibration.jsonl
```

人工 label 是 judge calibration dataset，不是 runner 脚本的一部分。

- [x] **Step 3: 统一 metrics/cases 模块目录**

把 `cases` 和 `metrics` 分层，避免 runner、case、metric 平铺在 `src/eval/` 根目录下继续扩散。

- [x] **Step 4: 清理 retrieval trace 泛化命名**

删除未使用的泛名 `appendTrace()`，`readTraces()` 改为 `readRetrievalTraces()`。

不改 retrieval 检索逻辑，不改 trace schema，不改线上 Ask 行为。

- [x] **Step 5: 验证**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
npm test
npm run eval:check
npm run build:calibration
```

Stop and report:

- judge labels 是否已脱离脚本。
- retrieval case 命名是否不再泛化。
- 是否存在旧 import 或旧 trace helper。

---

## Task 6: Generation / Fix Eval Run-store

**Files:**
- Modify: `src/eval/generation-eval.ts`
- Modify: `src/eval/fix-eval.ts`
- Modify: `src/eval/metrics/generation-metrics.ts`
- Modify/Create: generation/fix artifact tests

- [x] **Step 1: 抽离 metrics 结果结构**

把当前 console 汇总固化为结构化指标：

```ts
GenerationEvalMetrics
FixEvalMetrics
GenerationCaseResult
FixCaseResult
```

指标至少覆盖现有输出：

- parse success
- validation pass
- repair attempted
- repair success after fail
- max round failure
- kind match
- required path coverage
- consistency pass
- intent preserved

- [x] **Step 2: 写 run 和 trace**

`eval:gen` 写 kind=`generation`。

`eval:fix` 写 kind=`fix`。

每条 case result 至少保存：

- case id
- prompt/requirement 或 defect type
- attempts summary
- final yaml 是否存在
- validation errors summary
- metrics flags

不把完整长 YAML 强塞进 run JSON；需要保存时放 trace。

- [x] **Step 3: 不做自动 bad-case**

本 task 只沉淀证据。generation/fix bad-case 分类另起设计，避免这轮重构继续膨胀。

- [x] **Step 4: 验证**

纯函数测试先跑。

真实模型调用需用户确认后再跑：

```bash
npm run eval:gen
npm run eval:fix
```

Stop and report:

- generation/fix run 是否可被 latestRunPath 找到。
- 指标是否和旧 console 输出一致。
- trace 是否足以定位失败原因。

---

## Task 7: Source Model 与 Prompt Policy 前置重构

**Files:**
- Create: `src/retrieval/source-policy.ts`
- Create: `src/retrieval/source-policy.test.ts`
- Create: `src/knowledge/chunk.ts`
- Create: `src/knowledge/chunk.test.ts`
- Modify: `src/knowledge/schema-corpus.ts`
- Modify: `src/knowledge/policy-corpus.ts`
- Modify: `src/retrieval/trace.ts`
- Modify: `src/retrieval/sources.ts`
- Modify: prompt 相关模块

- [x] **Step 1: 写 source type 覆盖测试**

覆盖：

- `schema` label/trust 仍为 K8s 官方事实。
- `policy` label/trust 仍为组织策略。
- `docs` 和 `example` 先有 label/trust/prompt 规则，但没有 corpus builder。
- 未覆盖 sourceType 时测试失败，避免新增 source 后 prompt 静默缺规则。

- [x] **Step 2: 引入 KnowledgeChunk 最小接口**

允许：

- schema chunk 继续有 `resource/path`。
- policy chunk 通过 `appliesTo` 表达资源和字段。
- docs/examples 未来可以没有单一 `path`。

同时新增通用 helper：

```ts
chunkResources(chunk): string[]
chunkPaths(chunk): string[]
primaryResource(chunk): string | undefined
primaryPath(chunk): string | undefined
```

要求：

- schema chunk 继续保留 `resource/path` 兼容字段。
- policy chunk 使用 `appliesTo` 表达资源/字段。
- retrieval/boost/trace/formatSources 后续不得直接假设所有 chunk 都有单一 `resource/path`。
- 本 task 不做大规模重命名，避免一次改动过宽；先用类型别名或兼容字段让现有代码通过。

- [x] **Step 3: 调整 TraceHit 多源元数据**

`TraceHit` 改为支持：

```ts
{
  id: string;
  title?: string;
  sourceType: SourceType;
  resources?: string[];
  paths?: string[];
  score?: number;
}
```

schema trace 仍可显示单个 resource/path，但结构不能强制所有 source 都有。

- [x] **Step 4: 预留 source-aware context selection 插入点**

新增或预留：

```ts
selectContextHits(hits, { k, taskType, sourceQuotas })
```

本轮可先实现默认 pass-through，但接口必须存在，避免后续 docs/examples 接入时直接改 `searchCorpusTraced()` 或 prompt 拼接逻辑。

- [x] **Step 5: 收敛 formatSources 和 prompt policy**

`formatSources()` 不再直接维护零散 `SOURCE_LABEL`。

answer system prompt 使用共享 source policy 构造。

schema/policy 现有冲突表达不回退。

- [x] **Step 6: 验证**

Run:

```bash
npx tsx src/knowledge/chunk.test.ts
npx tsx src/retrieval/source-policy.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
```

Stop and report:

- schema/policy 输出是否完全兼容。
- docs/examples 是否已有类型与 prompt 边界。
- trace 是否不再强制 resource/path。
- source-aware context selection 是否有稳定插入点。
- 是否还有下游强假设所有 chunk 都有 path。

---

## Task 8: Corpus Builder 退 eager 化

**Files:**
- Modify: `src/knowledge/corpus.ts`
- Modify/Create: corpus provider types/tests
- Modify: retrieval/eval imports
- Modify/Create: corpus tests

- [x] **Step 1: 写 corpus builder 测试**

覆盖：

- 默认构建 schema + policy。
- corpus hash 稳定。
- source 选择可控。
- provider manifest 包含 sourceType、count、hash。
- import `corpus.ts` 不触发额外文件写入或网络。

- [x] **Step 2: 定义 CorpusProvider 契约**

目标接口：

```ts
interface CorpusProvider {
  sourceType: SourceType;
  build(): KnowledgeChunk[];
  manifest(): SourceManifest;
}
```

schema/policy 先适配 provider；docs/example provider 本轮不实现 ingestion，但接口必须能直接承接。

- [x] **Step 3: 实现 buildCorpus**

目标接口：

```ts
buildCorpus({ sources: ['schema', 'policy'] })
```

短期可以保留：

```ts
export const CORPUS = buildCorpus(...)
```

但新代码优先调用 builder 或 manifest，避免后续 docs/examples 加入时继续扩大 eager 常量影响。

- [x] **Step 4: 验证**

Run:

```bash
npm run corpus:stats
npm test
```

Stop and report:

- corpus size/hash 是否与重构前一致。
- provider manifest 是否可用于后续 docs/examples。
- retrieval/faith eval 是否仍读同一 corpus。

---

## Task 9: 单一测试入口、工具 CLI 与 scripts cleanup

**Files:**
- Create: `scripts/test.ts`
- Create: `scripts/run.ts`
- Create: `scripts/script-inventory.md`
- Modify: `package.json`
- Modify: lockfile if dependency pinning is accepted

- [ ] **Step 1: 建立单一 test runner**

`npm test` 改为：

```json
"test": "tsx scripts/test.ts"
```

`scripts/test.ts` 内部维护 manifest：

```ts
[
  { file: 'src/validation/validate.test.ts', group: 'validation' },
  { file: 'src/server/agent.test.ts', group: 'server' },
  { file: 'src/retrieval/router.test.ts', group: 'retrieval' },
]
```

支持：

```bash
npm test
npm test -- --group retrieval
npm test -- --list
```

原则：

- package.json 不再用 `&&` 串长链。
- 新增测试必须登记到 manifest。
- 单测失败时 test runner 明确打印失败文件和退出码。

- [ ] **Step 2: 建立统一工具 CLI**

新增：

```json
"tool": "tsx scripts/run.ts"
```

目标映射：

```bash
npm run tool -- eval retrieval
npm run tool -- eval faith --policy
npm run tool -- eval compare
npm run tool -- aliases check
npm run tool -- schemas ingest
npm run tool -- corpus stats
npm run tool -- index build
npm run tool -- badcases faith <runId>
```

实现要求：

- `scripts/run.ts` 只负责参数解析和 dispatch。
- 具体命令逻辑迁移为可 import 的函数，避免从带 `main()` 的 runner import。
- 迁移期间可以保留旧 npm scripts 一轮，但最终目标是从 package scripts 移除平铺命令。
- CLI 不做复杂多级 help，避免自研命令框架过重。
- `npm run tool -- --help` 只输出极简入口和 `docs/CLI.md` 路径。
- 未知命令必须输出简短错误、1-2 个最接近示例和 `docs/CLI.md` 路径。
- 详细引导全部放到 `docs/CLI.md`。

- [ ] **Step 3: 增加 CLI README**

新增 `docs/CLI.md`，内容至少包括：

- 一句话说明：只需要记住 `npm test` 和 `npm run tool -- ...`。
- Quick Start：最常用 5-8 条命令。
- 命令分组：eval、aliases、schemas、corpus、index、badcases。
- 每个命令写清：用途、示例、是否会调用模型/产生费用、主要输出文件。
- 旧 npm scripts 到新 tool 命令的迁移表。
- 常见问题：缺 API key、eval 跑很久、baseline 是否自动晋升、哪些命令会写文件。
- 推荐工作流：改 retrieval、改 policy、改 schema ingestion、改 generation/fix 时分别跑什么。
- 明确哪些命令是长期支持入口，哪些只是 experiment。

`docs/README.md` 必须链接 `docs/CLI.md`。

- [ ] **Step 4: scripts inventory 与 cleanup**

盘点当前 `scripts/`：

- `active`：长期命令，迁移到 `scripts/run.ts`。
- `experiment`：一次性 A/B 或探索工具，移动到 `scripts/experiments/` 或在 help 中明确标注。
- `deprecated`：没有 package script、docs、测试或人工流程依赖的历史脚本，删除前列出证据。

输出 `scripts/script-inventory.md`，记录每个脚本的分类、迁移目标和是否删除。

- [ ] **Step 5: 依赖版本风险 review**

列出 `latest` 依赖清单和锁定建议。

不在未确认前直接大规模改依赖版本。依赖 pinning 会影响 lockfile 和安装行为，应单独 review 后执行。

- [ ] **Step 6: 验证**

Run:

```bash
npm test
npm test -- --list
npm run tool -- --help
npm run build
```

Stop and report:

- test manifest 覆盖范围。
- `npm run tool -- --help` 是否指向 `docs/CLI.md`。
- `docs/CLI.md` 是否足够清晰、详细、友好，覆盖常用命令、旧命令迁移表和风险提示。
- package scripts 缩减前后对比。
- scripts inventory 中建议删除/移动的文件。
- 是否还有 `latest` 依赖。
- 是否建议下一步单独做 dependency pinning。

---

## Task 10: Docs Cleanup / Refactor 与回归清单

**Files:**
- Create: `docs/README.md`
- Create: `docs/doc-inventory.md`
- Modify: `docs/AI应用开发能力训练实现方案.md`
- Modify: `docs/AI应用开发训练方案-K8s-YAML-Copilot.md`
- Modify: `docs/RAG能力训练评估报告.md`
- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `docs/产品设计-K8s智能助手.md`
- Modify: `AGENTS.md`
- Optional Move: `docs/archive/*`
- Optional Move: `docs/learning/*`
- Optional Move: `docs/current/*`

- [x] **Step 1: 建立 docs inventory**

盘点当前 `docs/` 根层和 `docs/superpowers`：

```text
current       当前执行依据
active-plan   当前或近期实施计划
report        当前仍有参考价值的评估报告
learning      学习复盘,不作为执行约束
archive       历史归档,不作为当前依据
deprecated    可删除候选,删除前必须确认无唯一信息
```

输出 `docs/doc-inventory.md`，每个文档至少记录：

- status
- purpose
- current authority
- referenced by
- suggested action

- [x] **Step 2: 建立 docs/README.md**

`docs/README.md` 是唯一 docs 入口，必须明确：

- 当前执行依据是谁。
- 哪些文档只是学习复盘。
- 哪些文档是历史归档。
- `superpowers/specs` 与 `superpowers/plans` 的关系。
- 历史文档不能覆盖 `AGENTS.md` 和 current docs。

- [x] **Step 3: 给根层文档补状态头**

根层文档必须在顶部标明状态：

- `当前执行依据`
- `评估报告`
- `学习复盘`
- `历史归档`
- `已废弃`

重点修正：

- `PROJECT_CONTEXT.md`：早期上下文，不能作为当前执行依据。
- `产品设计-K8s智能助手.md`：保留历史价值，但继续明确历史草稿。
- `RAG-复盘-*`：学习复盘，不作为当前实现计划。
- `RAG能力训练评估报告.md`：若仍有参考价值，标明评估日期、适用边界和与当前计划的关系。

- [ ] **Step 4: 决定是否物理重构目录**

建议目标：

```text
docs/current/
docs/reports/
docs/learning/
docs/archive/
docs/superpowers/
```

物理移动前必须先跑引用检查。若断链修复成本高，本轮可先只做 `README + inventory + status header`，把目录移动作为下一轮单独任务。

- [ ] **Step 5: 更新训练方案中的质量底座口径**

记录新 artifact model：

- run
- trace
- bad-case
- baseline

明确 generation/fix/judge 已经进入 run-store。

- [ ] **Step 6: 更新后续计划依赖关系**

Stage 7、docs/examples ingestion、claim-level grounding 都依赖新的 artifact model，不再依赖全局 traces。

- [ ] **Step 7: 最终回归**

按成本从低到高：

```bash
rg "docs/|RAG-|PROJECT_CONTEXT|产品设计-K8s智能助手" AGENTS.md CLAUDE.md README.md docs
npx tsc --noEmit -p tsconfig.json
npm test
npm run eval
```

模型类 eval 仅在用户确认后执行：

```bash
npm run eval:faith -- --policy
npm run eval:judge
npm run eval:gen
npm run eval:fix
```

Stop and report:

- docs inventory 分类和建议动作。
- 是否执行了物理移动；如果没有，原因和下一步。
- 是否存在断链或旧口径引用。
- 所有 artifact 路径。
- 与旧 baseline 的可比性说明。
- 剩余已知问题，例如 rerank_miss、docs ingestion、claim-level grounding。
