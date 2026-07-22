# Serving Observation Safety 实施计划

> 状态：独立 design/plan review（设计 / 计划审核）和 Task 1-5（任务 1-5）逐项审核已通过；Task 6（任务 6）已完成实现与本地门禁，等待 Task 6 review（任务 6 审核）。
> 用途：把 Serving Observation Safety（在线观测安全）设计拆成关闭原始写入、严格协议、脱敏、采样、传输决策、本地生命周期和 Ask（询问）集成的逐项审核任务。
> 对应设计：`docs/superpowers/specs/2026-07-14-serving-observation-safety-design.md`。
> 执行位置：四份 `2026-07-12` corrective plans（纠偏计划）和 Case Governance（评估用例治理）已经完成；本计划现在是生产部署 Phase 2（阶段 2）Task 6（任务 6）的依赖。Task 1-6（任务 1-6）已退役 raw serving trace（原始在线轨迹）持久化入口，并完成严格协议、结构化脱敏、allowlist projection（白名单投影）、runtime config（运行时配置）、稳定采样、同步 recorder（记录器）、受控本地生命周期和 Ask（询问）接线；当前停止在 Task 6（任务 6）实现审核点。

## Goal

在不改变 Ask、retrieval 和 eval 语义的前提下，让 serving observation 只有经过显式启用、采样、allowlist 投影、脱敏、runtime decode 和受控生命周期后才能落盘；安全能力完成前默认不持久化真实 Ask trace。

## Architecture

```text
Ask route
  -> server-generated requestId
  -> ServingObservationRecorder
       -> mode off? stop
       -> sampled out? stop
       -> redact/project RetrievalTrace
       -> strict ServingRetrievalObservation decode
       -> local lifecycle sink
  -> recorder failure never changes Ask result

Eval runner
  -> run-scoped TraceEnvelope writer
  -> does not use ServingObservationRecorder
```

serving 持久化协议位于独立 `src/observability/` 模块，不直接 JSON stringify `RetrievalTrace`。pipeline 继续只负责构造和返回内存 trace，不读取 serving observation 配置。

## Execution Rules

- Task 1-4（任务 1-4）已完成并逐项审核；Task 5（任务 5）已完成实现与本地门禁，当前停止等待独立审核，不得顺势执行 Task 6（任务 6）。
- Task 1（任务 1）用静态查询固定 raw wiring（原始接线）反例，并用现有 pipeline（流水线）回归保护内存 trace（轨迹）；Task 2-6（任务 2-6）先写可执行反例测试，再实现。每个 Task（任务）完成后停止汇报并等待独立 review（审核）。
- 前一 Task（任务）审核通过后才可进入后一 Task（任务）。
- 每个 Task（任务）开始前重新核对当时的 `RetrievalTrace`、Ask route（询问路由）和文档状态；若事实已经变化，先修订本 design/plan（设计 / 计划）。
- 不调用真实模型、embedding、rerank 或网络。
- 不读取、迁移或兼容旧 `data/observability/serving-traces.jsonl`。
- 不把 serving observation 写入 `data/eval/`，不修改 Eval Artifact Protocol。
- 不提供 raw/debug fallback；脱敏、投影或 decode 失败时丢弃 observation。
- 不新增 UI feedback、采纳信号、bad-case 自动回灌或远程 backend。
- 未经用户单独 review，不新增日志/轮转依赖，也不实现自研生产级 logger。
- 未经用户要求不 `git add`、不 commit。

## File Structure

### Create

- `src/observability/serving-observation.ts`
- `src/observability/serving-observation.test.ts`
- `src/observability/redaction.ts`
- `src/observability/redaction.test.ts`
- `src/observability/config.ts`
- `src/observability/config.test.ts`
- `src/observability/sampling.ts`
- `src/observability/sampling.test.ts`
- `src/observability/recorder.ts`
- `src/observability/recorder.test.ts`
- `src/observability/local-sink.ts`
- `src/observability/local-sink.test.ts`
- `.env.example`

### Modify

- `app/api/ask/route.ts`
- `src/retrieval/trace.ts`
- `src/server/pipeline-retrieval.test.ts`
- `README.md`
- `docs/AI应用开发能力训练实现方案.md`：仅在全部 Task 完成后更新状态。
- `package.json` / `package-lock.json`：Task 4 review（任务 4 审核）已决定不新增依赖，本计划后续不修改。

## Task 1: 关闭并退役当前 Raw Serving Trace

**Execution position:** 独立 design/plan review（设计 / 计划审核）通过后，作为生产部署 Phase 2（阶段 2）Task 6（任务 6）的第一个实施子任务执行；完成后停止等待 Task 1 review（任务 1 审核），不得继续 Task 2（任务 2）。

**Files:**

- Modify: `app/api/ask/route.ts`
- Modify: `src/retrieval/trace.ts`
- Modify: `src/server/pipeline-retrieval.test.ts`
- Verify: `src/server/pipeline.ts`

- [x] **Step 1: 固定安全隔离反例**

确认当前 route 存在以下直接 wiring，作为本 Task 要删除的反例：

```ts
import { appendServingTrace } from '@/retrieval/trace';

retrieveContext(..., { traceSink: appendServingTrace });
```

同时固定 `src/retrieval/trace.ts` 中可绕过安全协议的 raw API 反例：

```text
servingTracePath
SERVING_TRACES_PATH
appendTraceToPath
appendServingTrace
readRetrievalTraces
```

记录当前事实：`RetrievalTrace` 仍由 `retrieveContext()` 返回；关闭持久化不能删除内存 trace 或 exact/search 诊断。

- [x] **Step 2: 移除默认 serving sink 与 raw API**

从 Ask route 删除 `appendServingTrace` import 和默认 `traceSink`。调用保持：

```ts
retrieveContext(question, 3, editorContext, mode)
```

从 `src/retrieval/trace.ts` 删除上述 raw path/writer/reader API 及其 filesystem imports。保留 `RetrievalTrace`、`TraceHit`、`IndexCacheTrace` 和 `toTraceHit()` 这些内存契约。

同步清理 `src/server/pipeline-retrieval.test.ts` 对 raw API 的导入和测试：

- 可注入 trace sink 用内存数组断言，不写临时 JSONL。
- 删除旧 serving path/write/fail-open 测试；它们验证的正是本 Task 要退役的不安全行为。
- eval strict writer 由 Eval Artifact Protocol 自己的测试保护，pipeline 测试不另造 raw eval writer。

本 Task 不新增临时环境变量，不保留 unsafe opt-in 或 deprecated export。在 Task 2-6 完成前，项目不提供本地 serving 持久化入口。

- [x] **Step 3: 验证隔离边界**

```bash
! rg -n "appendServingTrace|traceSink" app/api/ask/route.ts
! rg -n "servingTracePath|SERVING_TRACES_PATH|appendTraceToPath|appendServingTrace|readRetrievalTraces" src/retrieval/trace.ts src/server/pipeline-retrieval.test.ts
npx tsx src/server/pipeline-retrieval.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

必须确认：

- 未注入 sink 时 exact/search 仍返回内存 trace。
- eval 的 run-scoped strict writer 不受影响。
- 代码中不再存在可将 `RetrievalTrace` 直接落盘的通用/serving helper。

**Stop and report:** route（路由）隔离改动、内存 trace（轨迹）保留情况、测试结果和当前 observation（观测）默认关闭状态。停止等待 Task 1 review（任务 1 审核）。

## Task 2: Serving Observation Contract 与结构化脱敏

**Execution position:** Task 1 review（任务 1 审核）通过，raw serving persistence（原始在线持久化）保持关闭后。

**Files:**

- Create: `src/observability/serving-observation.ts`
- Create: `src/observability/serving-observation.test.ts`
- Create: `src/observability/redaction.ts`
- Create: `src/observability/redaction.test.ts`
- Read only: `src/retrieval/trace.ts`
- Read only: `src/retrieval/query-expansion-runtime.ts`
- Read only: `src/knowledge/chunk.ts`
- Reuse: `src/shared/json.ts`

- [x] **Step 1: 写 raw-field 与 secret 泄漏反例**

先覆盖以下必须失败的输入/输出：

- observation 含 `queryText`、原始/扩展 query、selected text、errors、YAML、answer、chunk text、hit title 或 source URI。
- strict schema 出现未知字段、非有限 score/latency 或非法时间。
- question 含 Kubernetes Secret `data/stringData`、Bearer、JWT、PEM private key、password/token/API key 赋值、URL credential。
- question 超过可配置输入上限或系统 hard cap。
- 疑似 Secret/YAML 无法解析。
- redactor 自身抛错或输出仍命中敏感模式。
- 超长输入在脱敏前被截断，导致敏感尾部逃逸。

测试不得把真实 `.env` 值作为 fixture；全部使用显式假值，并断言假值不出现在序列化 observation 和错误消息中。

- [x] **Step 2: 定义 strict runtime schema**

实现设计中的 `ServingRetrievalObservationSchema`、`ServingHitReferenceSchema` 和 decoder：

- 使用 Zod strict object 和判别字段 `schemaVersion/kind`。
- route、query disposition、query expansion、ranking、latency 和 cache 使用封闭字段集合。
- hit reference 只保留 ID、source type、authority、version、targets 和有限 score。
- query 只有 `redacted` 时允许非空 text；`dropped_sensitive/dropped_invalid` 禁止 text。
- `schemaVersion`、`redactionVersion`、server-generated UUID 和 ISO datetime 使用严格格式；query disposition、expansion status/error code 和 cache status/reason 验证跨字段不变量。
- redaction labels 非空时去重，只接受固定 enum。
- 字符串、数组和 targets 有固定上限，score/latency 必须是符合语义的有限数，ID/hint/target 使用受控格式。
- 写盘 schema 不 import 或 extend `RetrievalTraceSchema`，避免未来字段自动扩散。

- [x] **Step 3: 实现 redactor 与安全验证**

复用项目已有 `js-yaml`，实现无副作用纯函数：

```ts
redactServingQuestion(input, options): RedactionResult
```

要求：

- YAML/JSON 可解析时递归处理 Secret 和 credential key。
- YAML/JSON 只使用无自定义 tag 的 safe schema，递归过程有深度、节点数和别名边界。
- JSON-compatible 规范化复用 `src/shared/json.ts` 的 `canonicalJson()`，不新增第二套 canonicalize/parse helper。
- 普通文本处理固定 credential/token 格式。
- 输出进行第二次敏感扫描。
- 超过输入上限时不进入 parser；可预期的敏感/不确定输入返回 dropped disposition，redactor 内部错误或输出验证失败则拒绝整条 observation。
- 处理顺序固定为：input byte gate → classify/parse → redact → canonicalize → 按 UTF-8 字节边界截断 → 第二次敏感扫描。
- 不把原值、部分原值或 hash 写入 label/reason。

- [x] **Step 4: 实现 allowlist projection**

实现：

```ts
projectServingRetrievalObservation({
  requestId,
  observationId,
  trace,
  redactedQuestion,
}): ServingRetrievalObservation
```

投影规则：

- 不复制 `trace.queryText`。
- query expansion 只复制非文本诊断元数据；matched alias 不复制 `zhAlias`。
- hit 不复制 title 和 source URI。
- projection 结果必须再次经过 runtime decoder。
- 函数不写盘、不读环境变量、不吞异常。

- [x] **Step 5: 验证**

```bash
npx tsx src/observability/redaction.test.ts
npx tsx src/observability/serving-observation.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

**Stop and report:** persisted allowlist、被永久排除的字段、redaction fixtures、dropped 语义和仍无法覆盖的秘密类型。等待 review。

## Task 3: Runtime Config 与稳定采样

**Files:**

- Create: `src/observability/config.ts`
- Create: `src/observability/config.test.ts`
- Create: `src/observability/sampling.ts`
- Create: `src/observability/sampling.test.ts`

- [x] **Step 1: 写配置与采样反例**

覆盖：

- 未配置时是 `mode=off`。
- 未知 mode、NaN/Infinity、越界 sample rate、非正 size/retention、`maxFileBytes > maxTotalBytes`、`maxTextBytes > maxInputBytes` 明确失败。
- 输入、输出文本、单文件、总容量或保留天数超过 design 的 hard cap 明确失败。
- local mode 缺任一必填字段失败，不能回退默认值。
- invalid config 不把原始环境变量值写入 error。
- sample rate 0/1 边界，同一 request ID 结果稳定。
- 固定 request ID 测试向量与手工计算的 SHA-256 前 64 bit 结果一致。

- [x] **Step 2: 实现 config decoder**

使用显式环境变量名：

```text
SERVING_OBSERVATION_MODE=off|local
SERVING_OBSERVATION_SAMPLE_RATE
SERVING_OBSERVATION_MAX_FILE_BYTES
SERVING_OBSERVATION_MAX_TOTAL_BYTES
SERVING_OBSERVATION_RETENTION_DAYS
SERVING_OBSERVATION_MAX_INPUT_BYTES
SERVING_OBSERVATION_MAX_TEXT_BYTES
```

要求：

- 默认仅 `mode=off`。
- local 所有数值显式必填。
- 实现 design 规定的字段关系和 hard cap，不允许环境变量扩大安全上限。
- parse 只返回判别联合或结构化安全错误，不读 `.env` 文件本身。
- 配置 snapshot 不包含其他环境变量。

- [x] **Step 3: 实现 content-independent sampler**

```ts
shouldSample(requestId: string, sampleRate: number): boolean
```

- 按 design 固定的 SHA-256 前 64 bit big-endian 映射到 `[0, 1)`，用固定 request ID 测试向量锁定跨进程结果。
- 只读取服务端 request ID 和 rate。
- 不读取 question、resource、path、outcome 或用户身份。

- [x] **Step 4: 验证**

```bash
npx tsx src/observability/config.test.ts
npx tsx src/observability/sampling.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

**Stop and report:** 配置矩阵、hard caps、sampling algorithm 和固定测试向量。等待 review。

## Task 4: Local Rotation Transport 决策 Gate

**Files:**

- Modify: `docs/superpowers/specs/2026-07-14-serving-observation-safety-design.md`
- Modify: `docs/superpowers/plans/2026-07-14-serving-observation-safety.md`
- Inspect only: `package.json`, `package-lock.json`

- [x] **Step 1: 核对执行时需求和依赖现状**

重新确认：

- 只支持受控本地/开发环境还是需要多进程生产本地文件。
- strict JSONL append、UTC/size rotation、retention、max total bytes、symlink-safe cleanup、测试注入需求。
- 当前 pipeline `traceSink` 是同步 `void` 契约：选择同步写请求路径，还是有界队列；队列的容量、溢出丢弃、shutdown flush 和错误上报语义。
- 不允许无界内存队列或未被 catch/可在进程退出时静默丢失的 fire-and-forget Promise。
- 当前依赖是否已有可复用 transport。

- [x] **Step 2: 提交取舍供 review**

只允许以下结论之一：

1. 选择维护中的 rotation transport，说明版本、维护状态、API、依赖体积、并发语义、请求路径/背压模型和测试方式。
2. 不引入依赖，明确 local adapter 仅支持单进程受控环境，并说明为何有限自维护实现比引入 transport 更合适，包括同步写或有界队列的明确选择。
3. 放弃本地 mode，只保留 off，等待后续真实 observability backend。

不得在同一 Task 中先选再实现。把 review 结论回写 design/plan 后停止。

**提交 review（审核）的结论：选择第 2 项；“单进程受控环境”精确定义为开发环境，或已审核的单节点、单 Pod、单 Node.js 进程、单 writer（写入端）受控低流量环境。** 当前部署设计以后一边界为目标，但在 Phase 3（阶段 3）验证前不得认定生产环境已经满足；该结论不授权多进程或通用生产日志能力。

- 不新增依赖。当前依赖树没有 rotation transport（轮转传输）；候选 `rotating-file-stream@3.2.9` 和 `pino-roll@4.0.0` 虽可完成常规日期/大小轮转，但不能直接满足 `O_NOFOLLOW`、exclusive create（独占创建）、只删除受管普通文件、保留天数与精确总字节双门禁和现有同步 `traceSink` 的完成/失败语义。
- Task 5（任务 5）使用 Node.js 24 内置同步文件 API（应用程序接口）实现封闭 local adapter（本地适配器），新增 runtime dependency（运行时依赖）为 0。
- 执行模型选择同步请求路径：无队列、无 worker（工作线程）、无后台 Promise（异步结果）、无 shutdown flush（关闭刷新）。`written` 只在同步追加返回后成立，`write_failed` 不向 pipeline（流水线）抛出。
- 不对每条 observation（观测）执行 `fsync`，接受节点掉电时最后少量短期观测丢失；同步文件 I/O（输入输出）会阻塞 event loop（事件循环），必须在部署 Phase 3（阶段 3）实测。成本不可接受时重新审核异步有界 transport（传输）或真实 observability backend（可观测后端），不得临时加入无界队列。
- adapter（适配器）只保证单进程内同步串行，不实现跨进程锁。RollingUpdate（滚动更新）必须证明 writer lifecycle（写入端生命周期）不重叠；否则改用 Recreate（重建更新）或真实多写入端 backend（后端）。

**Stop and report:** 方案、证据、成本、并发边界和推荐选择。等待用户明确确认。

## Task 5: Recorder 与 Bounded Local JSONL Sink

**Precondition:** Task 4 的 transport/adapter 选择已明确 review 通过；若选择“只保留 off”，跳过本 Task，并相应修订 Task 6。

**Files:**

- Create: `src/observability/recorder.ts`
- Create: `src/observability/recorder.test.ts`
- Create: `src/observability/local-sink.ts`
- Create: `src/observability/local-sink.test.ts`
- Reuse: `src/shared/json.ts`
- Modify if approved: `package.json`, `package-lock.json`

- [x] **Step 1: 写 recorder、lifecycle 与文件安全反例**

使用临时目录覆盖：

- 跨 UTC 日期轮转。
- 当前 segment 达到 byte limit 后轮转。
- 单条 observation 超过 `maxFileBytes` 被拒绝。
- cleanup 同时满足 retentionDays 和 maxTotalBytes。
- 同年龄文件按稳定顺序删除。
- 未知文件、目录、symlink、非受管文件名不删除。
- root 或 segment 为 symlink 时拒绝；新 segment 同名已存在时不覆盖。
- 新建目录和 segment 使用限制性权限，不依赖当前 shell 的宽松 umask 作为安全边界。
- segment create/append/rotate/delete 任一步失败时返回安全错误，不泄漏 observation 内容。
- 并发语义符合 Task 4 批准的边界；不通过测试伪装未支持的多进程安全性。
- sampled-out 时 redactor/projector/decoder/sink 都不被调用。
- redactor、projector、decoder 或 sink 失败时 recorder 返回安全结构化状态，不向 pipeline 抛错。
- 明确断言不存在隐式 Promise（异步结果）、队列、worker（工作线程）或 shutdown flush（关闭刷新）；`written` 只在同步 append（追加）返回后成立。
- 不对每条 observation（观测）执行 `fsync`；故障注入必须区分正常同步追加成功与进程/节点崩溃持久性，不能宣称后者已经保证。

- [x] **Step 2: 实现受控路径和 segment identity**

- root 固定在调用方提供的 observability root 下；local sink（本地写入端）只接受规范化绝对路径，Task 6（任务 6）的生产构造器使用 `resolve(process.cwd(), 'data/observability')`。
- 文件名由 UTC 日期和固定宽度序号生成。
- 只匹配受管 segment regex。
- 用 `lstat` 类语义拒绝 symlink root/segment，用 exclusive create 语义创建新 segment，并设置受限目录/文件权限。
- Linux（Linux 操作系统）生产路径使用 Node.js 24 `O_NOFOLLOW`；新 segment 使用 `O_CREAT | O_EXCL | O_APPEND | O_WRONLY | O_NOFOLLOW` 和 `0600`，目录使用 `0700`，已有 segment 打开后用 `fstat` 再确认普通文件。
- 所有 size/count 使用有限非负整数。
- writer 不接受来自 request/user input 的文件名或路径片段。

- [x] **Step 3: 实现 append、rotation、cleanup 和 recorder**

遵循 Task 4 提交审核的同步 transport（传输）语义。写入前先 strict decode observation，再复用 `src/shared/json.ts` 的 `canonicalJson()` 序列化单行 JSON；把换行计入 UTF-8（Unicode 字符编码）字节上限后同步追加。禁止新增平行 serializer、后台队列或把 write failure 回退到旧 `serving-traces.jsonl`。

cleanup 只在初始化和成功轮转后运行；删除使用普通文件检查，不跟随 symlink。

recorder 依赖通过参数注入：clock、ID factory、sampler、redactor、projector、decoder 和 sink；local sink（本地写入端）的测试通过临时目录、注入 clock（时钟）和窄文件操作适配器覆盖故障。测试不使用全局 monkey patch。对 pipeline 暴露的 trace sink 不得抛错；同步模型没有 queue/backpressure/shutdown flush（队列 / 背压 / 关闭刷新）状态。

与 transport 无关的返回/诊断状态至少区分：

```text
disabled
sampled_out
redaction_failed
projection_failed
```

同步写入定义 `written/write_failed`，不定义 `queued/queue_full`。`dropped_sensitive/dropped_invalid` 是 observation 内 question 字段的数据最小化结果，不是 recorder failure；这类 observation 可以不带 question text 而成功接受。`redaction_failed` 表示 redactor 内部错误或二次扫描未通过，此时整条 observation 不写入。所有状态和错误信号都不得携带原始 payload。

- [x] **Step 4: 验证**

```bash
npx tsx src/observability/recorder.test.ts
npx tsx src/observability/local-sink.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

**实施结果：**

- recorder（记录器）按 `disabled/sampled_out/sampling_failed/redaction_failed/projection_failed/written/write_failed` 返回固定状态；采样未命中时不读取 question，也不调用脱敏、投影、解码或 sink（写入端）。
- local sink（本地写入端）只写 strict canonical JSONL（严格规范逐行 JSON）；单条记录含换行的 UTF-8（Unicode 字符编码）字节数同时受单文件和总容量约束。
- 每个进程实例从新 segment（分段）开始，不续写无法证明上一写入端完成状态的历史末段；同进程后续追加每次使用 `O_NOFOLLOW` 打开并以 `fstat` 复核设备号、inode（索引节点）、大小和权限。
- 初始化固定 root（根目录）的设备号和 inode（索引节点），运行期间路径被替换即停止写入；新 segment 使用独占创建和 `0600`，root 使用 `0700`。
- cleanup（清理）只在初始化和轮转后执行，按 UTC（协调世界时）日历日保留期和精确总字节双门禁稳定删除最旧受管普通文件；未知文件、目录和符号链接保持不变。
- 部分写失败时回滚到上一条完整 JSONL（逐行 JSON）边界；回滚或关闭失败会 poison（毒化停写）当前实例，后续继续 fail closed（失败关闭）。不执行逐条 `fsync`，不声明节点掉电持久性。
- Node.js 24.18.0 下 22 个定向测试、130 个全量测试和 TypeScript（类型系统）检查通过；新增 runtime dependency（运行时依赖）为 0。

**Stop and report:** recorder 状态与 fail-open 边界、transport、segment 命名、rotation/retention 行为、背压/并发边界、依赖变化和测试结果。等待 review。

## Task 6: Ask 集成与运维文档

**Files:**

- Modify: `app/api/ask/route.ts`
- Modify: `src/server/pipeline-retrieval.test.ts`
- Verify: `src/retrieval/trace.ts`
- Create: `.env.example`
- Modify: `README.md`
- Modify: `docs/AI应用开发能力训练实现方案.md`

- [x] **Step 1: 写 route wiring 与 pipeline 集成反例**

覆盖：

- 默认 off 时 Ask 不创建 observation 文件。
- local 配置完整且 sample 命中时只写 strict serving observation。
- sample miss、redaction verification failure、oversized、rotation failure 和 write failure 时 Ask 仍返回检索结果。
- exact/search 均使用同一 recorder contract。
- 文件和 console 不出现 secret fixture 原值。
- serving observation 不写 `data/eval/`。

`src/server/pipeline-retrieval.test.ts` 在 pipeline 边界注入 recorder/fake sink，使用 deterministic exact/fake search 覆盖上述行为；Ask route 的薄 wiring 由静态检查和 TypeScript 类型检查保护。不为测试引入全局 monkey patch，不调用真实 embedding、rerank、answer model 或网络。

- [x] **Step 2: 集成 recorder**

- route 为每个请求生成服务端 request ID。
- module/process 级读取并校验 config；invalid config fail closed 并只报告一次安全错误码。
- `mode=off` 不传 trace sink。
- `mode=local` 传 recorder 提供的 fail-open trace sink。
- pipeline 不读取 config，不改变 retrieval 行为。
- route 只负责选择是否注入 sink；不复制 sampling、redaction、projection 或 file lifecycle 逻辑。

- [x] **Step 3: 验证 raw serving persistence API 没有回归**

确认 `src/retrieval/trace.ts` 和 Ask route 仍不存在：

- `SERVING_TRACES_PATH`
- `servingTracePath()`
- `appendServingTrace()`
- `appendTraceToPath()` / `readRetrievalTraces()`

不得为集成方便重新引入可绕过 redaction/schema 的 raw writer。eval/test 持久化继续使用它们自己的严格协议，不在 retrieval 模块恢复泛化 file helper。

- [x] **Step 4: 运维文档**

`.env.example` 和根 `README.md` 说明：

- 默认 off。
- local mode 的全部必填配置和适用边界。
- 不记录的字段。
- 采样语义。
- segment 路径、轮转、容量、保留和手动清理。
- invalid config/failure 的安全信号。
- local mode 不适用于生产多实例；生产 backend 仍未实现。

只在实现和 review 完成后更新主路线 Stage 7.2 状态，仍不得标记完整 feedback 闭环完成。

- [x] **Step 5: 全量验证**

```bash
npx tsx src/observability/redaction.test.ts
npx tsx src/observability/serving-observation.test.ts
npx tsx src/observability/config.test.ts
npx tsx src/observability/sampling.test.ts
npx tsx src/observability/recorder.test.ts
npx tsx src/observability/local-sink.test.ts
npx tsx src/server/pipeline-retrieval.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

再执行静态泄漏检查，目标是只发现测试 fixture 定义，不发现 writer/schema 中存在 raw fallback：

```bash
rg -n "queryText|selectedText|stringData|Authorization|debugRaw|rawPayload" src/observability app/api/ask
```

人工检查所有命中，禁止简单通过改名绕过。

**实施结果：**

- Ask route（询问路由）为每个有效请求生成服务端 UUID（通用唯一标识），只在完整合法的 local mode（本地模式）向 pipeline（流水线）注入 recorder（记录器）提供的同步 fail-open trace sink（失败开放轨迹写入端）；默认 off（关闭）和非法配置均不注入。
- 配置与 local sink（本地写入端）在模块初始化时建立 process-level snapshot（进程级快照）。初始化失败和每类 recorder（记录器）失败只按固定 stage/code（阶段 / 错误码）每进程报告一次；诊断回调只接收结构化状态，抛错也不能越过 Ask 成功边界。
- pipeline（流水线）反例覆盖默认 off（关闭）、local（本地）命中采样、exact/search（精确 / 搜索）共用契约、采样未命中、脱敏验证失败、单条超限、轮转失败和写入失败；检索结果不变，fixture secret（夹具密钥）不进入文件或结构化状态，且不会创建 `data/eval/` 产物。
- `.env.example` 和根 README（说明文档）记录全部配置、hard cap（硬上限）、不记录字段、采样、分段、轮转、容量、保留、人工清理、安全错误信号和单进程边界；旧 `serving-traces.jsonl` 只作为不兼容旧产物说明，不读取或迁移。
- 67 项定向门禁、131 项全量测试、TypeScript（类型系统）检查和 `git diff --check` 均通过；raw persistence API（原始持久化接口）静态查询无命中。敏感字段查询的命中只位于脱敏规则、反例 fixture（夹具）和拒绝断言，route（路由）唯一 console（控制台）输出只包含固定 stage/code（阶段 / 错误码）。

**Stop and report:** 默认开关、schema、redaction、sampling、rotation/retention、raw API 未回归、测试结果和剩余生产边界。未经用户明确确认不 commit，不进入完整 Stage 7 feedback。
