# AI 应用开发能力训练实现方案

> 状态：当前执行依据。
> 最近核对：2026-07-29。
> 用途：维护当前能力状态、质量门禁和唯一执行顺序。具体数据契约由已确认的 design/spec 定义，不在本文重复维护。

## 1. 项目目标

本项目的第一目标不是做成完整 K8s AI 产品，而是：

**用 K8s YAML Authoring Copilot 这个真实场景，训练可迁移的 AI 应用开发能力。**

当前价值主张：

**在编辑器里，基于当前 YAML 和已摄取的知识来源，提供带依据、可拒答、可校验的字段解释、错误解释、生成与修复辅助。**

训练范围包括：

- schema、docs、policy、examples 的摄取与知识建模。
- semantic retrieval、query expansion、rerank 与上下文选择。
- grounded answer、拒答、引用和多来源冲突表达。
- Generate/Fix 的结构化输出、校验和 repair loop。
- eval、trace、baseline、bad case 与反馈回灌。
- 延迟、token、成本、缓存和失败诊断。

当前不承诺：

- 集群运行时排障、日志和事件分析。
- 自动执行 `kubectl` 或自治运维。
- 多集群治理和完整企业权限体系。
- 覆盖所有 Kubernetes/CRD 资源的成熟产品体验。

## 2. 执行原则

1. **先修尺子**：evaluator 或数据契约不可信时，不优化模型，不晋升 baseline。
2. **证据驱动**：功能、检索策略和知识源扩展必须由场景缺口或 bad case 触发。
3. **评估分层**：retrieval、grounded answer、judge、generation、fix 使用各自明确的 case contract，不用一个超大可选字段结构混算指标。
4. **线上线下共实现**：eval 与 serving 复用同一 semantic retrieval、query expansion、rerank 和来源格式化实现，但按测量对象使用不同 evaluator。
5. **来源不混淆**：知识形态、权威来源和适用资源分别建模，policy 不冒充 Kubernetes 官方事实，example 不替代 schema 校验。
6. **失败显式化**：来源不足、模型错误、judge 不可判定和基础设施异常必须分别记录，不能用默认成功值掩盖。
7. **反过拟合**：已知 bad case 用于回归，不用同一批调优样本证明泛化；保留不参与日常调参的 holdout。
8. **反玩具**：不以硬编码特例、简化 fixture、截断语料或送分题换取表面跑通。
9. **不维护无价值兼容**：ignored artifacts 可清理重跑；提交数据只做一次性迁移，迁移后删除旧兼容分支。
10. **方案先行**：每项能力先确认 design/spec，再拆 plan；每个 Task 完成后停下 review，未经用户要求不提交。

## 3. 当前事实快照

### 3.0 当前执行状态

以下状态是当前主线和停止点的唯一摘要；运行证据与完整步骤保留在直接引用的实施计划中，不在其他入口文档复制。

- Production Deployment（生产部署）的私有部署阶段已按审核结论收敛。2026-07-29 用户确认以 `docs/superpowers/specs/2026-07-29-public-experience-control-design.md` 和对应实施计划取代尚未部署的 oauth2-proxy（认证代理）、`private/portfolio`（私有 / 作品集展示）双模式及 `set-access-mode`（设置访问模式）候选。新的 Task 16-17（任务 16-17）统一公开界面、30 天匿名低额度完整体验、任意 GitHub（代码托管平台）用户登录增额、持久个人额度、Open Showcase Mode（开放展示模式）、Sleep Mode（休眠模式）和全局费用预算；控制库 OBS（对象存储服务）备份因数据价值低且运维复杂度高，在部署前从候选清退，回答反馈也明确不进入本阶段。匿名身份只使用服务端签名 Cookie（浏览器标识）和匿名化账本，不声称防机器人。体验状态现按 `ask`、`generate`、`fix` 分别表达真实运行时依赖和各自点数：Voyage（向量服务）不可用不再连带关闭只依赖 DeepSeek（回答模型）的 `generate`、`fix`。修订后的本地候选已通过完整本地门禁和用户 review（审核），Task 18（任务 18）质量审核随后按独立授权执行。公网身份仍为 `120.46.57.214` 与 `/k8s-yaml-assistant`，域名只作为未来备选。真实 GitHub OAuth callback（开放授权回调）、公开入口、发布与部署均未创建或执行。
- 四份 2026-07-12 纠偏计划、Phase B（阶段 B）工程清理和 Case Governance（评估用例治理）已经完成结构实现与审核；2026-07-29 已使用发布候选的精确 8,410 条索引执行新版本完整模型评估，因人工审核未通过而未晋升任何 baseline（基线）。
- `v0.1.0` 已携带 8,410 条正式索引和六项发布证据完成不可变发布，并通过运行 `30265452918` Attempt 5（第 5 次尝试）首次部署到私有 K3s（轻量 Kubernetes）。随后发现的 production observation root（生产观测根目录）权限阻断已由卷内 `0700` 私有子目录修复，修复随 `v0.1.1` 源提交 `ac9eb22100e300e8b3babd3bdc26ad8e45ea169d` 发布。
- 经本次明确授权，精确绑定该源提交、包含六项发布证据的 `v0.1.1` 已于 2026-07-28 Publish（正式发布）并创建实际不可变标签。`Deploy published release`（部署已发布版本）运行 `30296287472` Attempt 1（第 1 次尝试）及 GitHub deployment（GitHub 部署记录）`5628234264` 均成功。随后人工确认回滚 Release（发布版本）`360812512` 已 Publish（正式发布），运行 `30325880287` Attempt 1（第 1 次尝试）及 GitHub deployment（GitHub 部署记录）`5633580284` 把生产回滚到 `v0.1.0`。经再次明确授权，恢复 Release（发布版本）`360824879` 已于 `2026-07-28T03:56:06Z` Publish（正式发布）；运行 `30327301138` Attempt 1（第 1 次尝试）及 GitHub deployment（GitHub 部署记录）`5633826683` 均成功，生产当前恢复并固定在 `v0.1.1` 镜像摘要 `sha256:9d734264c4df1257d25a478e612ff2c3cbf61b1c918504e0da3a65e650cebe37`，仓库 `Latest`（最新发布）仍为普通 `v0.1.1` Release（发布版本）。
- 因跨境 GHCR（GitHub 容器镜像仓库）冷拉取过慢且 SWR（华为云容器镜像服务）企业版仍待审批，本次在 Publish（正式发布）前使用一次性临时路径：本机按精确摘要拉取 `linux/amd64` 镜像，生成保留根摘要的 OCI archive（开放容器镜像归档），校验归档哈希后经 SSH（安全远程登录）传输并导入节点。临时认证文件和两端归档均已删除，节点保留当前生产所需的已导入内容；该路径不替代后续同区域镜像分发方案。
- 当前固定单副本 Deployment（工作负载）为 `1/1` 可用，Pod（容器组）重启为 `1`，且只来自本次获授权的节点重启，稳定观察期内没有继续增加。生产 runner（运行器）服务为 `active/enabled`（运行中 / 开机自启），GitHub（代码托管平台）显示在线空闲，操作标记不存在。公网 80/443/6443 仍不可达，没有 Ingress（入口）；容器保持非 root（非超级用户）、只读根文件系统、零 Linux capability（Linux 能力）和未挂载 ServiceAccount token（服务账户令牌）。
- `v0.1.1` 的非模型验收已确认 live/ready（存活 / 就绪）和 `/api/check`，8,410 条镜像内索引身份、哈希与零在线重建，以及 `/app/data/observability/segments` 为 `10001:10001 0700` 且不再出现 `root_unsafe`。经另行授权完成 1 个非敏感 `/api/ask` 请求：HTTP 200、两个预期来源、回答引用完整，精确字段路径证明未进入 Voyage embedding/rerank（Voyage 向量嵌入 / 重排）。生产写入的 1 条 `0600 10001:10001` 严格观测记录不含当前 YAML（配置文件）、提示词或回答。回滚到 `v0.1.0` 后应用按已知边界再次以 `root_unsafe` 安全关闭观测；恢复到 `v0.1.1` 后私有子目录、权限和正常观测边界重新生效，启动日志不再出现 `root_unsafe`，既有分段在整个往返过程中保持 1,170 字节、1 行且权限和所有者不变。回滚和恢复过程均没有模型调用。16 MiB 轮转、7 天 / 256 MiB 清理、人工删除和符号链接拒绝仍只有与 `v0.1.1` 源码一致的本地门禁，没有生产实证。
- Step 6（步骤 6）当前没有合格真实故障候选，不制造生产故障；Step 7（步骤 7）的标签保护、两次人工 Publish（正式发布）、节点本地镜像命中、生产回滚、恢复和台账闭环已经完成。成功台账当前有四个事件、两个不同摘要，最新事件精确绑定恢复运行 `30327301138/1` 且 `action=rollback`；生产运行器在线空闲，操作标记不存在。Step 8（步骤 8）也已在独立授权下完成：重启前创建并上传数据库与服务端令牌分离备份 `20260728T041517Z-8d2b24cc-0d2d-4954-9997-ce6b2f1aa3e6`，管理员回读核对三项摘要一致；节点重启后 boot ID（启动标识）变为 `b9e5a5c6-b52f-4fb3-9a4d-1d54bc971a71`，K3s（轻量 Kubernetes）、运行器和应用自动恢复，`root:root 0700` 运行时目录按规则重建。节点直接复用本地 `v0.1.1` 镜像，台账、操作标记、观测分段和索引身份均未变化，没有重复部署、模型调用或在线索引重建。2026-07-28 独立审核已接受 Step 5（步骤 5）的部分验收边界和 Step 6（步骤 6）的明确延期风险，Task 7 Step 9（任务 7 步骤 9）事实状态同步完成；这不表示真实观测生命周期或自动恢复生产演练已经完成，也不授权公开入口、模型调用、索引重建或 baseline（基线）晋升。
- Task 15（任务 15）中严格请求契约、有界请求体、短窗口限速/并发、模型紧急开关、上游超时/重试、输出和序列化字节边界继续作为新方案输入。旧身份头、单用户允许名单、`ACCESS_MODE`、认证代理、双模式路由、访问模式发布授权和适配器扩展只形成过本地候选，从未部署，现由新设计直接替代，不保留运行时兼容分支。
- 新 Task 16-17（任务 16-17）以应用内 GitHub OAuth 2.0（开放授权协议）、`normal|interview|sleep` 全局状态、SQLite（嵌入式数据库）额度/费用账本和统一公开页面为边界。匿名浏览器在 30 天签名身份有效期内获得 7 点模型体验包，`check` 不扣点；任意登录用户获得独立每日额度，管理员只绕过个人额度并可切换开放展示或休眠。控制库只保存低价值状态且新库默认休眠，不增加异地备份或备份故障反向门禁。Task 18（任务 18）已完成正式运行和人工审核；后续检索复测关闭了当时唯一失召回，新增跨资源契约又暴露四条检索问题。Generation/Fix（生成 / 修复）用例和裁判联合蕴含边界已经完成非模型修尺，但回答忠实度、裁判稳定性、跨资源检索及修订后 Generation/Fix 的模型表现尚未复测，继续阻断公开发布。回答反馈、后续模型调用和索引身份变化仍需后续 Task（任务）或单独授权。
- Task 18（任务 18）先删除已确认的旧 8,127 条索引和 `.next` 构建产物，再从当前生产镜像摘要 `sha256:9d734264c4df1257d25a478e612ff2c3cbf61b1c918504e0da3a65e650cebe37` 提取并校验 8,410 条候选索引；没有调用 `index:build`。五类成功运行依次为 retrieval（检索）`2026-07-29T10-27-35-327Z`、faith（忠实度）`2026-07-29T10-38-42-300Z-full`、judge（裁判）`2026-07-29T11-04-44-208Z-judge`、generation（生成）`2026-07-29T11-22-41-770Z-generation` 和 fix（修复）`2026-07-29T11-24-08-465Z-fix`；首次 faith（忠实度）运行 `2026-07-29T10-29-48-748Z-full` 因内部 embedding（向量）字段越过 trace（轨迹）边界失败，最小边界修复通过 317 项完整测试后重新运行成功，失败产物按协议保留且未复用。
- Task 18（任务 18）首次人工审核确认：83/88/20/27/9 条成功运行与 trace（轨迹）可对账，Holdout（留出集）未进入校准或自动回灌，两条错误解释正确且完整，85 个带回答来源的用例引用编号均与 source snapshot（来源快照）一致，未发现真实凭据或生产敏感 YAML（配置文件）。当次阻断项为：retrieval（检索）仍有 `policy-conflict-privileged` 失召回；faith（忠实度）仅 64/82，另有 18 条有来源幻觉和 6 条裁判不可判定；judge（裁判）100 次投票含 19 次无效、4 个不可判定、2 个不稳定及 `rolebinding-roleref` 标签/判定歧义；Generation/Fix（生成 / 修复）虽机器指标全通过，但 `job-basic`、`hard-cronjob-full` 在命令未定义时自行补出命令，`fix-missing-provisioner` 只验证字段存在且输出值无法从输入确定。运行协议尚未贯通 raw usage/cost（原始用量 / 费用），只能对账请求次数，不能给出实际费用。Faith bad case（忠实度问题用例）只完成无写入预览；现有 retrieval bad case（检索问题用例）的复发证据作为工作区差异等待 review（审核），没有自动回灌、提交或 baseline（基线）晋升。当时决定先审核并修正上述评估用例/裁判边界，再另行授权必要的模型复测；不得直接进入公开发布。
- 2026-07-29 经本次明确授权修复 `policy-conflict-privileged`：既有 reviewed alias（已审核别名）只增加真实复发短语，唯一匹配字段路径复用现有软加权；dense retrieval（稠密检索）继续使用扩展问题，alias 命中的 rerank（重排）改用原始问题、命中路径及既有标题。82 条 tuning A/B（调优集对照评估）为 Recall@3 `100.0%`、MRR `0.927`、零 Recall lost case（召回损失用例）。正式 full retrieval（完整检索）运行 `2026-07-29T12-20-24-990Z` 使用相同 8,410 条索引和模型身份，83 条 trace（轨迹）完整，Recall@3 从 `82/83` 提升为 `83/83`，MRR@3 保持 `77/83`；目标策略位于第 2，Holdout（留出集）仍为第 1，harness error（评估框架错误）为 0，未新增 bad case（问题用例）。对应既有问题用例已人工标记为 `fixed`，回答来源契约同步收紧为 schema + policy（结构定义与组织策略）均必需。该运行尚未晋升 retrieval baseline（检索基线）；faith、judge、generation、fix（忠实度、裁判、生成、修复）的既有阻断不变，仍不得进入公开发布。
- 2026-07-29 新增五条跨资源检索契约，覆盖 Ingress 到 Service/Secret、RoleBinding 到 Role/ClusterRole/ServiceAccount、HPA 到 Deployment、Pod 到 PVC/ConfigMap/Secret，以及 PVC 到 StorageClass。Control（对照组）完整运行 `2026-07-29T13-08-18-747Z` 复用同一 8,410 条索引，88 条 trace（轨迹）完整，Recall@3 为 `97.0%`（`85.333/88`）、MRR@3 为 `0.915`（`80.5/88`）、harness error（评估框架错误）为 0；原有 83 条全部通过，新契约中 Ingress 通过，其余四条形成真实 bad case（问题用例）。随后仅对五条目标契约执行 Candidate（候选组）定向 A/B Test（对照实验）：Ingress、HPA 通过，Pod、RoleBinding、PVC 仍分别只命中 `1/3`、`1/2`、`1/2`。该候选已触发“任一目标失败即舍弃”的门禁，多资源软提示、规范资源名补词和直接父 schema（结构定义）补候选代码及专用测试均已撤销；没有继续执行 88 条 Candidate（候选组）完整运行，也没有晋升 baseline（基线）。五条评估契约、Control（对照组）运行证据及四条问题账本保留，用于证明单一路由不是唯一缺口，父子字段粒度和 rerank（重排）选择仍需先澄清。
- 2026-07-29 完成 Task 18（任务 18）非模型修尺：`job-basic` 与 `hard-cronjob-full` 的需求和断言现共同固定单个 `busybox` 容器及精确 `command` 数组，不再把模型自行补出的命令计为成功；不可从输入确定 `provisioner` 值的 `fix-missing-provisioner` 已替换为真实缺少 `spec.selector` 的 `fix-missing-deployment-selector`，修复值由现有 Pod 模板标签和 schema（模式定义）的匹配约束唯一确定，对应错误解释契约同步更新。`rolebinding-roleref` 的人工标签明确记录 S1/S3 联合依据，Judge（裁判模型）提示词改为接受多片段无歧义联合蕴含，同时禁止把问题本身当事实依据；calibration snapshot（校准快照）仅从既有正式 Faith trace（忠实度轨迹）重建，没有模型调用。88/88/27/9 条评估契约预检和 317 项完整测试通过，TypeScript（类型系统）检查及差异格式检查通过。该记录只证明尺子已修正；尚未执行新的 faith、judge、generation、fix（忠实度、裁判、生成、修复）模型运行，未重建索引或晋升 baseline（基线）。

以下语料、索引和评估数字已于 2026-07-29 按最新本地契约重新核对；它们都不是永久规格，若与命令输出冲突，以命令输出为准。

### 3.1 Corpus

运行：

```bash
npm run corpus:stats
```

当前结果：

- `8,410` chunks。
- `28` 个 curated resources。
- `8,368` schema chunks。
- `42` policy chunks。
- 已注册 provider：`schema`、`policy`。
- 尚未注册真实数据 provider：`docs`、`example`。
- `data/schemas/curated.json` 显式包含 2 个真实集群 CRD（自定义资源定义）：`gateway.networking.k8s.io/v1 HTTPRoute` 和 `cert-manager.io/v1 Certificate`。
- corpus identityVersion（语料身份版本）为 `2`，manifest hash（清单哈希）为 `82621edc73530dffc86e21fe6488a332e98f7d2e1efba3d0d995e7b66fb880c4`。
- 本地 `data/index` 已从当前生产 `v0.1.1` 镜像的固定摘要直接提取，不是重新构建：共 `8,410` chunks，格式 v5、knowledge identity v2（知识身份版本 2），默认 `voyage-3` 的 index expectation hash（索引期望哈希）为 `fc5b2110fea1339106aacc3829ac19404dab4dc1c9d81ae26c63fa11119ed15a`，与镜像内正式索引一致。

### 3.2 Eval 数据

当前数据集由 `npm run eval:check` 核对：

| 数据集 | 数量 | task（任务） | origin（来源） | role（角色） |
|---|---:|---|---|---|
| Semantic Retrieval（语义检索） | 88 | field_explanation=79，policy_explanation=9 | human=88 | development=76，regression=11，holdout=1 |
| Grounded Answer（有依据回答） | 88 | field_explanation=74，policy_explanation=9，error_explanation=2，refusal=3 | human=88 | development=76，regression=11，holdout=1 |
| Judge Calibration（裁判校准） | 20 | field_explanation=9，policy_explanation=9，refusal=2 | human=20 | development=18，regression=2 |
| Generation（生成） | 27 | generation=27 | human=27 | development=26，holdout=1 |
| Fix（修复） | 9 | fix=9 | human=9 | development=8，holdout=1 |

- Grounded Answer 由 83 条 retrieval 引用、2 条真实 validation error（校验错误）解释和 3 条独立拒答组成。
- Retrieval/Grounded Answer 的 Holdout（留出集）是 `Certificate.spec.issuerRef`；Generation 是 DaemonSet；Fix 是 HPA `spec.maxReplicas` 类型修复。
- 当前 origin 仍缺 `schema_generated` 和 `bad_case` 样本。这是实际分布，不为填满分桶新增送分题。
- 错误解释自动门禁覆盖真实 Fix fixture（修复夹具）、validator（校验器）、Ask 检索与 Faithfulness（忠实度）；2026-07-29 已逐条人工确认两条错误解释的 correctness/completeness（正确性 / 完整性）。
- 资源值断言、跨资源关系、修复保留/副作用检查和 fixture preflight（夹具预检）已进入 evaluator（评估器）；首次 full run（完整集运行）的机器指标虽然全通过，人工审核仍发现未定义命令和不可判定目标值可绕过现有断言，因此该指标尚不能作为 baseline（基线）。

### 3.3 能力状态

| 能力 | 状态 | 当前边界 |
|---|---|---|
| Monaco YAML 工作流与 `ask/check/gen/fix` | 已完成基础闭环 | 继续以编辑器 YAML authoring 为唯一产品场景 |
| schema ingestion、`$ref` registry、curated corpus | provenance、targets、版本化 ID 和 corpus/index identity 已纠偏 | 尚未接入 docs/example provider，真实 CRD 样本不足 |
| dense retrieval、rerank、query expansion serving | 原有 83 条保持全通过；新增五条跨资源契约的 Control（对照组）通过一条 | 多资源提示与父 schema 补候选方案未通过定向门禁并已撤销；四条跨资源问题待重新设计 |
| run/trace/baseline/bad case | runtime protocol、metric registry、compare/promote 门禁已实现并完成首次正式运行 | 本轮 baseline 全部拒绝；usage/cost 尚未贯通 |
| Generation/Fix repair loop | full run 的结构、值、关系、保留项和副作用机器指标全通过 | 人工审核发现用例/断言有效性缺口，需修尺子后复测 |
| `[S]` 引用、schema/policy 分层 | 85 个带来源回答的引用编号和快照结构均对齐 | Faithfulness（忠实度）为 64/82，另有 18 条有来源幻觉、6 条不可判定；answer correctness 与 claim-level verification 未完成 |
| Stage 6 policy | 已完成 Ask 侧接入 | docs/examples 与 Generate/Fix policy compliance 未完成 |
| Stage 7 离线 feedback | retrieval/faith bad case 前置和首次无写入候选预览已完成 | 候选仍须人工治理；serving feedback、采纳信号和审核式回灌未完成 |

## 4. 当前质量契约

本节只维护稳定原则。字段级契约以 `docs/superpowers/specs/2026-07-12-*.md` 为准。

### 4.1 Eval Artifact Protocol

一次 eval 的证据链必须是：

```text
dataset/config/model/corpus identity
  -> EvalRun
  -> per-case TraceEnvelope
  -> metrics
  -> baseline / bad case
```

要求：

- `EvalRun` 是判别联合，`kind/status/scope/dataset/artifactPaths` 等关键字段不可静默缺失。
- run 只保存相对 `data/eval/` 的可移植路径。
- 每条 trace 有稳定 `traceId/runId/evalCaseId/kind/outcome`。
- runner 启动先写 `running`，完成写 `completed`，异常写 `failed`。
- run、trace、baseline、bad case 读取都经过 runtime decoder。
- bad case 只引用可解析的真实 trace，不承担临时 trace 的职责。
- serving trace 与 eval artifact 分流；serving trace 写入失败不能拖垮 Ask。

设计依据：

- `superpowers/specs/2026-07-12-eval-artifact-protocol-design.md`

### 4.2 Metric Semantics

每个稳定指标必须定义：

- 测量对象和 evaluator kind。
- 越高越好、越低越好或 neutral。
- 单位、分子和分母。
- 空样本时是 `N/A`，不能伪装为 0% 或 100%。

Compare 和 baseline 要求：

- dataset hash、metric definition version 或 kind 不一致时，不输出改进/退化结论。
- baseline 有而当前缺失的稳定指标属于 harness 缺口，不能静默跳过。
- 所有 runner 在写 completed run 前统一校验 metric registry、required completeness、observation contract 和 definition version。
- retrieval、faith、generation、fix 只允许 full run 晋升；judge 只允许完整 calibration run 晋升。
- 只有 `completed`、trace selection 完整且 harness error 为 0 的 run 才能晋升；不提供 error override。
- baseline 晋升始终由人工显式执行。
- baseline 只保存 dataset、metrics 和参与比较的 config identity，不引用 source run/trace 路径。

设计依据：

- `superpowers/specs/2026-07-12-eval-metric-semantics-design.md`

### 4.3 Evaluator Validity

#### Semantic Retrieval

- 使用 self-contained question 评估 `searchCorpusTraced()`。
- 测量 dense、routing、query expansion、coarse candidate 和 rerank 的 Recall/MRR。
- 不注入 `EditorContext`，不把 exact-field 短路计入 semantic retrieval 指标。

#### Editor Context Retrieval

- `kind + cursorPath -> exact-field -> fallback search` 是 serving 分流能力。
- 当前使用确定性 pipeline 测试覆盖，不单独建立 run/baseline。
- 只有出现大量 serving bad case、需要统计 exact/fallback rate 或离线回放时，才新增独立 ServingRetrieval evaluator。

#### Grounded Answer

- 可以引用 retrieval case，但必须显式声明期望行为和必需来源类型。
- trace 保存实际发送给生成和 judge 的 context/source snapshot，不能从未来 corpus 重建旧上下文。
- Faithfulness、answer correctness、relevance、completeness 和 refusal correctness 是不同维度，不能用 faithful 一个指标代替全部答案质量。

#### Judge

- 严格解析输出，字符串布尔值、缺字段和非法数组项都是无效票。
- 记录计划票数、有效票、失败票和失败原因。
- 默认 5 票，至少 3 票有效才形成结论；平票返回不可判定。
- 新维度先用真实 pipeline 样本进行人工校准，再进入正式指标。

#### Generation/Fix

- Generation 断言绑定到明确资源，既检查 path，也检查值、集合和跨资源关系。
- 一致性检查先确认参与资源存在且唯一，缺少关系任一端都失败。
- Fix 在调用模型前执行 fixture preflight，确认输入确实包含声明缺陷。
- Fix 同时检查目标资源、预期修正、意图保留和额外副作用。
- YAML parse 和 schema validation 只证明结构合法，不等同于 admission、运行时或业务语义正确。

设计依据：

- `superpowers/specs/2026-07-12-evaluator-validity-design.md`

### 4.4 Eval 数据治理

Case 至少有三个独立维度：

| 维度 | 建议值 | 用途 |
|---|---|---|
| task | field、error、free、refusal、crd、generation、fix | 区分测量对象 |
| origin | human、schema_generated、bad_case | 说明样本来源 |
| role | development、regression、holdout | 区分调优、回归和泛化验证 |

规则：

- schema 派生题用于覆盖诊断，不与真实用户问题混成唯一总指标。
- bad-case case 用于证明问题不再复发，不单独证明方案可泛化。
- holdout 不参与日常 prompt、alias、boost 或 rerank 调参。
- 每次报告至少按 task/origin/role 分桶，不能只展示一个整体 Recall。
- 数据集变化必须产生新 hash；新旧数据集不能直接宣称指标提升。

## 5. 知识与检索架构

### 5.1 Knowledge Model

知识形态和权威来源分开建模：

- `sourceType`：`schema | docs | policy | example`。
- `provenance`：Kubernetes 官方、当前集群、厂商、组织或人工 curated。
- `targets`：成对记录 `apiVersion/kind/path`，不再并行维护多套 resource/path 字段。

Corpus 与索引要求：

- provider 产出覆盖提供方身份和完整 canonical chunks（规范知识片段）的 manifest hash（清单哈希），corpus manifest hash（语料清单哈希）只组合排序后的 provider manifest hash（提供方清单哈希）。
- chunk ID 在全 corpus 唯一，并区分必要的 source/apiVersion/kind/path。
- 任意 chunk 内容或 metadata（元数据）变化都会更新 corpus/index identity（语料 / 索引身份）；当前没有独立向量复用身份，索引失效后按完整产物重建。
- serving、eval、index build、corpus stats 共用同一 identity 实现。
- CRD schema 不得标成 Kubernetes 内置官方 schema。

设计依据：

- `superpowers/specs/2026-07-12-knowledge-provenance-corpus-identity-design.md`

### 5.2 Source Authority

不存在统一的 `policy > schema > docs > examples` 排序。来源按事实域分工：

| 问题 | 主要依据 | 约束 |
|---|---|---|
| 字段是否合法、类型、枚举、required | 与目标版本匹配的 schema | 只说明结构事实 |
| 行为语义、使用条件、限制 | 与目标版本匹配的官方 docs | 不覆盖 schema 结构事实 |
| 平台推荐、禁止、合规要求 | organization policy | 必须明确是组织规则 |
| YAML 写法与组合方式 | 可追溯 example | 示例不能替代事实或校验 |

检索排序负责相关性，生成层负责来源分工和冲突表达。只有 bad case 证明 top-k 容量竞争时，才设计 source quota 或 source-aware selection。

### 5.3 Ingestion 要求

新增 docs/examples provider 前必须定义：

- 来源 URI、文档锚点、版本、采集时间和许可证边界。
- 与目标 Kubernetes/schema 版本的匹配规则。
- chunking、去重、更新、删除和重建策略。
- 内容清洗和 prompt injection 边界，检索内容始终作为数据而不是系统指令。
- 对应的 retrieval、grounded-answer 或 Generation/Fix eval case。

资源覆盖继续通过 ingestion pipeline 和 generated registry 扩展，不手工维护大规模 schema。

### 5.4 Retrieval 决策

当前保留：

- dense retrieval。
- resource/path 软加权。
- Voyage rerank。
- reviewed alias 驱动的跨语言 query expansion。
- serving 与 eval 共用 semantic retrieval 实现。

后续规则：

- 先在纠偏后的 evaluator 下复测历史 retrieval/rerank bad case。
- 只有仍稳定复现的 rerank miss 才进入 rerank 候选、打分或父子 chunk 竞争优化。
- alias 只按真实 bad case 和高价值工作流字段分批扩展，每批必须经过人工 review 和 full eval A/B。
- BM25/RRF 只在同语言关键词、标识符或枚举精确匹配型失召回被 trace 证明后实施。
- 不因“Hybrid 是常见做法”而无条件引入。

## 6. 能力阶段状态

Stage 是能力分类，不代表执行时序。

| Stage | 能力主题 | 当前状态 | 未完成出口 |
|---|---|---|---|
| 0 | Scope 与评估代表性 | curated 28 resources、治理分层、首批 Holdout 和新版本 full run 已落地 | 修正人工审核发现的用例有效性缺口后复测 |
| 1 | YAML Copilot 工作流 | 基础闭环完成 | 持续保持 editor-context 场景，不扩张产品叙事 |
| 2 | 质量工程底座 | artifact/metric/evaluator/provenance/governance 契约已纠偏并完成首次正式运行 | 修正审核阻断后重建正式 baseline；贯通 usage/cost |
| 3 | 检索优化 | query expansion 已落地；跨资源多提示与父 schema 补候选方案已实测淘汰；Hybrid 未触发 | 先解释四条跨资源 bad case 的字段粒度与重排契约，再选择新方案 |
| 4 | Generate/Fix | case contract、关系断言、fixture preflight、指标语义和首次 full run 已完成 | 修正命令未定义与目标值不可判定用例，再复测并审核 baseline |
| 5 | Grounding/Judge | `[S]` 引用和 policy judge 基础已有，首次 full run 已暴露稳定性缺口 | 修正 18 条有来源幻觉与 judge 不可判定/歧义；answer quality 分维度；Claim-level Grounding |
| 6.1 | Policy | Ask 侧已完成 | Generate/Fix policy lint 需独立设计 |
| 6.2 | Official Docs | 未开始 | provider、版本化 ingestion、behavior eval |
| 6.3 | Examples | 未开始 | provider、Generation/Fix 接入与收益评估 |
| 7.1 | 离线 feedback | retrieval/faith bad-case 前置已有 | 在新 artifact 协议下重验 |
| 7.2 | 反馈闭环成熟化 | 未开始 | serving feedback、采纳信号、审核式回灌和对比报告 |

## 7. 唯一执行顺序

### Phase A：质量底座纠偏（结构实现完成）

1. 已完成：四份 2026-07-12 纠偏设计及其一对一实施计划已交叉自审并落盘。
2. 已完成：Eval Artifact Protocol（评估产物协议）已实施并完成审核。
3. 已完成：Knowledge Provenance / Corpus Identity（知识来源 / 语料身份）与 Evaluator Validity（评估器有效性）已实施并完成逐任务审核。
4. 已完成：Metric Semantics（指标语义）注册表、N/A（不适用）/ 分母、比较、晋升和全评估框架本地门禁已经实施并完成逐任务审核；正式 baseline（基线）重建不属于结构实现完成条件。
5. 当前边界：已执行首次真实模型完整评估，人工审核未通过，未晋升任何 baseline（基线）；不根据机器满分或旧指标优化检索、提示词或模型。
6. 已完成提交数据的一次性 canonical identity（规范身份）迁移；ignored runs/traces（被忽略的运行 / 轨迹产物）不兼容读取，正式评估前按当前身份清理重建。

### Phase B：工程收尾与重建尺子（结构完成，正式重建暂缓）

1. 已完成：收敛 test runner（测试运行器）、根 README 命令入口和 scripts inventory（脚本清单）；当前没有证据支持删除脚本，不新增平行 CLI（命令行界面）文档。
2. 已完成：清理 docs（文档）状态和引用，不让历史文档覆盖当前路线。
3. 已完成：工程清理登记的 Deferred Risk Closure（延期风险收敛）第 1-6 项均已核对、处理并完成审核。
4. 已完成：Case Governance（评估用例治理）已贯通 case contract、artifact、suite、泄漏门禁和分桶报告。
5. 已完成：补入 2 条真实错误解释、2 个真实 CRD（自定义资源定义）主题和 Retrieval/Grounded Answer、Generation、Fix 的首批 Holdout（留出集）。
6. 已完成：清理确认范围内的 ignored artifacts（被忽略产物），复用与发布候选完全一致的 8,410 条 index（索引），并依次运行 retrieval、faith、judge、generation、fix（检索、忠实度、裁判、生成、修复）评估；没有重建索引。
7. 已完成首次 full（完整集）评估的 metrics/trace/bad case（指标 / 轨迹 / 问题用例）人工审核。错误解释、引用编号、Holdout（留出集）隔离和敏感信息检查通过；检索、忠实度、裁判稳定性和 Generation/Fix（生成 / 修复）用例有效性存在阻断，明确拒绝本轮所有 baseline（基线）晋升。
8. 当前边界：原有 83 条 retrieval（检索）用例保持全通过；五条新增跨资源契约的 Control（对照组）暴露四条问题用例，多资源提示与直接父 schema 补候选方案未通过定向 A/B Test（对照实验）并已完整撤销。Generation/Fix（生成 / 修复）用例和 Judge（裁判模型）的联合蕴含边界已完成非模型修尺。当前没有 baseline（基线）晋升；下一步先继续澄清跨资源父子字段检索尺子并诊断四条问题用例，faith/judge/generation/fix（忠实度 / 裁判 / 生成 / 修复）的真实模型复测必须另行授权。

### Production Deployment（生产部署，当前优先插入主线）

1. 已完成并审核：`superpowers/specs/2026-07-19-k3s-production-deployment-design.md` 的 Phase 0-3（阶段 0-3）明确华为云单机 K3s（轻量 Kubernetes）、GHCR（GitHub 容器镜像仓库）、单人 draft Release（草稿发布版本）人工确认、生产 self-hosted runner（自托管运行器）、镜像内置索引和安全 observation（观测）边界；其中未部署的 Phase 4-5（阶段 4-5）双访问模式候选已被 2026-07-29 公共体验控制设计替代。
2. 已完成并审核：Phase 0（阶段 0）本地与服务器只读审计；Phase 1（阶段 1）的固定版本 K3s（轻量 Kubernetes）变更包、安装加固和节点外分离备份。非敏感证据记录在 `deploy/k3s/README.md`。
3. Phase 0-2（阶段 0-2）、特权 deployment adapter（部署适配器）Task 1-7（任务 1-7）和 Task 14（任务 14）的私有发布、部署、人工回滚、恢复及节点重启证据已经完成实现与审核；Step 5（步骤 5）的长期观测生命周期保持部分验收，Step 6（步骤 6）的真实自动恢复演练因没有合格候选明确延期。在线索引使用共享连续 `Float32Array` 和 fail-closed（失败关闭）加载，并通过文件哈希验证 `chunks.jsonl` 和 `embeddings.f32`。
4. 新 Task 16-17（任务 16-17）的本地身份、三态控制、额度/费用、统一页面和直接入口候选已经按 `superpowers/specs/2026-07-29-public-experience-control-design.md` 与对应计划完成并通过 review（审核），控制库 OBS（对象存储服务）备份已在部署前清退，三项模型操作状态也已按 DeepSeek（回答模型）与 Voyage（向量服务）的真实依赖拆分。Task 18（任务 18）正式质量审核未通过；后续关闭了当时唯一的 retrieval（检索）失召回，但新增跨资源尺子又暴露四条问题用例，首个候选方案已经按门禁淘汰。Generation/Fix（生成 / 修复）用例和 Judge（裁判模型）判据已完成非模型修尺，但尚未模型复测，仍未晋升新 baseline（基线）。全部质量阻断复测通过或形成显式风险接受记录前不进入公开发布。OAuth App（开放授权应用）、真实 GitHub callback（开放授权回调）、候选发布、安全组、证书管理器安装、Kubernetes（容器编排系统）写入、后续模型调用和节点重启仍须分别获得授权。
5. 部署完成后返回 AI 应用训练主线；部署不把项目扩张为通用 Kubernetes 运维平台。

### Phase C：剩余质量债

1. 贯通 embedding、rerank、answer、judge 的 raw usage，并记录 pricing/version 后再计算 cost。
2. 在新 baseline 下重新判断仍存在的 retrieval/rerank bad case。
3. 有证据时设计 rerank 优化；无同语言关键词证据时继续不做 BM25/RRF。
4. 按 ROI 扩展 reviewed alias，不做 Pod/Deployment 全字段 alias。

### Phase D：Stage 6.2 Official Docs

1. 从 schema 无法回答的行为语义、使用条件和限制 case 出发定义范围。
2. 实现 versioned docs provider、manifest、chunking、引用锚点和更新策略。
3. 增加 docs retrieval 与 grounded-answer cases。
4. 证明新增知识源提高目标 case，且不破坏 schema/policy 分层。

### Phase E：Stage 6.3 Examples

1. 选择可追溯、版本匹配的 YAML example 和反例。
2. examples 进入统一 corpus，但按 task-aware context selection 服务 Generate/Fix。
3. 用资源值断言和跨资源关系 eval 验证收益。
4. 若 policy 需要约束 Generate/Fix，另设 policy lint/compliance 层，不塞进 schema validation。

### Phase F：Stage 5.3 Claim-level Grounding

1. 定义可解析的 claim 与 citation reference。
2. 实现 claim extraction、claim-source verification 和 unsupported claim 输出。
3. 对 claim extractor 和 verifier 分别校准，避免用未经验证的 LLM judge 验证另一个 LLM。
4. 同时报告 groundedness、correctness、relevance、completeness 和 refusal correctness。

### Phase G：Stage 7 反馈闭环成熟化

当前安全 Ask serving observation（询问在线观测）子能力已完成实现并通过部署 Task 6 review（任务 6 审核）；这不修改上方 Stage 7.2（阶段 7.2）的“未开始”状态。该子能力也不包含 answer feedback（回答反馈）、Generate/Fix（生成 / 修复）采纳信号、审核式回灌或闭环报告。

1. 定义 serving observation envelope 和 request correlation，不复用 eval run 语义。
2. 记录 query、source、answer、latency/cost 前先实现 Secret/token/YAML 敏感字段脱敏。
3. 明确默认开关、采样、保留周期、删除机制和本地/远程边界。
4. 接入 UI feedback 和 Generate/Fix 采纳信号。
5. 反馈先生成可审核候选，人工确认后进入 bad case 或新 eval case。
6. 输出按失败类型、修复状态和版本变化的闭环报告。

### Phase H：全量语料规模化训练（后期）

只有前述质量链路稳定后才进入：

- 从 curated corpus 切到版本固定的全量 schema/CRD snapshot。
- 若数据源或集群版本变化，重新 ingestion，不假设旧 generated 永久有效。
- 量化 Recall、MRR、延迟、内存、索引构建时间和成本退化。
- 再根据规模证据选择 binary index、SQLite/vector extension、LanceDB 或真实向量库。

## 8. 每个 Task 的完成定义

一个 Task 只有同时满足以下条件才算完成：

- design/spec 已确认，代码没有越出范围。
- 正常路径、反例和失败路径均有测试。
- 运行时数据经过校验，不依赖 TypeScript 类型断言伪造安全性。
- 变更涉及 evaluator 时，有反例证明旧误判已被修复。
- 变更涉及 retrieval、prompt、model、corpus 或 generation 时，有同版本 dataset 的 baseline diff。
- trace 足以判断失败发生在数据、retrieval、rerank、context、generation、validation、judge 还是 harness。
- 真实模型验证前说明调用范围和成本；模型波动需要重复运行或报告不可判定。
- 文档只记录当前约束和可验证事实，历史过程放入 commit、PR 或学习复盘。
- 完成后停下汇报，等待用户 review；不自动 commit，不自动 promote baseline。

## 9. 当前验收目标

本轮训练项目达到以下状态，才说明质量底座真正可用：

- 任意一次 eval 都能从 run 定位 dataset、模型、corpus、trace、metrics 和 bad case。
- 每个指标都能解释方向、分母、适用范围和不可比较条件。
- retrieval、grounded answer、judge、generation、fix 的 evaluator 不再互相借用错误语义。
- 已知 bad case 能稳定回归，holdout 能独立反映泛化。
- schema、docs、policy、example 的来源和事实边界可解释。
- 生成和修复不仅能通过 YAML/schema，还能验证需求值与跨资源关系。
- 来源不足时系统能拒答，来源冲突时能分层表达。
- 每次优化都能用证据说明收益、代价和剩余风险。

达到这些标准，才进入更大语料和更复杂产品能力，而不是反过来用功能数量掩盖质量问题。

## 10. 当前设计依据

- `docs/superpowers/specs/2026-07-12-eval-artifact-protocol-design.md`
- `docs/superpowers/specs/2026-07-12-eval-metric-semantics-design.md`
- `docs/superpowers/specs/2026-07-12-evaluator-validity-design.md`
- `docs/superpowers/specs/2026-07-12-knowledge-provenance-corpus-identity-design.md`
- `docs/superpowers/plans/2026-07-10-eval-harness-source-hardening.md`：仅保留第一轮 Task 1-8 的实施记录，不作为后续实现依据。
