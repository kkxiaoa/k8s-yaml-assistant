# Serving Observation Safety 设计

> 状态：已通过独立 review（审核），作为实施依据；计划 Task 1-5（任务 1-5）已完成并逐项审核；Task 6（任务 6）已完成实现与本地门禁，等待 Task 6 review（任务 6 审核）。
> 用途：定义 Ask serving observation 在本地落盘前必须满足的开关、数据最小化、脱敏、采样和生命周期契约。
> 对应计划：`docs/superpowers/plans/2026-07-14-serving-observation-safety.md`。
> 执行位置：四份 `2026-07-12` corrective plans（纠偏计划）和 Case Governance（评估用例治理）已经完成；本文与对应计划已经通过独立 review（审核）。计划 Task 1-6（任务 1-6）已关闭默认原始轨迹写入，并完成独立 strict schema（严格模式）、结构化脱敏、allowlist projection（白名单投影）、runtime config（运行时配置）、稳定采样、同步 recorder（记录器）、受控本地生命周期和 Ask（询问）接线；当前停在 Task 6（任务 6）实现审核点。

## 1. 背景与问题

本设计立项时，Ask route 无条件把 `appendServingTrace` 注入 `retrieveContext()`；exact 和 search 成功后，完整 `RetrievalTrace` 会追加到：

```text
data/observability/serving-traces.jsonl
```

该旧文件与 `data/eval/` 已完成路径分流，写入失败也不会拖垮 Ask，但当时缺少落盘前的安全与生命周期边界。Task 1（任务 1）已经关闭并退役该入口，以下内容保留为本设计要消除的原始风险：

- 没有显式启用开关，route 默认写盘。
- 没有采样。
- 没有文件轮转、容量上限、保留周期和删除机制。
- serving 持久化直接复用内存中的 `RetrievalTrace`，没有独立 runtime schema。
- `question`、`queryText`、query expansion 原始/扩展文本可能包含用户输入、selected text、validation errors、YAML 片段、Secret 或 token。
- ignored artifact 只表示不提交 Git，不代表内容已经安全或生命周期受控。

当前 trace 的数据风险如下：

| 字段 | 当前来源 | 风险 | 安全持久化决策 |
|---|---|---|---|
| `question` | 用户输入 | 可能包含 token、Secret、YAML 片段 | 仅允许保存经过验证的脱敏结果；不确定时整字段丢弃 |
| `queryText` | question + kind/version/path + selected text + errors | 混合多类原始输入，无法可靠区分边界 | 不进入 serving observation schema |
| expansion 原始/扩展文本 | `queryText` 派生 | 继承原始输入风险 | 不落盘，只保留非文本诊断元数据 |
| `selectedText` / errors / YAML | EditorContext | 可能直接包含业务配置和凭据 | 不进入本计划的持久化 schema |
| hit title / source URI | knowledge metadata | 未来 CRD/docs provider 可能包含内部名称或地址 | 不保存 title/source URI |
| hit ID / source type / authority / targets | knowledge identity | 可能暴露内部 CRD/策略名称，但不含 chunk text | 作为受保留周期约束的诊断元数据保存 |
| latency / cache / scores | 运行诊断 | 低内容风险 | 保存 |
| answer / usage / cost | 当前 Ask serving trace 未记录 | 后续可能包含敏感生成内容 | 本计划不新增；由完整 Stage 7 另行设计 |

## 2. 目标

1. serving observation 默认不落盘，只有通过 runtime 校验的显式配置才能启用。
2. serving 持久化使用独立、严格、版本化的 runtime schema，不直接序列化 `RetrievalTrace`。
3. 按 allowlist 投影数据；原始 YAML、selected text、errors、answer、chunk text 和 source URI 不进入 schema。
4. 用户 question 只能以经过验证的脱敏结果保存；脱敏失败时丢弃字段或整条 observation，禁止回退原文。
5. 采样决策不读取用户内容，并且对同一 request ID 稳定。
6. 本地文件必须有明确的轮转、容量、保留和删除边界。
7. observation 的配置、脱敏、采样或写入失败不影响 Ask 主流程，但必须产生不含原始 payload 的安全错误信号。
8. serving observation 与 eval run/trace 协议保持分离。

## 3. 非目标

- 不建设远程 observability backend。
- 不建设 UI feedback、Generate/Fix 采纳信号或审核式回灌。
- 不把 serving observation 伪装成 `EvalRun` 或 `TraceEnvelope`。
- 不实现完整请求回放；安全 observation 不承诺保存重放所需的原始 YAML、selected text、errors 或 answer。
- 不为 ignored 的旧 `serving-traces.jsonl` 增加兼容 reader 或迁移逻辑。
- 不改变 retrieval 排名、prompt、模型、eval case 或 baseline。
- 不把本地 JSONL writer 描述为生产级多进程日志系统。

## 4. 安全不变量

### 4.1 默认关闭

配置使用判别式 runtime contract：

```ts
type ServingObservationConfig =
  | { mode: 'off' }
  | {
      mode: 'local';
      sampleRate: number;
      maxFileBytes: number;
      maxTotalBytes: number;
      retentionDays: number;
      maxInputBytes: number;
      maxTextBytes: number;
    };
```

约束：

- 未配置时是 `{ mode: 'off' }`。
- `mode=local` 时所有数值字段必须显式提供并通过范围、一致性和有限数校验；禁止使用隐藏默认值补齐不完整配置。
- `sampleRate` 范围是 `[0, 1]`；size 字段是正安全整数，`maxFileBytes <= maxTotalBytes`、`maxTextBytes <= maxInputBytes`。
- schema 还施加不受环境变量放大的 hard cap：`maxInputBytes <= 256 KiB`、`maxTextBytes <= 16 KiB`、`maxFileBytes <= 128 MiB`、`maxTotalBytes <= 1 GiB`、`retentionDays` 为 `1..30` 的整数。
- 这些值是防止 parser、内存和本地磁盘被配置放大的安全天花板，不是隐藏运行默认值；需要更大边界时应重新 review 存储方案，不仅修改环境变量。
- 非法配置 fail closed：recorder disabled，Ask 继续，进程只输出一次不含环境变量值和用户数据的错误码。
- 本地文件根目录固定为项目的 `data/observability/`，本计划不开放任意绝对路径环境变量。
- `.env.example` 只说明变量名和安全语义，不包含真实凭据或可被误认为生产推荐值的占位配置。

### 4.2 独立持久化协议

内存中的 `RetrievalTrace` 继续服务 eval 和调用方诊断；serving 落盘前必须投影为独立 schema：

```ts
interface ServingRetrievalObservation {
  schemaVersion: 'serving-observation/v1';
  observationId: string;
  requestId: string;
  createdAt: string;
  kind: 'retrieval';
  route: {
    mode: 'free' | 'explain_field' | 'explain_error';
    path: 'exact' | 'search';
    resourceHint?: string;
    apiVersionHint?: string;
    fieldPathHint?: string;
  };
  query: {
    disposition: 'redacted' | 'dropped_sensitive' | 'dropped_invalid';
    text?: string;
    redactionVersion: 'serving-redaction/v1';
    redactionLabels: string[];
  };
  queryExpansion?: {
    enabled: boolean;
    status: 'applied' | 'no_match' | 'disabled' | 'skipped_exact' | 'failed';
    routedResource?: string;
    selectedResource?: string;
    resourceSelectionReason?:
      | 'same_resource'
      | 'no_route_strong_alias'
      | 'cross_resource_strong_alias'
      | 'weak_alias_no_resource_override'
      | 'no_alias_match';
    registryHash?: string;
    reviewedAliasCount?: number;
    errorCode?: 'aliases_missing' | 'aliases_invalid';
    matches: Array<{
      chunkId: string;
      resource: string;
      path: string;
      strength: 'weak' | 'strong';
    }>;
  };
  ranking: {
    coarse: ServingHitReference[];
    rerank: ServingHitReference[];
    final: ServingHitReference[];
  };
  latencyMs: {
    embed?: number;
    dense?: number;
    rerank?: number;
    total: number;
  };
  cache?: {
    embeddingHit?: boolean;
    index:
      | { status: 'hit' }
      | { status: 'rebuilt'; reason: ServingIndexMissReason }
      | { status: 'not_used' };
  };
}

interface ServingHitReference {
  id: string;
  sourceType: 'schema' | 'policy' | 'docs' | 'example';
  authority:
    | 'kubernetes_official'
    | 'cluster_api'
    | 'extension_provider'
    | 'organization'
    | 'curated';
  version?: string;
  targets: Array<{ apiVersion?: string; kind: string; path?: string }>;
  score?: number;
}

type ServingIndexMissReason =
  | 'missing_files'
  | 'incomplete_files'
  | 'read_error'
  | 'format_mismatch'
  | 'invalid_manifest'
  | 'corpus_count_mismatch'
  | 'corpus_content_mismatch'
  | 'corpus_manifest_mismatch'
  | 'embedding_model_mismatch'
  | 'index_hash_mismatch'
  | 'chunk_count_mismatch'
  | 'invalid_chunk'
  | 'duplicate_chunk_id'
  | 'embedding_dimension_mismatch'
  | 'invalid_embedding';
```

最终字段以 implementation 时的 Zod strict schema 为准。上述结构的关键约束是：

- 不包含 `queryText`、expansion 原始/扩展文本、`selectedText`、errors、YAML、answer、chunk text、hit title 或 source URI。
- `ServingHitReference` 只保留 chunk ID、source type、authority、version、targets 和有限 score。
- `ServingIndexMissReason` 是 serving schema 内的封闭枚举，不用任意字符串接收上游新值；上游 reason 扩展时必须显式升级并 review 持久化协议。
- schema 拒绝未知字段，防止未来给 `RetrievalTrace` 新增内容后被自动带入 serving artifact。
- `requestId` 与 `observationId` 由服务端生成，不直接信任客户端 header。
- 所有字符串、数组、score 和 latency 都有显式长度、数量和有限数边界；hint、target 和 ID 不符合受控格式时忽略或拒绝整条 observation，不将任意客户端字符串当成低风险 metadata。
- runtime schema 验证跨字段不变量：只有 `redacted` 允许 query text，`failed` expansion 必须有封闭 error code，其他 expansion status 禁止 error code，cache reason 只属于 `rebuilt`。
- 写盘前再次 runtime decode，禁止只依赖 TypeScript 类型。

### 4.3 结构化脱敏

脱敏发生在 JSON 序列化和 sink 写入之前，不对序列化后的整行 JSON 做字符串替换。

question redactor 至少覆盖：

- Kubernetes `Secret` YAML/JSON 中的 `data`、`stringData` 和 token 类字段。
- `Authorization`、Bearer token、JWT、PEM private key、常见 API key/token/password 赋值形式。
- URL userinfo 和敏感 query parameter。
- 脱敏输出超过 `maxTextBytes` 时，在完成脱敏后再按 UTF-8 字节边界截断，避免先截断输入破坏敏感模式识别。

安全策略：

1. 输入超过 `maxInputBytes` 时直接丢弃 question 字段；安全上限在 runtime schema 中还必须有不可超越的 hard cap。
2. 能结构化解析的 YAML/JSON 使用不含自定义 tag 的 safe schema，并在受控深度、节点数和别名边界内递归脱敏；JSON-compatible 结构复用 `src/shared/json.ts` 的 `canonicalJson()` 生成规范化文本，不再实现平行 canonicalizer。
3. 普通自然语言执行受控的 token/credential redaction。
4. 看起来包含 Secret/YAML/credential、但无法安全解析或验证的输入，整字段标记为 `dropped_sensitive`，不保存原文；这是可预期的数据最小化结果，其他安全 metadata 仍可持久化。
5. redactor 输出必须经过第二次敏感模式扫描；扫描未通过或 redactor 内部失败时丢弃整条 observation。
6. redaction error 只记录阶段和错误码，禁止把输入片段、解析器上下文或环境变量值写到 console。
7. 不提供 `raw`、`debugRaw` 或“脱敏失败后保留原文”的开关。

redaction labels 只使用固定枚举，例如 `k8s_secret`、`bearer_token`、`jwt`、`private_key`、`credential_assignment`、`url_credential`、`truncated`；不得把匹配到的原值写入 label。

### 4.4 采样

- request ID 在 route 入口由服务端生成。
- 对 request ID 计算 SHA-256，把前 64 bit 按 unsigned big-endian 整数除以 `2^64` 映射到 `[0, 1)`；结果小于 `sampleRate` 才继续构造 observation。算法固定后以测试向量锁定，不依赖 Node 进程的非稳定 hash。
- `sampleRate=0` 永不持久化，`sampleRate=1` 对所有符合安全条件的请求持久化。
- 采样在 observation 子系统投影、复制或脱敏用户内容之前完成；sampled-out 请求不进入持久化投影。Ask 主流程本身仍需使用 question，这不是采样所能改变的边界。
- 本计划不提供按问题、资源、用户、错误内容或 outcome 的内容感知采样，避免在采样层复制敏感数据或形成隐式偏差。

### 4.5 本地文件生命周期

本地 sink 仅服务显式启用的开发环境，或满足单节点、单 Pod、单 Node.js 进程、单 writer（写入端）约束的受控低流量生产环境：

- 文件按 UTC 日期和受控序号命名，例如 `serving-observations.2026-07-14.0001.jsonl`。
- 达到 `maxFileBytes` 或日期变化时轮转；单条 observation 大于上限时拒绝写入，不生成超限文件。
- cleanup 在 recorder 初始化和成功轮转后执行，不在每次 append 时扫描目录。
- 同时执行 `retentionDays` 和 `maxTotalBytes` 两个上限，先删除最旧的受管 segment。
- observability root 必须是不经 symlink 的真实目录；目录和新 segment 使用限制性权限，新 segment 以 exclusive create 打开，不覆盖已有文件。
- 只处理固定目录下、匹配受控文件名且为普通文件的 segment；不跟随 symlink，不删除未知文件。
- 删除失败不影响 Ask，但输出安全错误码；失败后不得通过删除未知文件来补偿容量。
- 当前无界的 `serving-traces.jsonl` 视为旧 ignored artifact，不读取、不迁移；启用新 sink 前由操作者显式清理。

#### 4.5.1 Task 4 transport 与执行模型决策

结论：不新增 rotation transport（轮转传输）依赖；Task 5（任务 5）使用 Node.js 24 内置 `node:fs` 实现范围封闭的 synchronous local adapter（同步本地适配器）。该结论只服务本节列出的单进程边界，不把适配器描述为通用日志系统或多写入端生产后端。

2026-07-21 核对证据：

| 候选 | 当前事实 | 与本项目契约的差距 | 结论 |
| --- | --- | --- | --- |
| 当前依赖树 | `package.json` / `package-lock.json` 没有文件轮转或日志 transport（传输） | 无可直接复用实现 | 不增加无关日志框架 |
| [`rotating-file-stream@3.2.9`](https://github.com/iccicci/rotating-file-stream) | 仍在维护，无 runtime dependency（运行时依赖），支持 size/UTC interval/maxSize（大小 / 协调世界时周期 / 总大小）和 history（历史清单） | API 是异步 `Writable`（可写流）；文档没有提供本计划要求的 `O_NOFOLLOW`、exclusive create（独占创建）、受管文件普通文件复核和 symlink-safe cleanup（符号链接安全清理）保证；保留天数和失败状态仍需自维护包装 | 不引入；仅复用其“单条 write 不跨文件拆分”等设计参考 |
| [`pino-roll@4.0.0`](https://github.com/mcollina/pino-roll) | 当前版本依赖 `date-fns` 和 `sonic-boom`，常规用法还引入 Pino（日志库）；支持 size/frequency/count（大小 / 周期 / 数量）轮转和 worker transport（工作线程传输） | cleanup（清理）以文件数量为主，没有本计划的保留天数与精确总字节双门禁；worker（工作线程）会引入队列、flush（刷新）和 shutdown（关闭）语义，仍不能替代符号链接与受管删除验证 | 当前低流量单写入端收益不足 |
| [Node.js 24 `node:fs`](https://nodejs.org/docs/latest-v24.x/api/fs.html) | 项目已固定 Node.js 24.18.0；内置同步 API（应用程序接口）提供 `O_EXCL`、`O_NOFOLLOW`、`O_APPEND`、文件描述符、`lstat`/`fstat` 和显式 mode（权限模式） | 轮转与清理逻辑需要项目实现，但可以只实现已审核的固定文件名、容量和删除契约 | 选择；新增 runtime dependency（运行时依赖）为 0 |

同步执行模型固定如下：

1. `traceSink` 保持现有同步 `void` 契约；被采样请求在 retrieval（检索）返回前同步完成 redaction/project/decode/canonical JSONL/append（脱敏 / 投影 / 解码 / 规范逐行 JSON / 追加）。
2. 不创建内存队列、worker（工作线程）、后台 Promise（异步结果）或 timer-driven writer（定时写入端），因此没有 `queued` 冒充 `written`、队列溢出或进程退出前隐式 flush（刷新）问题。
3. `written` 只表示同步 append（追加）已被操作系统接受；不对每条 observation 执行 `fsync`，不承诺节点掉电时最后少量未落盘数据的 crash durability（崩溃持久性）。这类短期 observation 允许丢失且不做长期备份。
4. 所有 adapter（适配器）异常必须在 recorder（记录器）边界转换为 `write_failed` 等安全状态，不能从同步 `traceSink` 抛出并影响 Ask；错误不得包含 payload（负载）、环境变量值或文件内容。
5. 同步文件 I/O（输入输出）会阻塞 Node.js event loop（事件循环）；当前以低流量、单副本和小型本地 PVC（持久卷声明）接受该成本，Phase 3（阶段 3）必须实测追加延迟和 event-loop delay（事件循环延迟）。若影响 Ask 验收，不得改成无界队列，必须重新 review（审核）异步有界传输或真实 observability backend（可观测后端）。

Task 5（任务 5）的文件边界固定为：写入前 strict decode（严格解码），复用 `canonicalJson()` 序列化并追加一个换行；按 UTF-8（Unicode 字符编码）字节数在写入前判断单条和 segment（分段）上限；新分段以 `O_CREAT | O_EXCL | O_APPEND | O_WRONLY | O_NOFOLLOW` 和 `0600` 创建，目录使用 `0700`；已有分段重新打开时使用 `O_NOFOLLOW` 并以 `fstat` 确认为普通文件。cleanup（清理）只接受固定正则命名、`lstat` 确认为普通文件的受管分段，按注入 clock（时钟）的 UTC（协调世界时）日期、序号和稳定次序执行 `retentionDays` 与 `maxTotalBytes`，未知文件、目录和 symlink（符号链接）一律不删除。测试通过临时目录、注入 clock/ID factory（时钟 / 标识生成器）和窄文件操作适配器覆盖失败路径，不修改全局对象。

并发边界固定为一个 Node.js 进程内的同步串行写入；不实现跨进程锁、共享 history file（历史清单）或多 writer（写入端）协调。生产单副本 RollingUpdate（滚动更新）仍必须在部署 Phase 3（阶段 3）证明 writer lifecycle（写入端生命周期）不重叠；不能证明时改用 Recreate（重建更新）或真实多写入端 backend（后端）。出现多副本、`cluster`/worker process（集群 / 工作进程）、无中断更新、跨节点、集中查询或审计要求时，本地适配器立即退出适用范围。

#### 4.5.2 Task 5 实施结果

Task 5（任务 5）已按上述边界实现 `recorder.ts` 与 `local-sink.ts`，但尚未接入 Ask route（询问路由）：

- recorder（记录器）先按服务端 request ID（请求标识）采样，命中后才读取 question 并执行脱敏、allowlist projection（白名单投影）、二次 strict decode（严格解码）和同步 append（追加）；任何阶段异常只返回固定安全状态。
- sink（写入端）只接受规范化绝对 root（根目录）；初始化固定目录设备号和 inode（索引节点），运行期间目录身份变化、root/受管 segment（分段）为符号链接或权限过宽时停止写入。
- 新进程总是创建下一序号 segment（分段），不续写无法证明上一写入端完成状态的历史末段；同进程追加使用 `O_NOFOLLOW` 打开并以 `fstat` 复核同一普通文件。
- 轮转由 UTC（协调世界时）日期、`maxFileBytes` 或 `maxTotalBytes` 压力触发；清理按 UTC 日历日保留期，再按日期和固定宽度序号稳定删除最旧受管普通文件。
- 单次写入允许短写重试；任一后续写失败会用 `ftruncate` 回滚到上一条完整 JSONL（逐行 JSON）边界。回滚或关闭失败会使实例进入只失败、不继续写入的 poison（毒化停写）状态。
- 实现不含队列、worker（工作线程）、后台 Promise（异步结果）、timer（定时器）、shutdown flush（关闭刷新）或逐条 `fsync`，新增 runtime dependency（运行时依赖）为 0。

### 4.6 失败语义

```text
config invalid
  -> recorder disabled + safe signal

sampled out / mode off
  -> no projection, no file

redaction/project/decode failed
  -> drop observation + safe signal

rotation/write/cleanup failed
  -> drop observation + safe signal

all observation failures
  -> Ask retrieval/answer flow unchanged
```

错误信号只能包含：固定 error code、阶段、时间和非敏感计数；不能包含 question、query、YAML、selected text、errors、answer、文件内容或环境变量值。重复失败按固定 code 限频或聚合，避免文件系统异常放大为无界 console 日志。

## 5. 组件边界

建议模块边界：

```text
app/api/ask/route.ts
  -> resolveServingObservationConfig()
  -> createServingObservationRecorder(config)
  -> recorder.traceSink(requestId)

src/server/pipeline.ts
  -> 始终返回完整内存 RetrievalTrace
  -> 不知道采样、脱敏、轮转和保留策略

src/observability/serving-observation.ts
  -> strict schema / projection / runtime decode

src/observability/redaction.ts
  -> question redaction / verification / labels

src/observability/sampling.ts
  -> content-independent stable sampling

src/observability/recorder.ts
  -> fail-open composition / safe status / transport adapter

src/observability/local-sink.ts
  -> JSONL append / rotation / retention / safe deletion
```

约束：

- eval runner 继续使用 run-scoped `TraceEnvelope` 和严格 artifact writer，不复用 fail-open serving recorder。
- serving recorder 可以消费 `RetrievalTrace`，但只通过显式投影生成持久化数据。
- pipeline 不读取 serving observation 环境变量，避免 serving 策略污染共享 retrieval 行为。
- 单元测试直接测试纯投影、redactor、sampler 和 local sink，不从带 `main()` 的 runner import。

## 6. 执行顺序

### 6.1 立即安全隔离

对应 implementation plan Task 1：

- 从 Ask route 移除当前 raw `appendServingTrace` 注入。
- 从 `src/retrieval/trace.ts` 删除 raw file append、默认 serving path 和旧 JSONL reader，避免留下可绕过后续 schema/redaction 的导出 API。
- 保留 `retrieveContext()` 返回的内存 trace，不改 retrieval 行为。
- 本 Task 不新增临时环境变量或 unsafe opt-in。runtime config 在 Task 3 按最终判别联合一次实现。
- 在安全 observation schema、脱敏、采样和生命周期实现完成前，所有本地 serving 持久化保持关闭。
- pipeline 测试用内存 fake sink 验证可注入契约，不再把 raw JSONL helper 伪装成 eval writer。eval 仍由自己的 strict run-scoped artifact writer 负责持久化。

Task 1（任务 1）的实施遵守先审核、后进入下一 Task（任务）的门禁；当前历史状态以本文顶部为准。

### 6.2 Task 1 审核后

Task 1 review（任务 1 审核）通过后，依次实施：

1. serving observation strict schema 与 allowlist projection。
2. question redaction 和安全失败。
3. content-independent sampling。
4. 轮转 transport 与请求路径执行模型决策，然后实现 recorder、本地生命周期和受控删除。
5. route 集成、运维文档和完整反例。

只有上述全部通过 review 后，`mode=local` 才成为合法配置。完整 Stage 7 feedback 仍按主路线后续执行。

## 7. 反例验收

- 未配置 observation 环境变量时，Ask 不创建 `data/observability` 文件。
- 配置缺少 sample/size/retention 任一字段时 fail closed，不使用默认值补齐。
- question 超过输入 hard cap 时不进入 parser/redactor，不保存原文。
- question 中的 Secret `data/stringData`、Bearer、JWT、private key、password/API key/token 原值不出现在任何文件或错误日志。
- 疑似 Secret/YAML 解析失败时不保存原文。
- observation schema 拒绝 `queryText`、selected text、errors、YAML、answer、chunk text、title 和 source URI。
- `sampleRate=0/1` 边界正确，同一 request ID 的采样结果稳定。
- sampled-out 请求不调用 redactor 或 writer。
- 文件跨 UTC 日期或超过字节上限时轮转，单条超限时拒绝写入。
- retention cleanup 不删除未知文件、目录或 symlink。
- observability root 是 symlink 或 segment 同名已存在时 fail closed，不覆盖文件。
- config、redaction、decode、rotation、write、cleanup 任一异常时 Ask 仍返回原检索结果。
- serving observation 不写入 `data/eval/`，eval runner 不读取 serving observation。
- 旧 `serving-traces.jsonl` 不被读取或迁移。

## 8. 风险与取舍

- 默认关闭会暂时减少真实 Ask 观测，这是在安全能力完成前的显式取舍，不以保留未脱敏数据换取可观测性。
- 文本脱敏无法证明识别所有业务秘密，因此采用 allowlist、二次扫描和不确定即丢弃，而不是承诺无损保存。
- 本计划不承诺通用 PII 去标识化；保留脱敏 question 的 local mode 只适用于明确授权的受控环境，不得因为未命中 credential 规则就将文本视为非敏感。
- 过度脱敏或整字段丢弃会降低 bad-case 诊断价值；完整 feedback 候选需要在 Stage 7 另行设计受控存储和人工授权。
- 本地轮转 sink 只适用于受控单进程环境。需要生产多实例、集中查询或审计时必须接真实 observability backend，不扩展本地 adapter 冒充生产方案。
- request correlation 在本计划中只使用服务端随机 ID；跨服务传播、用户身份关联和 answer feedback correlation 不在本轮范围。
