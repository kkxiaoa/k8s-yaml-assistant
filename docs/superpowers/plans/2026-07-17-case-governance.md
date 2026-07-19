# Case Governance（评估用例治理） 实施计划

> 状态：Task 1-8（任务 1-8）已完成实现与本地门禁；Task 1-5 已逐项审核，Task 6-8 等待最终 review（审核）。
> 对应设计：`docs/superpowers/specs/2026-07-17-case-governance-design.md`。
> 执行位置：Phase B（阶段 B）质量底座已实现；下一项质量主线是清理旧产物、重建索引和正式评估。

## Goal

为 retrieval、grounded answer、judge calibration、generation、fix（检索、有依据回答、裁判校准、生成、修复）建立严格的 `task/origin/role` 治理、Holdout（留出集）隔离和分桶报告，并补入第一批真实错误解释、真实 CRD（自定义资源定义）及新建 Holdout，使正式评估能够区分开发、回归和泛化结果。

## Execution Rules

- 严格按 Task 顺序执行；每个 Task 完成后停止、汇报并等待 review。
- 每个契约或选择规则先写反例测试，再实现。
- 不调用真实模型、embedding（向量嵌入）、rerank（重排）或网络。
- 不读取、迁移或兼容旧 ignored run/trace artifacts（被忽略的运行 / 轨迹产物）。
- 不重建 index（索引），不运行正式 eval（评估），不晋升 baseline（基线）。
- 不提前修改 retrieval 排名、query expansion（查询扩展）、prompt（提示词）或模型配置。
- 不手写简化 CRD schema；只复用当前 generated registry（生成注册表）中已有的完整集群 schema。
- 不把动态分桶拼成新的 metric registry keys（指标注册键）；复用当前 case 结果和指标聚合函数。
- 共享代码放无副作用模块，不从带 `main()` 的 runner 文件 import（导入）。
- 每轮修改保持 unstaged（未暂存）且 uncommitted（未提交）；未经用户明确要求不执行 `git add` 或 `git commit`。

## Task 1: 共享治理契约与现有 Case 原子迁移

**Files:**

- Create: `src/eval/cases/governance.ts`
- Create: `src/eval/cases/governance.test.ts`
- Modify: `src/eval/cases/retrieval-cases.ts`
- Modify: `src/eval/cases/grounded-answer-cases.ts`
- Modify: `src/eval/cases/generation-cases.ts`
- Modify: `src/eval/cases/fix-cases.ts`
- Modify: `src/eval/assertions.ts`
- Modify: `src/eval/cases/case-contracts.test.ts`
- Modify: `src/eval/assertions.test.ts`
- Modify: `src/eval/runner-protocol.ts`
- Modify: `src/eval/runner-protocol.test.ts`
- Modify: `scripts/eval-check.ts`
- Read only: `data/eval/bad-cases.jsonl`

- [x] **Step 1: 写治理反例**

覆盖：

- 缺失 `task/origin/role`、未知值和额外字段失败。
- `origin='bad_case'` 非 regression 失败。
- Holdout + bad_case 失败。
- retrieval 接受 error/refusal/generation/fix task 时失败。
- Generation/Fix task 与 case 类型不一致时失败。
- legacy `source` 字段被 strict contract（严格契约）拒绝，不默认映射。
- referenced grounded case（引用型有依据回答用例）解析后完整继承 retrieval governance，源对象不能另写一份覆盖值。

- [x] **Step 2: 实现共享 schema 与类型**

在 `governance.ts` 定义 Zod strict schema、推导类型和按 case family 校验的纯函数。不得在 protocol、runner 和各 case 文件重复声明枚举。

- [x] **Step 3: 一次性迁移提交用例**

- Retrieval 删除 `source`，逐 case 显式声明 governance。
- 非 policy 的旧 retrieval case 为 `field_explanation`；9 个 `policy-*` case 为 `policy_explanation`。
- design 列出的 11 个已有 bad-case 证据 ID 改为 regression；其余旧 retrieval case 为 development。
- 旧 case 的 origin 保持 `human`，不伪造 schema-generated 或 bad-case 来源。
- 引用型 grounded case 只继承；5 个 standalone refusal 自身声明 `refusal/human/development`。
- 现有 26 个 Generation 和 8 个 Fix case 声明 `human/development`，不改 requirement、fixture、assertion 或 relation（需求、夹具、断言或关系）。

- [x] **Step 4: 身份 snapshot 与本地门禁纳入治理字段**

`retrievalCaseSnapshot`、`generationCaseSnapshot` 和 `fixCaseSnapshot` 纳入 governance，使字段变化立即改变 dataset hash。resolved grounded case（解析后的有依据回答用例）携带继承的 governance，`eval:check` 输出当前 `task/origin/role` 分布并验证引用继承；Faith dataset/trace（忠实度数据集 / 轨迹）的身份联动随 schema v2 在 Task 2 原子升级，避免 schema v1 产物出现半升级协议。

- [x] **Step 5: 验证**

```bash
node --import tsx --test src/eval/cases/governance.test.ts
node --import tsx --test src/eval/cases/case-contracts.test.ts
node --import tsx --test src/eval/assertions.test.ts
node --import tsx --test src/eval/runner-protocol.test.ts
npm run eval:check
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

**Stop and report:** 枚举语义、旧 `source` 清退、11 个 regression 映射、各数据集分布与 hash 变化。等待 review。

## Task 2: Governance 贯通 Runtime Artifact Protocol

**Files:**

- Modify: `src/eval/protocol.ts`
- Modify: `src/eval/protocol.test.ts`
- Modify: `src/eval/run-session.ts`
- Modify: `src/eval/run-session.test.ts`
- Modify: `src/eval/runner-protocol.ts`
- Modify: `src/eval/runner-protocol.test.ts`
- Modify: `src/eval/retrieval-eval.ts`
- Modify: `src/eval/faithfulness-eval.ts`
- Modify: `src/eval/generation-eval.ts`
- Modify: `src/eval/fix-eval.ts`
- Modify: `src/eval/judge-eval.ts`
- Modify: `src/eval/faith-store.ts`
- Modify: `src/eval/calibration-snapshot.ts`
- Modify: `src/eval/metrics/judge-metrics.ts`
- Modify: `src/eval/artifacts.test.ts`
- Modify: `src/eval/run-store.test.ts`
- Modify: `src/eval/metrics/promotion.ts`
- Modify: `src/eval/metrics/promotion.test.ts`
- Modify: related bad-case and calibration tests

- [x] **Step 1: 写持久化反例**

覆盖：

- dataset case 缺治理字段、重复 ID、数量不一致失败。
- trace 缺治理字段失败。
- 同 ID 的 dataset/trace governance 不一致时 promotion 失败。
- 只改变 role 会改变 dataset hash。
- grounded answer snapshot（有依据回答快照）与 faith trace snapshot（忠实度轨迹快照）同时纳入 governance，重算身份必须一致。
- faith trace 和 judge calibration snapshot 丢失或篡改 governance 时失败。
- schema v1 run/trace 不被 v2 decoder 接受，不走旧字段默认回退。

- [x] **Step 2: 升级 schema v2**

- `EVAL_SCHEMA_VERSION` 提升到 2。
- `EvalDatasetIdentity.caseIds` 替换为 `cases: Array<{ id; governance }>`，避免并行保存两份 ID 列表。
- `TraceEnvelope` 增加必填 governance。
- `groundedAnswerCaseSnapshot` 与 `faithTraceCaseSnapshot` 同时纳入 governance，不在 schema v1 下只升级其中一侧。
- 更新 trace coverage、promotion、baseline copy 和所有测试 fixture。
- 不兼容 ignored v1 run/trace；后续正式评估前统一清理重建。

- [x] **Step 3: 贯通五类 runner 与派生快照**

所有 success/error envelope 都从当前 case 显式传治理信息。FaithTrace 保存 resolved governance；JudgeCalibrationCase 从 faith trace 继承；judge trace 再携带同一值。error payload 中是否包含完整 case 不作为治理证据来源。

- [x] **Step 4: 验证**

```bash
node --import tsx --test src/eval/protocol.test.ts
node --import tsx --test src/eval/run-session.test.ts
node --import tsx --test src/eval/runner-protocol.test.ts
node --import tsx --test src/eval/artifacts.test.ts
node --import tsx --test src/eval/metrics/promotion.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

**Stop and report:** schema v2 变化、dataset/trace 对齐、派生快照继承、旧 artifact 拒绝语义和受影响文件。等待 review。

## Task 3: Role-aware Suite 与 Holdout 泄漏门禁

**Files:**

- Modify: `src/eval/cases/governance.ts`
- Modify: `src/eval/cases/governance.test.ts`
- Modify: `src/eval/protocol.ts`
- Modify: `src/eval/runner-protocol.ts`
- Modify: `src/eval/runner-protocol.test.ts`
- Modify: `src/eval/retrieval-eval.ts`
- Modify: `src/eval/faithfulness-eval.ts`
- Modify: `src/eval/generation-eval.ts`
- Modify: `src/eval/fix-eval.ts`
- Modify: `src/eval/bad-cases.ts`
- Modify: `src/eval/bad-cases.test.ts`
- Modify: `src/eval/faith-bad-cases.ts`
- Modify: `src/eval/faith-bad-cases.test.ts`
- Modify: `scripts/build-calibration.ts`
- Modify: `scripts/check-schema-aliases.ts`
- Modify: `scripts/check-schema-aliases.test.ts`
- Modify: `scripts/query-expansion-ab.ts`
- Modify: `README.md`
- Modify: `scripts/README.md`

- [x] **Step 1: 写选择和泄漏反例**

覆盖：

- tuning 只选 development + regression。
- holdout 只选 Holdout；full 保持原顺序选择全部。
- 默认选择为 tuning，只有显式 `--full` 产生 `scope='full'`。
- smoke/policy 不得包含 Holdout。
- alias target 指向 Holdout 时失败。
- retrieval/faith bad-case 回灌遇到 Holdout 时不写正式 bad-case store。
- calibration label 指向 Holdout faith trace 时失败。
- baseline promotion 继续只接受 full；tuning/holdout 明确拒绝。

- [x] **Step 2: 实现统一 suite 选择**

共享 parser（解析器）和选择函数支持 `tuning | holdout | full`。Retrieval 保留 k 参数、Faith 保留 smoke/policy 诊断，但不得在各 runner 复制不同的 role 判断。`EvalScopeSchema` 增加 `tuning`、`holdout`。

- [x] **Step 3: 关闭调优与回灌通道**

- Alias target 校验读取 retrieval governance，拒绝 Holdout ID。
- A/B 脚本只消费已通过 target gate（目标门禁）的非 Holdout case。
- Retrieval full run 只允许非 Holdout miss 自动 upsert；Holdout miss 留在 trace。
- Faith bad-case converter 跳过 full run 中的 Holdout trace，holdout-only run 不生成候选。
- Judge calibration builder 拒绝 Holdout，不把泛化题变成 judge 调试题。

- [x] **Step 4: 更新命令语义**

根 README 明确：默认是 tuning；`--holdout` 只评估留出集；`--full` 只在调优冻结后执行并可进入 baseline 审核。不得把默认 tuning 仍描述成 full eval（完整评估）。

- [x] **Step 5: 验证**

```bash
node --import tsx --test src/eval/cases/governance.test.ts
node --import tsx --test src/eval/runner-protocol.test.ts
node --import tsx --test src/eval/bad-cases.test.ts
node --import tsx --test src/eval/faith-bad-cases.test.ts
node --import tsx --test scripts/check-schema-aliases.test.ts
npm run aliases:check
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

**Stop and report:** 默认 suite、显式 full/holdout 命令、scope、四条泄漏门禁和 baseline 晋升边界。等待 review。

## Task 4: 按 Task / Origin / Role 分桶报告

**Files:**

- Create: `src/eval/governance-report.ts`
- Create: `src/eval/governance-report.test.ts`
- Modify: `src/eval/retrieval-eval.ts`
- Modify: `src/eval/faithfulness-eval.ts`
- Modify: `src/eval/judge-eval.ts`
- Modify: `src/eval/generation-eval.ts`
- Modify: `src/eval/fix-eval.ts`
- Modify: `scripts/eval-check.ts`

- [x] **Step 1: 写分桶反例**

使用纯内存 case/result fixture（用例 / 结果夹具）覆盖：

- 每个 case 在每个维度恰好进入一个桶。
- selected、completed、harness error 三者可对账。
- 某桶无质量分母时显示 N/A（不适用），不能显示 0%。
- Retrieval 的 Recall/MRR、Faith 的忠实/拒答、Judge 的一致/不可判定、Generation/Fix 的内容通过率均从现有 case-level result（单用例结果）计算。
- 分桶不增加动态 metric registry key，不改变聚合指标定义。

- [x] **Step 2: 实现共享分组与格式化**

共享模块只处理治理维度、计数和调用方提供的聚合回调；具体 evaluator 继续复用已有 metric helper（指标辅助函数），不复制公式。

- [x] **Step 3: 接入五类 runner 和 eval:check**

每次运行汇总后打印三个维度。`eval:check` 无需模型即可打印提交数据分布，并明确当前没有出现的 origin/task/role，不用空桶制造 0 分。

- [x] **Step 4: 验证**

```bash
node --import tsx --test src/eval/governance-report.test.ts
npm run eval:check
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

**Stop and report:** 每类 runner 的分桶指标、N/A 分母和为何不增加动态注册键。等待 review。

## Task 5: 真实 Ask Error Explanation Cases

**Files:**

- Modify: `src/eval/cases/grounded-answer-cases.ts`
- Modify: `src/eval/cases/case-contracts.test.ts`
- Modify: `src/eval/faithfulness-eval.ts`
- Modify: `src/eval/faith-store.ts`
- Modify: `src/eval/runner-protocol.ts`
- Modify: `src/eval/runner-protocol.test.ts`
- Modify: `src/server/pipeline.ts`
- Modify: `app/api/ask/route.ts`
- Modify: `src/server/pipeline-retrieval.test.ts`
- Modify: `src/eval/answer.ts` only if obsolete eval-only prompt code can be safely retired

- [x] **Step 1: 写 pipeline parity（管线一致性）反例**

覆盖：

- `validation_error` input 引用不存在的 Fix case 时失败。
- 引用 fixture 在 preflight 中没有真实校验错误时失败。
- 手写 errors 字段被 strict schema 拒绝。
- resolved case 从 Fix fixture 得到 YAML、target 和当前 validator 真实 errors。
- Faith 对 error case 调用 `retrieveContext(..., mode='explain_error')`，并使用与 Ask route 相同的 system/prompt builder。
- 测试通过注入 search/client stub（搜索 / 客户端桩）完成，不发网络请求。

- [x] **Step 2: 提取共享 Ask prompt builder**

API streaming（流式调用）和 eval non-streaming（非流式调用）复用同一 `ASK_SYSTEM` 和用户消息构造函数；route 只负责流式传输，faith runner 不从 route 文件 import。普通 referenced/standalone faith case 也通过 `retrieveContext` 的 free mode（自由问答模式）走共享上下文选择。

- [x] **Step 3: 新增两条代表性用例**

- Deployment `spec.replicas` 字符串类型错误，引用 `fix-type-replicas`。
- StorageClass 缺少 `provisioner`，引用 `fix-missing-provisioner`。

两条均为 `error_explanation/human/development`，保存 expected chunk IDs；不复制 broken YAML 或错误消息。

- [x] **Step 4: 验证**

```bash
node --import tsx --test src/eval/cases/case-contracts.test.ts
node --import tsx --test src/server/pipeline-retrieval.test.ts
node --import tsx --test src/eval/runner-protocol.test.ts
npm run eval:check
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

**Stop and report:** fixture 复用、真实校验错误、Ask/eval prompt 与 retrieval 一致性、自动指标边界和两条 case。等待 review。

## Task 6: Curate 真实 CRD 与建立 RAG Holdout

**Files:**

- Modify: `data/schemas/curated.json`
- Modify: `src/eval/cases/retrieval-cases.ts`
- Modify: `src/eval/cases/grounded-answer-cases.ts`
- Modify: `src/eval/cases/case-contracts.test.ts`
- Modify: `src/knowledge/provenance.test.ts`
- Modify: `scripts/eval-check.ts`
- Track without modifying: `data/schemas/generated/resources/gateway.networking.k8s.io.v1.HTTPRoute.json`
- Track without modifying: `data/schemas/generated/resources/cert-manager.io.v1.Certificate.json`

- [x] **Step 1: 写真实来源与 stale refusal（失效拒答）反例**

覆盖：

- 两个目标 resource 文件必须已存在、结构非空且 `source='cluster'`。
- curated 后生成目标 chunk ID，authority 为 `cluster_api`，不得是 `kubernetes_official`。
- 新可答 question 与旧 standalone refusal 同时存在时 contract 失败。
- HTTPRoute 开发 case 和 Certificate Holdout 的 task/origin/role 正确。

- [x] **Step 2: 只扩 curated closure（精选闭包）**

把以下条目加入 `curated.crd`：

```json
{ "kind": "HTTPRoute", "apiVersion": "gateway.networking.k8s.io/v1" }
{ "kind": "Certificate", "apiVersion": "cert-manager.io/v1" }
```

不得修改或重写 generated resources/definitions/manifest（生成资源 / 定义 / 清单）。两个已存在但此前被 ignore（忽略）的目标 resource 文件必须随新增 closure（闭包）纳入 Git；其依赖 definitions 已全部提交，不额外生成文件。

- [x] **Step 3: 新增 case 并清退矛盾拒答**

- HTTPRoute `spec.rules.backendRefs.weight`：`field_explanation/human/development`。
- Certificate `spec.issuerRef`：`field_explanation/human/holdout`。
- 删除 `refusal-gateway-httproute` 和 `refusal-cert-manager`，新增同主题可答 retrieval/grounded case，不复用带 `refusal-` 的旧 ID。

- [x] **Step 4: 验证 corpus 与 identity 失效，不重建索引**

```bash
npm run schemas:check
npm run corpus:stats
npm run eval:check
npm run aliases:check
node --import tsx --test src/knowledge/provenance.test.ts
node --import tsx --test src/eval/cases/case-contracts.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

记录新旧 corpus content/manifest/index expectation hash（语料内容 / 清单 / 索引期望哈希）变化，但不调用 `index:build`。

**Stop and report:** 复用的真实 schema、provenance、增加的 chunk/case、清退的拒答、Holdout 隔离和索引失效证据。等待 review。

## Task 7: Generation / Fix 首批 Holdout

**Files:**

- Modify: `src/eval/cases/generation-cases.ts`
- Modify: `src/eval/cases/fix-cases.ts`
- Modify: `src/eval/assertions.test.ts`
- Modify: `src/eval/cases/case-contracts.test.ts`
- Modify: `scripts/eval-check.ts`

- [x] **Step 1: 写 Holdout contract 反例**

覆盖：

- 新 Generation case 的资源身份、镜像值和 selector/template label relation（选择器 / 模板标签关系）均被断言。
- 新 Fix fixture preflight 确认 HPA `spec.maxReplicas` 的真实类型错误；修复后必须保留 target ref 和 minReplicas，且无额外资源。
- 两条 case 均只被 holdout/full suite 选择，tuning 不可见。

- [x] **Step 2: 新增两条未调优 case**

- Generation：DaemonSet `daemonset-holdout`，`generation/human/holdout`。
- Fix：HPA `fix-holdout-hpa-maxreplicas-type`，`fix/human/holdout`。

只写可由现有 assertion engine（断言引擎）验证的目标值和关系；不得为提高通过率降低断言强度，也不运行模型观察结果。

- [x] **Step 3: 验证**

```bash
node --import tsx --test src/eval/assertions.test.ts
node --import tsx --test src/eval/cases/case-contracts.test.ts
npm run eval:check
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

**Stop and report:** 两条 Holdout 测量目标、断言强度、preflight 证据和 suite 隔离。等待 review。

## Task 8: 文档与最终本地门禁

**Files:**

- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/AI应用开发能力训练实现方案.md`
- Modify: `docs/superpowers/specs/2026-07-17-case-governance-design.md`
- Modify: `docs/superpowers/plans/2026-07-17-case-governance.md`

- [x] **Step 1: 核对最终事实**

使用代码输出而非计划预估值更新：各数据集数量、task/origin/role 分布、CRD 资源数、拒答数、错误解释数和 Holdout 数。记录 origin 仍缺 schema-generated/bad-case case 的事实，不为填满桶造题。

- [x] **Step 2: 更新当前执行状态与命令**

- 标记 Case Governance 已实施并逐 Task 审核。
- 根 README 说明 tuning/holdout/full 命令与费用边界。
- 唯一路线进入“清理 ignored artifacts、重建 index、依次正式评估”的下一步，但本 Task 不执行这些动作。
- 保留“错误解释自动 correctness 尚未完整覆盖”的风险，要求首次 full trace 人工审核。

- [x] **Step 3: 完整本地验证**

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npm run eval:check
npm run schemas:check
npm run aliases:check
npm run corpus:stats
git diff --check
git diff --cached --check
```

不得运行 `npm run eval*`、`npm run index:build`、模型或网络命令。

**Stop and report:** 最终数据分布、协议/命令变化、所有测试、语料与索引身份变化、自动判定边界和进入正式重建前的剩余风险。等待 review，不清理产物、不重建索引、不 commit。

## 完成记录

2026-07-19 的最终本地事实：

- Semantic Retrieval（语义检索）83 条；Grounded Answer（有依据回答）88 条，其中检索引用 83、错误解释 2、独立拒答 3；Generation（生成）27 条；Fix（修复）9 条。
- Retrieval/Grounded Answer、Generation、Fix 各有 1 条 Holdout（留出集）。所有用例 origin（来源）仍为 `human`，没有为补 `schema_generated` 或 `bad_case` 分桶新增题目。
- curated resources（精选资源）从 26 增至 28，corpus（语料）从 8,127 增至 8,410 个 chunk（知识片段）。content hash（内容哈希）为 `ae509a3b469ce6c8d6da078901eb72c4976e1a04f6ad59dc5294378d25c5042e`，manifest hash（清单哈希）为 `a8a8cfb843289b7b66b37e6864221e887942f6183da97c9848ea93ea6b689daa`。
- 默认 `voyage-3` 的 index expectation hash（索引期望哈希）为 `4edcbaf350ef50e8a2d0c8a8dc25ba3cf435fe7d6d974749470c132fa01e6274`；旧索引以 `corpus_count_mismatch` 失效，未执行重建。
- 自动错误解释评估仍不完整覆盖 correctness（正确性）；首次 full trace（完整集轨迹）需要人工审核。
