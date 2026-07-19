# Phase B 工程清理实施计划

> 状态：Task 1-3（任务 1-3）与 Deferred Risk Closure（延期风险收敛）第 1-6 项均已完成并审核；本计划完成。
> 用途：完成 Phase B（阶段 B）的测试入口、命令与脚本清单、文档状态和引用清理。
> 前置：四份 2026-07-12 质量纠偏计划的结构实现已完成；正式评估与 baseline（基线）尚未重建。
> 后续：Case Governance（评估用例治理）短设计与实施计划已落盘，当前等待审核。

## 目标

把本地工程入口收敛为可自动发现、可复现、可诊断的测试与命令说明；明确 `scripts/` 中每个脚本的生命周期和外部调用风险；修正当前文档状态与引用，使后续用例契约迁移只依赖一条有效路线。

本计划不修改评估 case contract（用例契约）、runner（运行器）判定、模型配置、检索行为、知识语料或 artifact（产物）协议。

## 当前证据

- `package.json` 的 `test` 通过 `&&` 手写串联 33 个测试文件，新增测试需要再次登记，存在漏跑风险。
- `node --import tsx --test --test-concurrency=1` 已在当前工作区自动发现并通过全部 33 个测试文件。
- `--test-name-pattern` 对当前文件顶层执行的测试没有缩小文件执行范围，不作为定向测试入口。
- `scripts/` 当前有 14 个 TypeScript 脚本，全部存在 npm script（npm 脚本）入口；当前没有足够证据直接删除任何脚本。
- `query-expansion-ab.ts` 与 `voyage-ab.ts` 是实验诊断脚本；其余脚本属于本地校验、数据维护、评估运行或人工审核工具。
- 根 `README.md` 已是唯一面向使用者的命令文档，但尚未完整列出脚本分类、写盘行为、外部调用和推荐工作流。
- `docs/README.md` 与 `AGENTS.md` 仍声称当前执行 Knowledge Provenance / Corpus Identity（知识来源 / 语料身份）计划，与实际阶段不一致。
- docs 根层文件已有状态头，`docs/doc-inventory.md` 已存在；当前需要修正事实和引用，不需要为整理目录而搬动文件。
- `package.json` 仍有多项 `latest` 依赖。本计划只记录风险，不修改依赖范围或 lockfile（锁文件）。

## 执行规则

- 严格按 Task（任务）顺序执行，每个 Task（任务）完成后停止并等待审核。
- 每个 Task（任务）的修改保持 unstaged（未暂存）且 uncommitted（未提交）；未经明确要求不执行 `git add` 或 `git commit`。
- 不调用真实模型、embedding（向量嵌入）、rerank（重排）或网络。
- 不读取或兼容 ignored run/trace artifacts（被忽略的运行 / 轨迹产物）。
- 不创建 `docs/CLI.md` 或统一 `scripts/run.ts`；根 `README.md` 继续作为唯一使用者命令入口。
- 不为分组测试自研 manifest（清单）或调度框架；定向诊断使用 Node.js 内置测试运行器的显式文件参数。
- 不删除或移动脚本，除非同一 Task（任务）内给出无 npm 入口、无当前文档引用、无测试依赖、无人工流程依赖的证据，并单独等待审核。
- 不在本计划中迁移 `task/origin/role`，不新增 error explanation（错误解释）、CRD（自定义资源定义）或 Holdout（留出集）用例。
- 不清理 index（索引）、run（运行记录）、trace（轨迹）或 baseline（基线），不执行正式评估。

## 目标状态

```text
package.json
  test -> Node.js 内置测试运行器 + tsx 加载器 + 自动发现

README.md
  稳定命令 / 维护命令 / 实验命令
  外部调用 / 写盘 / 输出 / 推荐工作流

scripts/README.md
  仅面向维护者的脚本清单和生命周期证据

docs/README.md + docs/doc-inventory.md + AGENTS.md + CLAUDE.md
  唯一当前执行状态和精确引用
```

## Task 1（任务 1）：收敛单一测试入口

**文件：**

- 修改：`package.json`
- 修改：`README.md`

- [x] **步骤 1：固化反例证据**

核对当前 `package.json` 手写测试文件列表与工作区实际 `*.test.ts` 文件。记录当前数量一致只代表暂未漏跑，不能消除新增测试需要手工登记的问题。

- [x] **步骤 2：改为标准自动发现入口**

将 `test` 收敛为：

```json
"test": "node --import tsx --test --test-concurrency=1"
```

约束：

- 使用 Node.js 内置 test runner（测试运行器），不新增 `scripts/test.ts`。
- 由 runner（运行器）自动发现 `*.test.ts`，新增测试无需修改 `package.json`。
- 暂时保持文件级串行，避免现有测试共享环境变量或临时目录时引入并发不确定性；并发优化不属于本 Task（任务）。
- 定向诊断通过显式测试文件完成，不新增自定义 group（分组）协议。

- [x] **步骤 3：更新测试命令说明**

根 `README.md` 只补以下稳定用法：

```bash
npm test
npm test -- src/retrieval/router.test.ts
```

说明默认自动发现、串行执行以及定向运行方式，不复制完整测试清单。

- [x] **步骤 4：验证**

```bash
npm test
npm test -- src/retrieval/router.test.ts
npx tsc --noEmit -p tsconfig.json
git diff --check
```

验收：

- 全量入口发现并通过全部当前测试文件。
- 定向入口只执行指定测试文件。
- `package.json` 不再手写测试文件长链。
- 没有模型、向量嵌入、重排或网络调用。

完成后停止并汇报：修改内容、为何采用标准 runner（运行器）、测试发现数量、定向运行结果和 Node.js 版本兼容风险。

## Task 2（任务 2）：收敛根命令入口与 scripts inventory（脚本清单）

**文件：**

- 新建：`scripts/README.md`
- 修改：`README.md`
- 仅在现有文件头注释不准确时修改：`scripts/*.ts`

- [x] **步骤 1：建立逐脚本证据表**

`scripts/README.md` 作为维护者清单，而不是平行 CLI 文档。每个脚本记录：

- npm 入口。
- 生命周期：稳定维护、人工审核工具、实验诊断。
- 是否调用模型、向量嵌入、重排、集群或网络。
- 是否写文件，以及主要输出位置。
- 当前引用证据与保留理由。

初始分类必须至少明确：

- `query-expansion-ab.ts`、`voyage-ab.ts` 为实验诊断。
- `generate-schema-aliases.ts` 为需要真实模型且结果必须人工审核的维护工具。
- eval、schema、corpus、index、compare、promote 与 bad-case 脚本按实际副作用分类，不能把“本地命令”等同于“只读命令”。

- [x] **步骤 2：完整根 README 命令入口**

在根 `README.md` 中按使用场景收敛命令：

- 编辑器与 CLI（命令行界面）。
- 纯本地质量门禁。
- schema / corpus / alias / index 数据维护。
- retrieval / faith / judge / generation / fix 评估。
- compare / promote / bad-case 人工审核流程。
- 实验诊断命令。

每个有风险的命令写清外部调用、主要写盘内容和不可用于 baseline（基线）晋升的边界。详细内部生命周期只链接 `scripts/README.md`，不在两处重复维护。

- [x] **步骤 3：审计脚本头部注释**

只修正已经与当前实现冲突的脚本注释，例如历史阶段编号、错误的“唯一调用额度”表述或过期路径。注释只保留用途、副作用和非显然约束，不写阶段性决策过程。

- [x] **步骤 4：给出 cleanup（清理）结论**

基于当前证据形成明确结论：

- 没有足够证据删除的脚本继续保留并分类。
- 实验脚本本轮不为目录整齐而搬动，避免制造历史引用和 package script（包脚本）路径变更。
- `latest` 依赖单列为复现风险；版本固定需单独审核，不在本 Task（任务）修改。

- [x] **步骤 5：验证**

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npm run eval:check
git diff --check
```

另做静态核对：`package.json` 中每个 `scripts/*.ts` 入口都出现在清单；清单中的路径均存在；根 `README.md` 不出现不存在的命令。

完成后停止并汇报：14 个脚本的分类、每类副作用、为何本轮不删除或移动、修正的注释、命令文档变化和依赖版本遗留风险。

## Task 3（任务 3）：Docs（文档）状态与引用清理

**文件：**

- 修改：`docs/README.md`
- 修改：`docs/doc-inventory.md`
- 修改：`AGENTS.md`
- 修改：`CLAUDE.md`
- 仅在当前引用失效或缺少状态头时修改其他 `docs/*.md`

- [x] **步骤 1：修正当前执行事实**

统一表达：

- 四份 2026-07-12 质量纠偏计划已完成结构实现与逐 Task（任务）审核。
- 当前处于 Phase B（阶段 B）工程收尾与重建尺子。
- 本计划完成后先处理 Deferred Risk Closure（延期风险收敛）待办，再进入 Case Governance（评估用例治理）设计和实施。
- 正式 baseline（基线）仍未重建或晋升。

不得继续声称正在执行 Knowledge Provenance / Corpus Identity（知识来源 / 语料身份）计划。

- [x] **步骤 2：收敛文档状态清单**

更新 `docs/doc-inventory.md`：

- 使用与文档头一致的状态名称。
- 记录当前权威级别和真实引用者。
- 已确认保留在根层的文件不继续写没有执行依据的“后续可迁移”建议。
- superpowers specs/plans（设计稿 / 实施计划）明确是设计与实施记录，只有最新且已确认的计划可作为当前 Task（任务）入口。

- [x] **步骤 3：修正引用，不做无收益搬迁**

- 将当前文档中的简写或失效路径改为实际文件路径。
- 核对 `AGENTS.md`、`CLAUDE.md`、根 `README.md` 和 docs 内部引用。
- 历史文档已有明确状态且引用有效时保留原位；本 Task（任务）不创建 `docs/current/`、`docs/learning/` 或 `docs/archive/` 目录。
- 不改写历史复盘正文中的历史指标，只保证其状态提示不会覆盖当前事实。

- [x] **步骤 4：验证**

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npm run eval:check
git diff --check
```

静态审计：

```bash
rg -n "当前执行第 2 份|当前执行 Knowledge Provenance|docs/CLI.md|Task 9/10 不再执行" AGENTS.md CLAUDE.md README.md docs
```

验收：

- 当前状态只指向 Phase B（阶段 B）和本计划。
- 旧 Task 9/10（任务 9/10）的废弃事实保留，但不会被误当成可执行任务。
- 没有新增平行 roadmap（路线图）或 CLI（命令行界面）文档。
- 没有因目录搬迁产生断链。

完成后停止并汇报：修正的状态事实、引用变化、保留未移动的历史文档、所有验证结果，以及进入 Deferred Risk Closure（延期风险收敛）前的剩余风险。

## Follow-up TODO（后续待办）：Deferred Risk Closure（延期风险收敛）

- [x] 当前计划的 Task 3（任务 3）完成后，重新核对以下风险是否已被后续改动可靠解决；已有代码和测试证据覆盖的项目只记录结论，不重复实现。仍存在的项目必须在 Case Governance（评估用例治理）之前逐项收敛，并按改动风险拆分审核：

  1. [x] `npm run ask` 已复用 `retrieveContext()` 共享检索入口和现有持久化索引身份协议。兼容索引命中时不会重新嵌入全量语料；缺失或失效时只按当前语料在内存重建，没有新增平行缓存或旧格式回退。
  2. [x] `ingest:schemas` 已使用版本化 manifest（清单）记录明确拥有的资源和定义文件，只删除上一清单拥有且当前快照不再生成的文件；未归属文件保留，同名冲突、旧清单及无清单的非空输出均在写盘前失败，不会无差别删除或自动认领。
  3. [x] 原有 13 项 `latest` 直接依赖已固定为当前 lockfile（锁文件）的既有解析版本；`package.json` 与锁文件根清单保持一致，并由测试校验无 `latest`、声明一致及精确版本与解析版本一致。本项没有升级、重新解析或安装依赖；后续安装行为仍需单独审核。
  4. [x] `aliases:generate` 只在被忽略的草稿目录独占新建带时间戳的 draft artifact（草稿产物），不再持有正式 alias registry（别名注册表）的写路径。草稿可单独做本地可追溯性校验；人工删除拒绝项并为保留项填写审核状态后，`aliases:review` 默认只预览按 ID（标识符）合并的新增、更新和未变化记录，只有显式 `--apply` 才原子更新正式注册表，且不会删除草稿未覆盖的正式记录。
  5. [x] `npm run schemas:check` 原先把只解析当前层的根节点当成整棵树已预展开，因此把 26 个精选资源的合法子节点 `$ref` 全部误报。门禁已改为按运行时惰性解析契约逐层下降，并覆盖 properties（属性）、items（数组元素）、additionalProperties（额外属性）及 `anyOf` / `oneOf` 联合分支。核对同时发现并修复两个真实缺口：缺失、非法或直接成环引用不再静默退化为空 schema（模式）；validator（校验器）开始执行联合类型分支，validation logic revision（校验逻辑版本）相应提升到 v2。当前 26 个精选资源和 1639 个本地定义通过门禁；本项没有改动 ingestion artifact ownership（摄取产物所有权）或生成数据。
  6. [x] 已在 macOS arm64、Node.js 25.6.1、npm 11.9.0 下用当前 `package.json` 和 lockfile（锁文件）执行隔离、离线且禁用安装脚本的干净 `npm ci`，稳定复现 `@emnapi/runtime@1.11.1 extraneous`。锁文件中只有两个 wasm32（WebAssembly 32 位）平台可选包引用该依赖；npm 未安装这些父包，却把其共享子依赖保留在顶层，普通 `npm ls` 因此报告安装树中的孤立可选依赖，但仍以状态码 0 结束。`npm ls --depth=0 --package-lock-only` 按声明树核对时无异常，已有测试也确认直接依赖和锁文件根声明一致。结论是当前 npm 的平台可选依赖安装与列举结果不一致，不是项目漏声明依赖；本项没有修改依赖声明、锁文件或项目 `node_modules`，也不通过增加直接依赖、`npm prune` 或重装掩盖该现象。

## 完成边界

本计划完成只表示工程入口、文档上下文和登记风险已收敛，不表示评估数据已经可重建。下一步单独审核 Case Governance（评估用例治理）的短设计与实施计划；完成 case contract（用例契约）迁移和代表性用例补充后，才允许清理 ignored artifacts（被忽略的产物）、重建 index（索引）并运行正式评估。
