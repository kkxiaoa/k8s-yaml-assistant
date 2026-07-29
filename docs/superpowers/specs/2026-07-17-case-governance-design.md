# Case Governance（评估用例治理） 设计

> 状态：已实施；Task 1-5（任务 1-5）已逐项审核，Task 6-8（任务 6-8）已完成实现与本地门禁，等待最终 review（审核）。
> 用途：定义评估用例的任务、来源、角色、选择、证据和首批代表性样本边界。
> 对应计划：`docs/superpowers/plans/2026-07-17-case-governance.md`。
> 执行位置：Phase B（阶段 B）质量底座已实现；下一项质量主线是清理旧产物、重建索引和正式评估。

## 1. 实施前问题

当前提交数据的事实是：

- Semantic Retrieval（语义检索）81 条，`source` 全为 `human`，没有任务和用途角色。
- Grounded Answer（有依据回答）86 条，其中 81 条引用 retrieval case（检索用例）、5 条独立拒答；引用关系没有治理元数据。
- Generation（生成）26 条、Fix（修复）8 条，均没有来源和用途角色。
- `EvalDatasetIdentity` 只保存 case ID、数量和 hash；`TraceEnvelope` 不保存 case 治理信息。
- 默认完整运行没有 Holdout（留出集）隔离；alias A/B（别名对比实验）、bad case（问题用例）回灌和 judge calibration（裁判校准）也无法拒绝 Holdout。
- `data/schemas/curated.json` 的 `crd` 集合为空，但 generated schema（生成的模式定义）中已存在完整、集群来源的 `gateway.networking.k8s.io/v1 HTTPRoute` 和 `cert-manager.io/v1 Certificate`，无需手写简化 CRD。
- Faith runner（忠实度运行器）只执行无编辑器上下文的搜索与回答，不能用来代表 Ask 的 `explain_error` 路径。

因此当前总指标无法回答：失败发生在哪类任务、样本是否来自已知问题、结果是调优集还是泛化检查，以及真实 CRD 和错误解释是否被覆盖。

## 2. 目标

1. 每个原始 eval case（评估用例）都有必填、严格、可持久化的 `task/origin/role`。
2. 引用型用例继承来源用例的治理信息，不复制平行字段。
3. dataset identity（数据集身份）和 trace（轨迹）保存治理信息；治理变化必须改变数据集 hash。
4. 日常运行默认不读取 Holdout；完整评估必须显式启用，且只有完整运行可晋升 baseline（基线）。
5. alias 调优、bad-case 回灌和 judge calibration 不得消费 Holdout。
6. 每个 runner 至少按 `task/origin/role` 输出分桶样本数、完成数、异常数和本类别核心质量指标。
7. 用真实 Ask pipeline（问答管线）补错误解释样本，用现有完整集群 schema 补真实 CRD 样本。
8. 给 Retrieval/Grounded Answer、Generation 和 Fix 建立首批 Holdout，不把已经用于调优的旧 case 事后改名为 Holdout。

## 3. 非目标

- 不运行真实模型、embedding（向量嵌入）、rerank（重排）或网络。
- 不清理、读取、迁移或兼容旧 ignored run/trace artifacts（被忽略的运行 / 轨迹产物）。
- 不重建索引，不晋升 baseline，不据此优化 retrieval、prompt（提示词）或模型。
- 不把 Holdout 描述成保密数据；仓库内 Holdout 是流程隔离，不是访问控制。
- 不新增任意 tags（标签）系统，不把资源类型、知识来源和用户任务混为一个枚举。
- 不声称本计划自动证明错误解释的事实正确性；首批自动门禁覆盖真实输入、检索依据和忠实度，正式 baseline 前仍需人工审核回答完整性与正确性。
- 不在本计划扩展 official docs（官方文档）或 examples（示例）provider。

## 4. 治理契约

共享 runtime contract（运行时契约）位于无副作用模块 `src/eval/cases/governance.ts`，Zod schema 是运行时校验和 TypeScript 类型的唯一来源：

```ts
interface EvalCaseGovernance {
  task:
    | 'field_explanation'
    | 'policy_explanation'
    | 'error_explanation'
    | 'free_question'
    | 'refusal'
    | 'generation'
    | 'fix';
  origin: 'human' | 'schema_generated' | 'bad_case';
  role: 'development' | 'regression' | 'holdout';
}
```

语义：

| 维度     | 含义                | 约束                                                                                             |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `task`   | 用户任务或被测能力  | `crd` 不是任务；CRD 覆盖由目标 `apiVersion/kind` 与知识 provenance（来源信息）表达               |
| `origin` | case 最初如何形成   | `human` 只表示人工精选，不宣称来自真实线上用户；`bad_case` 只用于人工审核后回灌的 case           |
| `role`   | case 在迭代中的用途 | development（开发集）用于定位，regression（回归集）用于防复发，holdout（留出集）用于低频泛化检查 |

跨字段约束：

- `origin='bad_case'` 必须搭配 `role='regression'`。
- `role='holdout'` 禁止搭配 `origin='bad_case'`。
- Semantic Retrieval 只接受 field/policy/free task（字段 / 策略 / 自由问答任务）；error/refusal/generation/fix 不得混入 Recall/MRR（召回率 / 平均倒数排名）分母。
- Generation case 的 task 固定为 `generation`；Fix case 固定为 `fix`。
- 独立拒答的 task 固定为 `refusal`；编辑器错误输入固定为 `error_explanation`。
- 字段全部必填，不提供旧 `source` 回退、默认 role 或兼容 decoder（解码器）。

## 5. 各 case contract 的归属

### 5.1 Semantic Retrieval

`SemanticRetrievalCase` 直接持有 `governance`。现有 `source` 一次性迁移为 `governance.origin` 后删除。

当前已在 `data/eval/bad-cases.jsonl` 留有明确历史证据的 11 个 case 改为 regression：

```text
pod-volumes
deploy-container-image
sts-volumeclaimtemplates
rolebinding-subjects
endpoints-subsets
pvc-volumemode
pvc-resources
sc-volumebindingmode
sc-allowexpansion
policy-conflict-latest
policy-conflict-privileged
```

它们的 origin 仍是 `human`，因为问题先由人工建立、后成为已知问题；未来从已审核 bad case 新增的用例才使用 `origin='bad_case'`。

### 5.2 Grounded Answer

- `input.kind='retrieval_case'`：从被引用 retrieval case 继承完整治理信息，源对象不再重复声明。
- `input.kind='standalone_question'`：自身声明治理信息，只允许 refusal。
- 新增 `input.kind='validation_error'`：引用已有 Fix fixture（修复夹具），保存问题和 expected chunk IDs（期望片段标识）；YAML、目标资源和 ValidationError（校验错误）在 dataset preflight（数据集预检）从真实 Fix fixture 与 validator（校验器）生成，不复制手写错误文本。

引用继承避免同一个问题在 retrieval/faith 两处出现不同 role；resolved case（解析后用例）、faith trace 和 judge calibration snapshot（裁判校准快照）都携带最终治理信息。

### 5.3 Generation / Fix

两类 case 都直接声明治理信息，并由现有 contract assertion（契约断言）强制 task 与 case 类型一致。首轮迁移不改变原有 requirement、YAML、字段断言或关系断言。

### 5.4 Judge Calibration

Judge calibration case 不是平行手写题库；它从真实 faith trace 继承治理信息。构建脚本拒绝 Holdout trace，避免把泛化样本变成裁判调试材料。

## 6. Artifact 与身份

Eval Artifact Protocol（评估产物协议）升级到 schema v2，不兼容读取旧 ignored artifacts：

```ts
interface EvalDatasetIdentity {
  id: string;
  hash: string;
  cases: Array<{ id: string; governance: EvalCaseGovernance }>;
  caseCount: number;
}

interface TraceEnvelope {
  // existing identity/outcome fields
  governance: EvalCaseGovernance;
}
```

约束：

- `dataset.cases` 顺序与实际 selection（选择集）一致，ID 唯一，`caseCount` 必须一致。
- dataset hash snapshot 包含治理信息和各 case 的完整测量契约；只改 role 也必须产生新 hash。
- trace governance 必须与 dataset 中同 ID 的治理信息完全一致；promotion（晋升）前核对。
- FaithTrace 和 JudgeCalibrationCase 同样保存治理信息，不能从未来当前 case 文件反推旧 trace。
- 不为旧 `caseIds` 或无 governance 的 trace 增加 optional（可选）字段和默认值。

## 7. Suite 与 Holdout 隔离

三种主选择集：

| suite（运行集合） | 包含 role                | 用途                 | scope（范围） | 可晋升 baseline |
| ----------------- | ------------------------ | -------------------- | ------------- | --------------- |
| `tuning`          | development + regression | 日常开发、诊断和回归 | `tuning`      | 否              |
| `holdout`         | holdout                  | 低频泛化检查         | `holdout`     | 否              |
| `full`            | 全部                     | 调优冻结后的正式评估 | `full`        | 是              |

默认 `npm run eval`、`eval:faith`、`eval:gen`、`eval:fix` 使用 tuning；`--full` 和 `--holdout` 必须显式提供。现有 faith smoke/policy（忠实度冒烟 / 策略）选择只从非 Holdout case 中取值，继续不可晋升。

Holdout 保护：

- schema alias targets（模式别名目标）和 alias A/B 不得引用 Holdout ID。
- retrieval miss 自动 upsert（更新或插入）和 faith bad-case 审核默认跳过 Holdout。
- judge calibration builder 拒绝 Holdout。
- Holdout 结果只能进入正式人工报告；若据此修改系统，必须把该 case 显式转为 regression，并补入新的未调优 Holdout。role 变化会让 dataset hash 改变。
- 这些规则防止流程误用，但不能阻止有仓库读权限的人查看 case 内容。

## 8. 分桶报告

每个 runner 使用共享纯函数按 `task/origin/role` 分组，并输出：

- selected/completed/harness error（已选择 / 已完成 / 框架异常）数量。
- Retrieval：Recall、MRR。
- Faith：faithful rate（忠实率）、refusal correctness（拒答正确率）、judge indeterminate（裁判不可判定）。
- Judge：faithful agreement（忠实度一致率）、quorum failure（法定票数失败）。
- Generation/Fix：完整内容通过率；Fix 另显示 correction/preserve/side-effect（修正 / 保留 / 副作用）通过情况。

不为每个桶动态创造新的 metric registry key（指标注册键）。聚合 run metrics（运行指标）保持现有固定注册表；dataset 和 trace 保存可重算的治理与 case 证据，runner 报告使用同一聚合函数计算分桶值。

## 9. 首批代表性样本

### 9.1 Error Explanation

首批 Grounded Answer 错误解释直接引用现有真实 Fix fixture：

- `fix-type-replicas`：解释 Deployment `spec.replicas` 类型错误。
- `fix-missing-deployment-selector`：解释 Deployment 缺少必填且须匹配 Pod 模板标签的 `spec.selector`。

runner 必须调用与 Ask API 共用的 `retrieveContext()`、`ASK_SYSTEM` 和 prompt builder（提示词构建器），mode 为 `explain_error`；校验错误由当前 validator 现场生成。它们不进入 semantic Recall/MRR。

自动指标仍以 retrieval evidence（检索依据）、faithfulness（忠实度）和拒答行为为主；错误解释是否完整指出“实际值、期望约束和修复方向”在首次正式 run 中人工审核，不把忠实度冒充 correctness（正确性）。

### 9.2 真实 CRD

复用已提交的完整集群 schema：

- `gateway.networking.k8s.io/v1 HTTPRoute`：开发集，覆盖 `spec.rules.backendRefs.weight`。
- `cert-manager.io/v1 Certificate`：Holdout，覆盖 `spec.issuerRef`。

只把它们加入 `data/schemas/curated.json` 的 `crd` 集合；不修改 generated resource（生成资源）内容，不手写少字段 schema。SchemaDoc 的 `source='cluster'` 保持不变，因此 provenance authority（来源权威）必须是 `cluster_api`，不能冒充 Kubernetes 官方内置资源或厂商文档。

现有 `refusal-gateway-httproute`、`refusal-cert-manager` 在语料加入后语义失效，必须删除并新增可答 case；不能保留相互矛盾的拒答样本。

### 9.3 Generation / Fix Holdout

- Generation：新增一个此前未覆盖的 DaemonSet 生成 case，验证资源身份、容器镜像和 selector/template label 关系。
- Fix：新增一个 HPA `spec.maxReplicas` 类型错误 case，验证修正值、target/preserve（目标 / 保留）和资源集合副作用。

两条均为新建 `origin='human'`、`role='holdout'`，不运行模型进行针对性调试。首批真实 CRD 只承诺 Ask retrieval/grounded 与 schema validation 覆盖，不借此宣称 CRD Generation/Fix 已成熟。

## 10. 完成标准

- 四类原始 case contract 全部要求治理信息，旧 `source` 和默认 role 不再被接受。
- 现有 case 完成有证据的一次性 role 映射；引用型 grounded case 无重复元数据。
- dataset、trace、faith snapshot、judge calibration 的治理信息可解析且一致。
- 默认运行排除 Holdout；显式 full 才满足 baseline scope。
- Holdout 不进入 alias 调优、bad-case 自动回灌或 judge calibration。
- 每个 runner 输出三个维度的分桶结果。
- 第一批错误解释使用真实 validator 和 Ask pipeline。
- HTTPRoute/Certificate 使用现有完整集群 schema，来源表达正确；旧拒答语义被清退。
- Retrieval/Grounded Answer、Generation、Fix 都至少有一条 Holdout。
- 全部本地测试、`eval:check`、`schemas:check`、`aliases:check` 和 TypeScript 类型检查通过；未调用外部服务、未重建索引、未运行正式评估。

## 11. 实施结果

2026-07-19 的代码输出为：

| 数据集 | 数量 | task（任务） | origin（来源） | role（角色） |
|---|---:|---|---|---|
| Semantic Retrieval（语义检索） | 83 | field_explanation=74，policy_explanation=9 | human=83 | development=71，regression=11，holdout=1 |
| Grounded Answer（有依据回答） | 88 | field_explanation=74，policy_explanation=9，error_explanation=2，refusal=3 | human=88 | development=76，regression=11，holdout=1 |
| Generation（生成） | 27 | generation=27 | human=27 | development=26，holdout=1 |
| Fix（修复） | 9 | fix=9 | human=9 | development=8，holdout=1 |

- Grounded Answer 包含 83 条 retrieval case（检索用例）引用、2 条真实校验错误解释和 3 条独立拒答。
- curated corpus（精选语料）包含 28 个资源、8,410 个 chunk（知识片段）；其中 HTTPRoute 169 个 chunk、Certificate 114 个 chunk，二者均保持 `cluster_api` authority（当前集群权威来源）。
- 语料增加后，旧 8,127 条索引以 `corpus_count_mismatch` 明确失效；本计划未重建索引。
- Retrieval/Grounded Answer、Generation、Fix 各有 1 条 Holdout（留出集），默认 tuning（调优集）不可见，只有显式 holdout/full suite（留出 / 完整评估集）可选择。
- 当前 origin 仍全部为 `human`，`schema_generated` 与 `bad_case` 为空；这是如实报告的覆盖缺口，不通过造题填桶。
- 错误解释自动门禁尚不能完整证明 correctness（正确性）和完整性。首次 full run（完整集运行）必须人工审核两条错误解释 trace（轨迹）是否指出实际值、期望约束和修复方向。
