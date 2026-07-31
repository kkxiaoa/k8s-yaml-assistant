# AI 应用开发能力训练实现方案

> 状态：当前执行依据。
> 最近核对：2026-07-31。
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

- Production Deployment（生产部署）的私有部署阶段已按审核结论收敛。2026-07-29 用户确认以 `docs/superpowers/specs/2026-07-29-public-experience-control-design.md` 和对应实施计划取代尚未部署的 oauth2-proxy（认证代理）、`private/portfolio`（私有 / 作品集展示）双模式及 `set-access-mode`（设置访问模式）候选。新的 Task 16-17（任务 16-17）统一公开界面、30 天匿名低额度完整体验、任意 GitHub（代码托管平台）用户登录增额、持久个人额度、Open Showcase Mode（开放展示模式）、Sleep Mode（休眠模式）和全局费用预算；控制库 OBS（对象存储服务）备份因数据价值低且运维复杂度高，在部署前从候选清退，回答反馈也明确不进入本阶段。匿名身份只使用服务端签名 Cookie（浏览器标识）和匿名化账本，不声称防机器人。体验状态现按 `ask`、`generate`、`fix` 分别表达真实运行时依赖和各自点数：Voyage（向量服务）不可用不再连带关闭只依赖 DeepSeek（回答模型）的 `generate`、`fix`。修订后的本地候选已通过完整本地门禁和用户 review（审核），Task 18（任务 18）质量审核随后按独立授权执行。公网身份仍为 `120.46.57.214` 与 `/k8s-yaml-assistant`，域名只作为未来备选。GitHub OAuth callback（开放授权回调）已完成本地验证；生产 OAuth（开放授权）配置、公开入口、Publish（正式发布）与部署均未执行。
- 四份 2026-07-12 纠偏计划、Phase B（阶段 B）工程清理和 Case Governance（评估用例治理）已经完成结构实现与审核；2026-07-29 已使用发布候选的精确 8,410 条索引执行新版本完整模型评估，因人工审核未通过而未晋升任何 baseline（基线）。
- `v0.1.0` 已携带 8,410 条正式索引和六项发布证据完成不可变发布，并通过运行 `30265452918` Attempt 5（第 5 次尝试）首次部署到私有 K3s（轻量 Kubernetes）。随后发现的 production observation root（生产观测根目录）权限阻断已由卷内 `0700` 私有子目录修复，修复随 `v0.1.1` 源提交 `ac9eb22100e300e8b3babd3bdc26ad8e45ea169d` 发布。
- 经本次明确授权，精确绑定该源提交、包含六项发布证据的 `v0.1.1` 已于 2026-07-28 Publish（正式发布）并创建实际不可变标签。`Deploy published release`（部署已发布版本）运行 `30296287472` Attempt 1（第 1 次尝试）及 GitHub deployment（GitHub 部署记录）`5628234264` 均成功。随后人工确认回滚 Release（发布版本）`360812512` 已 Publish（正式发布），运行 `30325880287` Attempt 1（第 1 次尝试）及 GitHub deployment（GitHub 部署记录）`5633580284` 把生产回滚到 `v0.1.0`。经再次明确授权，恢复 Release（发布版本）`360824879` 已于 `2026-07-28T03:56:06Z` Publish（正式发布）；运行 `30327301138` Attempt 1（第 1 次尝试）及 GitHub deployment（GitHub 部署记录）`5633826683` 均成功，生产当前恢复并固定在 `v0.1.1` 镜像摘要 `sha256:9d734264c4df1257d25a478e612ff2c3cbf61b1c918504e0da3a65e650cebe37`，仓库 `Latest`（最新发布）仍为普通 `v0.1.1` Release（发布版本）。
- 因跨境 GHCR（GitHub 容器镜像仓库）冷拉取过慢且 SWR（华为云容器镜像服务）企业版仍待审批，`v0.1.1` 在 Publish（正式发布）前曾使用一次性人工路径完成本机拉取、OCI archive（开放容器镜像归档）传输和节点导入；临时认证文件和两端归档均已删除。该操作现已收敛为仓库内脚本 `scripts/k3s-image-preheat.sh`；本机兜底副本 `/Users/xiaokuangkuang/Desktop/k3s-image-preheat.sh` 不作为执行依据，避免与仓库版本漂移。在同区域镜像分发可用前，后续应用或回滚草稿必须先完成人工证据核对，再以目标草稿标签运行仓库脚本：应用草稿从 `release-manifest.json` 读取精确 `linux/amd64` 根摘要，规范回滚草稿从标签读取精确根摘要。脚本只负责在本机生成并校验 OCI（开放容器镜像）归档，经 SSH（安全远程登录）传输后导入并回读 K3s（轻量 Kubernetes）中的同一摘要；回滚来源证明和部署台账仍由正式部署流水线校验。只有脚本成功后才可另行确认 Publish（正式发布）；预热、Publish（正式发布）和部署分别需要明确授权。
- Release Pull Request #21（发布合并请求 #21）合并后，Release lifecycle（发布生命周期）运行 `30601953560` 创建了 `v0.2.0` Draft Release（草稿发布版本），空 `/api/ask` 业务请求和 GitHub CLI（GitHub 命令行工具）附件未投影的合法元数据先后误阻断候选；修复分别由 Pull Request #26、#27（合并请求 #26、#27）收敛。运行 `30612869879` 已成功完成发布生命周期；当前 `v0.2.0` 草稿仍精确绑定应用源提交 `b06c2d9004f42030aef9ca769c65ac9bfc71b58f`，包含六项附件、不是 Pre-release（预发布）且未 Publish（正式发布），实际 Git tag（Git 标签）不存在，候选镜像根摘要为 `sha256:ebfdefd9c2e057891eeb3b4b70cd3d823e7b75b67b8d62f9227bc128931cdaba`。首次获授权的生产镜像预热已在导入后按门禁停止：固定版本 Skopeo（容器镜像复制工具）的 `oci-archive` 输出为发布根索引增加包装层。第二次获授权的生产预热使用直接 OCI layout（开放容器镜像布局），候选内容已导入并解包，但固定版本 containerd（容器运行时）的默认 Transfer API（传输接口）按归档注解生成引用，未把 `--index-name` 绑定到发布根；两次均未建立目标精确镜像引用。节点内容与固定版本源码随后确认：`--local --digests` 会为 `index.json` 的直接 manifest（清单）建立摘要引用；脚本据此删除 `--index-name` 并切换为 local import（本地导入）。经再次明确授权，第三次生产预热已成功建立并解包精确引用 `ghcr.io/kkxiaoa/k8s-yaml-assistant@sha256:ebfdefd9c2e057891eeb3b4b70cd3d823e7b75b67b8d62f9227bc128931cdaba`，其 Target（目标）与发布根完全一致，两端临时文件均已清理；生产 Deployment（工作负载）始终保持 `v0.1.1` 的 `1/1` 可用状态。旧的本地镜像名 `sha256:588871a614e885d024cd8ece4e96793a02fe64be18f5882817aeb0c0a0a9fc6c` 现在也指向同一发布根，不是独立镜像内容，暂不做低价值删除。只要草稿根摘要和节点精确引用不变，合并脚本修复后不需要重复预热；Publish（正式发布）和部署仍分别需要明确授权。
- 当前固定单副本 Deployment（工作负载）为 `1/1` 可用，Pod（容器组）重启为 `1`，且只来自本次获授权的节点重启，稳定观察期内没有继续增加。生产 runner（运行器）服务为 `active/enabled`（运行中 / 开机自启），GitHub（代码托管平台）显示在线空闲，操作标记不存在。公网 80/443/6443 仍不可达，没有 Ingress（入口）；容器保持非 root（非超级用户）、只读根文件系统、零 Linux capability（Linux 能力）和未挂载 ServiceAccount token（服务账户令牌）。
- `v0.1.1` 的非模型验收已确认 live/ready（存活 / 就绪）和 `/api/check`，8,410 条镜像内索引身份、哈希与零在线重建，以及 `/app/data/observability/segments` 为 `10001:10001 0700` 且不再出现 `root_unsafe`。经另行授权完成 1 个非敏感 `/api/ask` 请求：HTTP 200、两个预期来源、回答引用完整，精确字段路径证明未进入 Voyage embedding/rerank（Voyage 向量嵌入 / 重排）。生产写入的 1 条 `0600 10001:10001` 严格观测记录不含当前 YAML（配置文件）、提示词或回答。回滚到 `v0.1.0` 后应用按已知边界再次以 `root_unsafe` 安全关闭观测；恢复到 `v0.1.1` 后私有子目录、权限和正常观测边界重新生效，启动日志不再出现 `root_unsafe`，既有分段在整个往返过程中保持 1,170 字节、1 行且权限和所有者不变。回滚和恢复过程均没有模型调用。16 MiB 轮转、7 天 / 256 MiB 清理、人工删除和符号链接拒绝仍只有与 `v0.1.1` 源码一致的本地门禁，没有生产实证。
- Step 6（步骤 6）当前没有合格真实故障候选，不制造生产故障；Step 7（步骤 7）的标签保护、两次人工 Publish（正式发布）、节点本地镜像命中、生产回滚、恢复和台账闭环已经完成。成功台账当前有四个事件、两个不同摘要，最新事件精确绑定恢复运行 `30327301138/1` 且 `action=rollback`；生产运行器在线空闲，操作标记不存在。Step 8（步骤 8）也已在独立授权下完成：重启前创建并上传数据库与服务端令牌分离备份 `20260728T041517Z-8d2b24cc-0d2d-4954-9997-ce6b2f1aa3e6`，管理员回读核对三项摘要一致；节点重启后 boot ID（启动标识）变为 `b9e5a5c6-b52f-4fb3-9a4d-1d54bc971a71`，K3s（轻量 Kubernetes）、运行器和应用自动恢复，`root:root 0700` 运行时目录按规则重建。节点直接复用本地 `v0.1.1` 镜像，台账、操作标记、观测分段和索引身份均未变化，没有重复部署、模型调用或在线索引重建。2026-07-28 独立审核已接受 Step 5（步骤 5）的部分验收边界和 Step 6（步骤 6）的明确延期风险，Task 7 Step 9（任务 7 步骤 9）事实状态同步完成；这不表示真实观测生命周期或自动恢复生产演练已经完成，也不授权公开入口、模型调用、索引重建或 baseline（基线）晋升。
- Task 15（任务 15）中严格请求契约、有界请求体、短窗口限速/并发、模型紧急开关、上游超时/重试、输出和序列化字节边界继续作为新方案输入。旧身份头、单用户允许名单、`ACCESS_MODE`、认证代理、双模式路由、访问模式发布授权和适配器扩展只形成过本地候选，从未部署，现由新设计直接替代，不保留运行时兼容分支。
- 新 Task 16-17（任务 16-17）以应用内 GitHub OAuth 2.0（开放授权协议）、`normal|interview|sleep` 全局状态、SQLite（嵌入式数据库）额度/费用账本和统一公开页面为边界。匿名浏览器在 30 天签名身份有效期内获得 7 点模型体验包，`check` 不扣点；任意登录用户获得独立每日额度，管理员只绕过个人额度并可切换开放展示或休眠。控制库只保存低价值状态且新库默认休眠，不增加异地备份或备份故障反向门禁。Task 18（任务 18）的修尺后模型复测已经执行：Generation/Fix（生成 / 修复）通过，Faith（忠实度）仍未通过；Judge（裁判）20×5 票完整校准复测的 17 条可判定忠实度结论全部与人工一致，但 3 条平票不可判定，回答行为另有 1 条不可判定，策略冲突解释有 1 条分歧，因此完整门禁未通过。审核还发现两处人工尺子需要重新确认，不能把全部差异直接归因于模型。全部人工行为标签仍为 `answer`，且新增跨资源契约仍有四条检索问题。2026-07-31 用户明确接受这些已记录的现阶段风险作为本轮公开候选的剩余风险，因此它们不再单独阻断本轮候选发布；不晋升任何 baseline（基线），问题用例、尺子边界和后续改进任务全部保留。回答反馈、后续模型调用和索引身份变化仍需后续 Task（任务）或单独授权。
- Task 18（任务 18）先删除已确认的旧 8,127 条索引和 `.next` 构建产物，再从当前生产镜像摘要 `sha256:9d734264c4df1257d25a478e612ff2c3cbf61b1c918504e0da3a65e650cebe37` 提取并校验 8,410 条候选索引；没有调用 `index:build`。五类成功运行依次为 retrieval（检索）`2026-07-29T10-27-35-327Z`、faith（忠实度）`2026-07-29T10-38-42-300Z-full`、judge（裁判）`2026-07-29T11-04-44-208Z-judge`、generation（生成）`2026-07-29T11-22-41-770Z-generation` 和 fix（修复）`2026-07-29T11-24-08-465Z-fix`；首次 faith（忠实度）运行 `2026-07-29T10-29-48-748Z-full` 因内部 embedding（向量）字段越过 trace（轨迹）边界失败，最小边界修复通过 317 项完整测试后重新运行成功，失败产物按协议保留且未复用。
- Task 18（任务 18）首次人工审核确认：83/88/20/27/9 条成功运行与 trace（轨迹）可对账，Holdout（留出集）未进入校准或自动回灌，两条错误解释正确且完整，85 个带回答来源的用例引用编号均与 source snapshot（来源快照）一致，未发现真实凭据或生产敏感 YAML（配置文件）。当次阻断项为：retrieval（检索）仍有 `policy-conflict-privileged` 失召回；faith（忠实度）仅 64/82，另有 18 条有来源幻觉和 6 条裁判不可判定；judge（裁判）100 次投票含 19 次无效、4 个不可判定、2 个不稳定及 `rolebinding-roleref` 标签/判定歧义；Generation/Fix（生成 / 修复）虽机器指标全通过，但 `job-basic`、`hard-cronjob-full` 在命令未定义时自行补出命令，`fix-missing-provisioner` 只验证字段存在且输出值无法从输入确定。运行协议尚未贯通 raw usage/cost（原始用量 / 费用），只能对账请求次数，不能给出实际费用。Faith bad case（忠实度问题用例）只完成无写入预览；现有 retrieval bad case（检索问题用例）的复发证据作为工作区差异等待 review（审核），没有自动回灌、提交或 baseline（基线）晋升。当时决定先审核并修正上述评估用例/裁判边界，再另行授权必要的模型复测；不得直接进入公开发布。
- 2026-07-29 经本次明确授权修复 `policy-conflict-privileged`：既有 reviewed alias（已审核别名）只增加真实复发短语，唯一匹配字段路径复用现有软加权；dense retrieval（稠密检索）继续使用扩展问题，alias 命中的 rerank（重排）改用原始问题、命中路径及既有标题。82 条 tuning A/B（调优集对照评估）为 Recall@3 `100.0%`、MRR `0.927`、零 Recall lost case（召回损失用例）。正式 full retrieval（完整检索）运行 `2026-07-29T12-20-24-990Z` 使用相同 8,410 条索引和模型身份，83 条 trace（轨迹）完整，Recall@3 从 `82/83` 提升为 `83/83`，MRR@3 保持 `77/83`；目标策略位于第 2，Holdout（留出集）仍为第 1，harness error（评估框架错误）为 0，未新增 bad case（问题用例）。对应既有问题用例已人工标记为 `fixed`，回答来源契约同步收紧为 schema + policy（结构定义与组织策略）均必需。该运行尚未晋升 retrieval baseline（检索基线）；faith、judge、generation、fix（忠实度、裁判、生成、修复）的既有阻断不变，仍不得进入公开发布。
- 2026-07-29 新增五条跨资源检索契约，覆盖 Ingress 到 Service/Secret、RoleBinding 到 Role/ClusterRole/ServiceAccount、HPA 到 Deployment、Pod 到 PVC/ConfigMap/Secret，以及 PVC 到 StorageClass。Control（对照组）完整运行 `2026-07-29T13-08-18-747Z` 复用同一 8,410 条索引，88 条 trace（轨迹）完整，Recall@3 为 `97.0%`（`85.333/88`）、MRR@3 为 `0.915`（`80.5/88`）、harness error（评估框架错误）为 0；原有 83 条全部通过，新契约中 Ingress 通过，其余四条形成真实 bad case（问题用例）。随后仅对五条目标契约执行 Candidate（候选组）定向 A/B Test（对照实验）：Ingress、HPA 通过，Pod、RoleBinding、PVC 仍分别只命中 `1/3`、`1/2`、`1/2`。该候选已触发“任一目标失败即舍弃”的门禁，多资源软提示、规范资源名补词和直接父 schema（结构定义）补候选代码及专用测试均已撤销；没有继续执行 88 条 Candidate（候选组）完整运行，也没有晋升 baseline（基线）。五条评估契约、Control（对照组）运行证据及四条问题账本保留，用于证明单一路由不是唯一缺口，父子字段粒度和 rerank（重排）选择仍需先澄清。
- 2026-07-29 完成 Task 18（任务 18）非模型修尺：`job-basic` 与 `hard-cronjob-full` 的需求和断言现共同固定单个 `busybox` 容器及精确 `command` 数组，不再把模型自行补出的命令计为成功；不可从输入确定 `provisioner` 值的 `fix-missing-provisioner` 已替换为真实缺少 `spec.selector` 的 `fix-missing-deployment-selector`，修复值由现有 Pod 模板标签和 schema（模式定义）的匹配约束唯一确定，对应错误解释契约同步更新。`rolebinding-roleref` 的人工标签明确记录 S1/S3 联合依据，Judge（裁判模型）提示词改为接受多片段无歧义联合蕴含，同时禁止把问题本身当事实依据；calibration snapshot（校准快照）仅从既有正式 Faith trace（忠实度轨迹）重建，没有模型调用。88/88/27/9 条评估契约预检和 317 项完整测试通过，TypeScript（类型系统）检查及差异格式检查通过。该记录只证明尺子已修正；尚未执行新的 faith、judge、generation、fix（忠实度、裁判、生成、修复）模型运行，未重建索引或晋升 baseline（基线）。
- 2026-07-29 经明确授权完成 Task 18（任务 18）修尺后模型复测。首次命令在 runtime configuration（运行时配置）预检处失败，发生在任何模型请求和运行产物创建之前；未修改 `.env`，补齐既有固定非敏感配置后重试。Faith（忠实度）运行 `2026-07-29T14-44-40-963Z-full` 的 88/88 条 trace（轨迹）完整：81 条可判定回答中 59 条 faithful（有依据）、22 条 unfaithful（无充分依据），另有 7 条裁判不可判定，拒答正确性为 3/3；新 `error-deployment-missing-selector` 暴露出只检索到父字段 `spec.selector`、却不足以支持回答中的子字段 `matchLabels` 的证据缺口。Generation（生成）运行 `2026-07-29T15-34-18-258Z-generation` 为 27/27，Fix（修复）运行 `2026-07-29T15-35-25-448Z-fix` 为 9/9，均在首次尝试通过全部结构、字段值、跨资源关系、保留项、副作用和内容断言，修订的精确命令与 Deployment selector（工作负载选择器）用例也通过。
- 同轮 Judge（裁判校准）运行 `2026-07-29T15-12-40-187Z-judge` 虽报告 16/17 一致、3 条不可判定、5 条不稳定和 26 次无效投票，但审核发现 calibration builder（校准构建器）按 case ID（用例标识）把旧人工标签套到了新答案和新来源上下文，该指标无效且不得用于验收或 baseline（基线）。最小修复只要求每条人工标签声明其审核过的 `sourceFaithRunId`，构建时只读取标签实际引用的正式运行并拒绝运行不匹配；20 条已审核校准快照已恢复绑定到 `2026-07-29T10-38-42-300Z-full`，没有新增重复答案身份，也没有再次调用模型。该修复通过校准重建、88/88/27/9 条契约检查、317/317 项完整测试、TypeScript（类型检查）和差异格式检查，重建后的校准快照与已提交内容无差异，并于 2026-07-30 完成用户 review（审核）。复测产物及校准快照共 9 个文件的凭据和生产敏感信息扫描未命中；Faith bad case（忠实度问题用例）仍只做无写入预览。trace（轨迹）可对账本轮 172 次 Voyage（向量服务）、124 次 DeepSeek answer（回答模型）和 203 次 DeepSeek judge（裁判模型）请求，运行协议仍不能提供实际 usage/cost（用量 / 费用）。本轮没有重建索引、写入 bad case（问题用例）或晋升 baseline（基线）；有效 Judge（裁判校准）复测仍须另行取得模型调用授权。
- 2026-07-30 经明确授权完成绑定修复后的有效 Judge（裁判校准）运行 `2026-07-29T16-10-50-371Z-judge`。20/20 条 trace（轨迹）完整且全部绑定已审核 Faith（忠实度）运行 `2026-07-29T10-38-42-300Z-full`，100/100 次计划投票全部执行，模型请求错误和 harness error（评估框架错误）均为 0。主一致率为 13/14（92.9%），超过既有 80% 门槛；但 29 次无效票中有 25 次空响应和 4 次非法 JSON（数据格式），造成 6 条不可判定，`rolebinding-roleref` 仍以 1 票支持、2 票反对和 2 票无效形成不稳定分歧，联合蕴含提示未关闭该问题。该运行身份有效，但不能证明 Judge（裁判模型）稳定性改善，也不消除 Faith（忠实度）和跨资源检索阻断；新 run（运行）与 trace（轨迹）未命中凭据、常见令牌格式或生产标识。没有写入 bad case（问题用例）、重建索引或晋升 baseline（基线），本次授权的模型调用到此结束；运行结论与后续非模型诊断已完成用户 review（审核）。
- 后续非模型诊断确认：空响应同时出现在短至 756 字和长至 2,797 字的上下文，不能归因为单一输入长度；当前 `textOf` 只返回文本块拼接结果，trace（轨迹）没有上游 `stop_reason`（停止原因）或内容块类型，因此现有证据不能区分 token（令牌）上限、非文本内容块或供应商空文本。共享的 1,024 token（令牌）上限还有其他直接消费者，当前不做猜测性调整。`rolebinding-roleref` 的 S1/S3 与问题限定按既有规则可以无歧义联合推出 `kind=Role`，人工标签保持有效，当前分歧属于裁判未正确联合读取。
- 2026-07-30 按 review（审核）结论完成 Judge parser v3（裁判解析器第 3 版）最小响应诊断候选：模型响应边界一次性提取文本，并只在 `empty_response` 中保存归一化停止原因、文本块数量和非文本块数量；Judge CLI（裁判命令行工具）按这三个字段聚合输出。旧 v2（第 2 版）已审核 Faith trace（忠实度轨迹）仍可读取，新运行身份与旧解析器版本隔离；原始响应、推理内容、用量和共享的 1,024 token（令牌）上限均未改变。88/88/27/9 条评估契约、317/317 项完整测试、TypeScript（类型检查）和差异格式检查通过；从既有 20 条人工标签绑定的 Faith snapshot（忠实度快照）重建校准文件前后哈希均为 `9671cef702668acee58b333f7c8860f149b60b3b4ebdf97cfa1bd161044fcc29`，证明兼容读取没有改写快照。本次没有调用模型、重建索引、写入 bad case（问题用例）或晋升 baseline（基线）。
- 2026-07-30 经新一轮明确授权执行 v3（第 3 版）Judge（裁判校准）复测。首次运行 `2026-07-29T16-59-09-205Z-judge` 因缺少仓库既有的固定非敏感 DeepSeek（裁判模型）端点和回答模型身份，在 `runner_initialization`（运行器初始化）阶段失败；协议保留失败 run（运行），但没有 trace（轨迹）或模型请求。带入固定值后的成功运行 `2026-07-29T16-59-56-230Z-judge` 绑定 `judge-vote-parser-v3` 和已审核 Faith（忠实度）运行 `2026-07-29T10-38-42-300Z-full`，20/20 条 trace（轨迹）与 100/100 次投票完整，77 次有效、23 次无效、0 次模型请求错误，harness error（评估框架错误）为 0。主一致率为 16/17（94.1%）；`quota-hard`、`svc-nodeport`、`policy-secret-plaintext` 因有效票不足不可判定，`rolebinding-roleref` 仍以 1 票支持、3 票反对形成唯一主结论分歧，后者与 `policy-conflict-latest` 共构成 2 条内部不稳定用例。23 次无效票包括 15 次空响应和 8 次非法 JSON（数据格式）；15 次空响应全部为 `stop_reason=max_tokens`、0 个文本块、1 个非文本块，证明这些请求在产生文本块前已触达当前响应 token（令牌）上限，但元数据不能识别非文本块类型，也不能解释未记录停止原因的 8 次非法 JSON。相较上一有效运行，空响应从 25 降至 15、非法 JSON 从 4 增至 8，单次随机波动不能证明稳定性改善。两个新 run（运行）和一份 trace（轨迹）的身份、覆盖与哈希已核对，敏感信息扫描未命中；没有重建索引、写入 bad case（问题用例）或晋升 baseline（基线），本次模型授权到此结束。
- 2026-07-30 经明确授权开始解决 Task 18（任务 18）阻断，并先按依赖修正 Judge（裁判）尺子。官方 DeepSeek（裁判模型）契约确认思考模式默认开启、Anthropic-compatible API（Anthropic 兼容接口）支持 `max_tokens`，JSON Output（JSON 输出）需要足够预算避免截断；本地 v4（第 4 版）候选因此只把 Judge 输出预算从共享 1,024 分离为独立 4,096 token（令牌），不改变其他文本消费者。预算继续与模型和系统提示共同进入既有 `judgePromptHash`，没有增加重复配置身份；所有 `empty_response|invalid_json|invalid_vote` 解析无效票现复用同一组归一化停止原因及文本/非文本块计数，Judge CLI（裁判命令行工具）按错误码聚合，原始输出、推理和用量仍不落盘，解析器身份更新为 `judge-vote-parser-v4`。88/88/27/9 条评估契约、317/317 项完整测试、TypeScript（类型检查）和差异格式检查通过；20 条已绑定人工标签的校准快照重建前后哈希仍为 `9671cef702668acee58b333f7c8860f149b60b3b4ebdf97cfa1bd161044fcc29`。本阶段没有模型调用、索引重建、bad case（问题用例）写入或 baseline（基线）晋升；v4（第 4 版）真实效果尚未复测。
- 2026-07-30 经 review（审核）和明确授权完成 v4（第 4 版）Judge（裁判校准）运行 `2026-07-29T17-43-35-691Z-judge`。20/20 条 trace（轨迹）全部绑定已审核 Faith（忠实度）运行 `2026-07-29T10-38-42-300Z-full` 的 20 个不同来源轨迹，100/100 次计划投票完整，98 次有效、2 次无效、0 次模型请求错误，harness error（评估框架错误）为 0。v3（第 3 版）的 15 次 `max_tokens` 空响应和 8 次非法 JSON（数据格式）均降为 0，证明 4,096 token（令牌）预算关闭了已定位的截断问题；剩余 2 次无效票均为 `pod-image` 返回 `policy: null`，上游正常 `end_turn`，严格协议按既定对象或省略契约拒绝该值，但该用例仍达到 3 票法定人数。固化标签下主一致率为 17/20（85%），不可判定为 0，内部不稳定为 7 条。逐条审核发现 `pod-image` 和 `quota-hard` 的人工标签说明与固化答案明显矛盾：两份答案都包含来源未支持的具体事实，应从 faithful（有依据）改为 unfaithful（无充分依据）；标签尚未修改，等待人工 review（审核），因此 17/20 不能作为最终校准结论。`rolebinding-roleref` 的人工 true 标签仍可由问题限定与 S1/S3 联合推出，2 票支持、3 票反对继续构成真实 Judge（裁判）能力缺口；现有提示已经包含通用联合蕴含规则，不增加单用例特判。run（运行）和 trace（轨迹）哈希分别为 `dac5bbb27ae8611743a137e9cb4db5eebc15d9365972b94ee74d036cf34cfb42`、`c77526fb6668587ff55b33642325772d35186bbe3cce9a25b1cc3aba0bfd596f`，敏感模式扫描未命中，产物继续由 Git 忽略。没有重建索引、写入 bad case（问题用例）或晋升 baseline（基线），本次模型授权到此结束。
- 2026-07-30 随后确认 Faith outcome（忠实度结果）把“期望拒答”误当作“实际拒答”：旧逻辑以 `expectedBehavior=refuse_insufficient_context` 和 `faithful=true` 直接产出 `refused_correctly`，但 `faithful` 只证明没有无依据事实，不能证明回答真的拒答。该问题同时暴露 Judge（裁判）缺少独立回答行为维度。当前本地 v5（第 5 版）候选要求新 Judge 票独立输出 `answer|refusal|non_answer`；Faith（忠实度）按忠实、期望行为、可答用例完整检索、必需来源和 schema/policy（结构定义 / 组织策略）冲突表达组合为 `passed|failed|judge_failed|error`，不再用 `hallucination|dual_cause` 声称因果。经明确授权，3 个旧 Faith run（忠实度运行）、2 个旧 Faith trace（忠实度轨迹）、20 条旧 Judge 人工标签及对应 calibration snapshot（校准快照）已删除，当前 Faith 解码器、问题用例转换和指标注册表不再维护旧 outcome（结果）、旧因果失败类型或旧指标；问题账本中唯一 `hallucination` 记录按其既有无依据主张证据一次性迁移为 `unsupported_claim`，没有生成新问题用例。新 Faith（忠实度）运行完成后必须重新人工审核 Judge labels（裁判标签），不得把旧标签按 case ID（用例标识）自动迁移到新回答。清理阶段没有模型调用、索引重建或 baseline（基线）晋升。
- 2026-07-30 经同一轮明确授权完成 v5（第 5 版）完整 Faith（忠实度）运行 `2026-07-30T05-39-30-441Z-full`。首次命令在运行时配置预检处失败且未创建产物或发出模型请求；带入仓库固定非敏感配置后，88/88 条 trace（轨迹）完整，61 条 `passed`、27 条 `failed`，harness error（评估框架错误）和裁判不可判定均为 0。Faithfulness（忠实度）为 `63/88`（71.6%），回答行为契约满足 `84/88`（95.5%），有依据完整通过 `61/88`（69.3%）；25 条回答含无依据主张，4 条回答行为不符，检索与必需来源不完整均为 0。三条应拒答用例的实际行为全部为 `answer`，其中两条同时含无依据主张，修正后的正确拒答为 `0/3`，证明旧 `3/3` 是由尺子缺失实际行为维度产生的假阳性；另有一条应回答用例被判为 `refusal`。两次首次裁判输出为非法 JSON（数据格式），第二次尝试均成功，因此 88 条最终均可判定。run（运行）和 trace（轨迹）哈希分别为 `022b577824b7797f84c2a8e1e69901d729a8abd18c108867765453fe22697d8e`、`cede8e136a6d509bcf08df43547a2f72aed1416034f3f1ff3f8809d590fad4bc`，严格解码、数据集覆盖和敏感模式扫描通过。没有写入新 bad case（问题用例）、生成 Judge labels（裁判人工标签）、重建索引或晋升 baseline（基线）；本轮模型授权到此结束，下一步是人工审核新 Faith trace 并重新建立 Judge 校准标签。
- 2026-07-30 经用户逐条 review（审核）完成新 Faith（忠实度）运行的 20 条 Judge labels（裁判人工标签），全部精确绑定 `2026-07-30T05-39-30-441Z-full` 的 20 个不同非 Holdout（留出集）轨迹；人工结论为 9 条忠实、11 条不忠实，33 个 policy（组织策略）维度，实际回答行为均明确标为 `answer`。盲审只以问题、回答和来源快照为依据，不把既有 Judge verdict/outcome（裁判结论 / 结果）作为人工答案；披露来源不足后继续给出字段、事实或操作建议仍按实质作答处理。当前候选及整次回答的拒答措辞筛查没有找到可诚实纳入的真实 `refusal|non_answer` 样本，因此新快照只能校准忠实度、策略维度和 `answer` 识别，不能证明 Judge（裁判模型）已校准拒答或非回答识别。经明确授权运行 `build:calibration` 后，`data/eval/judge-calibration.jsonl` 已物化 20 条，标签与快照哈希分别为 `38c1b05ca320f78063aac13e80e07eeb8839b73a111de31de4f1ec5a4b2ae1fe`、`b65000db888054b07e2e12c70fdf7ac78c5d9e17c64c73287f8eb206c4bfc7ec`；来源运行、轨迹唯一性、零 Holdout（留出集）、schema（模式定义）、两组校准测试、88/88/27/9 条评估契约和差异格式检查均通过。本步骤没有调用模型、重建索引、写入 bad case（问题用例）或晋升 baseline（基线）；新的 Judge（裁判校准）模型运行仍须另行授权。
- 2026-07-30 经明确授权完成 v5（第 5 版）Judge（裁判校准）运行 `2026-07-30T06-41-38-149Z-judge`。首次命令在 `tsx` 创建本地进程通信管道时被沙箱以 `EPERM` 拒绝，发生在评估入口前，没有创建运行产物或调用模型；同一命令获准在沙箱外重试后，20/20 条 trace（轨迹）全部绑定上述当前 Faith（忠实度）快照的 20 个不同来源轨迹，100/100 次计划投票完整，91 次有效、9 次无效、0 次请求错误、0 个不可判定和 0 个 harness error（评估框架错误）。9 次无效包括 5 次正常结束但不是单一 JSON（数据格式）、2 次达到 4,096 token（令牌）上限的非法 JSON，以及 2 次返回 `policy:null` 的严格协议无效票。主一致率只有 `13/20`（65%），低于 80% 门槛，7 条主结论分歧且 7 条内部不稳定；回答行为为 `19/20`（95%），但人工集只有 `answer` 标签，唯一分歧 `refusal-cluster-runtime` 被多数票误判为拒答，不能外推真实拒答识别。策略维度为 distinguished（来源区分）`11/11`、conflictExplained（冲突解释）`10/11`、misstatedAsOfficial（冒充官方规则）`11/11`。非模型复盘最初把 Judge 输入概括为“只发送文档和回答”，随后按真实调用链更正：Faith 保存并传入的是包含问题在内的完整 Ask（询问）生成输入，问题并非完全不可见，但没有独立边界且整个生成输入被标成 `【文档】`，使问题限定、事实依据和 policy（组织策略）冲突识别混在同一区域；命令行分歧报告还固定寻找 `faithful=false` 票作为“judge 理由”，当多数结论为 `true` 时会打印少数反对票或空理由，虽不改变指标但误导复盘。其余严格边界分歧集中在把未提供的资源键、驱动参数键、校验/拒绝后果和文档外操作建议视为可接受示例或推断。run（运行）与 trace（轨迹）哈希分别为 `ca60d79d137ed204c37c422a7c7ae64a98438a97b10a711eda44e5a9df0756b2`、`12112354da021cd4170d3d15907332b96a74962a1a2365ed696938c1dfcf7a05`，来源绑定和常见凭据模式扫描通过。该运行不得用于验收或 baseline（基线）；本轮模型授权到此结束，下一步先无模型修正 Judge 输入契约和分歧诊断，再经 review（审核）决定是否另行授权复测。
- 2026-07-30 已按授权完成上述无模型 Judge（裁判）修尺候选。Faith（忠实度）和 Judge Calibration（裁判校准）现在都通过单一 `JudgeInput` 显式传入问题、完整生成输入和回答；用户消息分为 `【问题】`、`【生成输入】`、`【回答】`，并明确只有生成输入中的 `<docs>`、`<current_yaml>` 和 `<editor_context>` 当前配置/错误可作为事实依据，重复问题、提示说明和 `<ask_mode>` 不可充当证据。`judgePromptHash` 现覆盖实际用户消息模板以及既有系统提示、模型和 4,096 token（令牌）预算，因此新旧输入契约拥有不同运行身份；逐用例内容仍由既有 dataset/run/trace identity（数据集 / 运行 / 轨迹身份）约束，没有保存重复身份。分歧报告改为选取与多数结论同值的有效票理由，不再固定寻找反对票。完整非模型测试、88/88/27/9 条评估契约、schema（模式定义）、alias（别名）、TypeScript（类型检查）和差异格式检查均通过；人工标签与 calibration snapshot（校准快照）没有改写。没有调用模型、重建索引、写入 bad case（问题用例）或晋升 baseline（基线）；用户 review（审核）已通过，下一步只有在再次获得明确模型调用授权后，才可对当前 20 条校准集执行每条 5 票的 Judge（裁判校准）复测。
- 2026-07-30 经明确授权完成问题边界修复后的 Judge（裁判校准）复测。首次运行 `2026-07-30T08-28-59-745Z-judge` 在 `runner_initialization`（运行器初始化）阶段因缺少固定非敏感运行配置失败，保留失败 run（运行）但没有 trace（轨迹）或模型请求；未修改 `.env`，补入仓库固定端点和回答模型身份后，成功运行 `2026-07-30T08-29-41-646Z-judge`。新运行绑定 dataset hash（数据集哈希）`665a1cccfaa4910e394c0e933a8dbfe129779f93927c6d1c11da240c3235bb73`、新 `promptHash=c0342c1b3c67f391717365077ab12435828778d9b444db69b9856a5b356ece22` 和 `judge-vote-parser-v5`；20/20 条 trace（轨迹）及 100/100 次计划投票完整，来源精确绑定当前已审核 Faith（忠实度）运行 `2026-07-30T05-39-30-441Z-full` 的 20 个不同轨迹。86 票有效、12 票为非法 JSON（数据格式）、2 票请求错误，harness error（评估框架错误）为 0；12 张无效票包括 9 张 `max_tokens` 和 3 张正常结束但非单一 JSON，2 次错误均记录为 `judge_request: terminated`。2 条用例因有效票不足不可判定，主一致率只有 `11/18`（61.1%），低于 80% 门槛，7 条主结论分歧且 7 条内部不稳定；回答行为一致率为 `17/18`（94.4%），但人工行为标签仍全部为 `answer`。策略维度为 distinguished（来源区分）`10/10`、conflictExplained（冲突解释）`9/10`、misstatedAsOfficial（冒充官方规则）`10/10`，各另有 1 条不可判定。相较修复前运行，没有旧分歧转为一致；`rolebinding-roleref` 仍只有 1/5 票接受问题限定与多片段联合蕴含，`policy-conflict-latest` 从一致转为分歧，`policy-conflict-nodeport` 从一致转为不可判定，`refusal-nonexistent-field` 从分歧转为不可判定。该单次随机运行不能把所有变化归因于输入模板，但足以证明问题独立边界没有关闭 Judge（裁判模型）的实质能力缺口；剩余分歧集中于把来源未提供的具体资源键/驱动参数键、校验或准入后果和文档外操作建议宽松视为示例或合理推断。run（运行）与 trace（轨迹）哈希分别为 `0a071304bda0dbf52d1edbe78294dec606bc1b943dad550e1a78d2e6598057fd`、`aae4e33b48391ddf3e488292c17d2035177023e1631cc65a7fe0784a0c03314e`，常见凭据、生产 IP 和生产镜像摘要扫描未命中。没有调用 Voyage（向量服务）、重建索引、写入 bad case（问题用例）或晋升 baseline（基线）；本次模型授权到此结束，该运行不得用于验收。
- 2026-07-30 已按 review（审核）结论完成下一版无模型 Judge（裁判）修尺候选。通用证据规则现明确：示例只能为依据已声明可配置的字段或参数提供占位值，不能引入依据外字段、资源、API、参数、键、命令或行为；校验、准入、拒绝、运行后果和具体操作建议都必须有直接依据；来源不足披露不能抵消无依据主张；问题只能从依据明确列出的有限选项中限定一个选项。上一有效运行仍有 9 张 `max_tokens`（令牌上限）无效票，因此 Judge 专用输出预算由 4,096 提至 8,192，并继续进入既有 `judgePromptHash`，不影响在线回答或其他文本消费者。正式 `eval:judge` 新增从同一人工校准文件重复传入 `--case <case-id>` 的严格定向选择，记录 `targeted`（定向）范围，继续复用 5 票、法定人数、trace（轨迹）和指标协议且不能晋升 baseline（基线）；无参数仍是完整 `calibration`（校准）运行。选择、协议解码、晋升隔离和请求契约的 73 项定向非模型测试、完整 `npm test`、TypeScript（类型检查）、88/88/27/9 评估契约、28 个精选资源的 1,639 个 schema（模式定义）、11/11 已审核 alias（别名）和差异格式检查均已通过。实际九条选择预检绑定 dataset hash（数据集哈希）`44c958823e0e9bec11811d701d83eeacebd1849b71cac48a8f91d49a68dd1b77`、`promptHash=3f7a6c468230a73bb64ac6d2d3bd165a306b378637a42bd6f5309127ef73932f`、5 票和 8,192 token（令牌）预算；尚未调用模型。下一步只对上一轮 7 条分歧和 2 条不可判定用例执行 9×5 次定向 Judge（裁判）请求；九条必须全部达到法定人数、忠实度与人工标签一致，所有已标注的回答行为和策略维度也不得分歧或不可判定，才可申请 20×5 次全量复测授权。
- 2026-07-30 经明确授权完成上述 9×5 次 Judge targeted run（裁判定向运行）`2026-07-30T09-33-26-159Z-judge-targeted`。首次启动在评估入口前被沙箱内 `tsx` IPC（进程间通信）权限拒绝，没有创建运行产物或调用模型；同一命令获准在沙箱外重试后，正式运行精确绑定上述 dataset hash（数据集哈希）、`promptHash`、`judge-vote-parser-v5` 和 `targeted`（定向）范围。9/9 条 trace（轨迹）与 45/45 次计划投票完整，42 票有效、3 票格式无效、0 次请求错误、0 个 harness error（评估框架错误）；原有 9 张 `max_tokens`（令牌上限）无效票降为 0。8 条形成结论的用例全部与人工忠实度标签一致，回答行为也是 `8/8`，四条策略用例的 distinguished（来源区分）、conflictExplained（冲突解释）和 misstatedAsOfficial（冒充官方规则）均为 `4/4`；但 `refusal-nonexistent-field` 只有 2 张有效且均判为不忠实，另外 2 张 `invalid_json`（非法数据格式）和 1 张含契约禁止 `policy:null` 的 `invalid_vote`（非法投票）使其低于 3 票法定人数。三张无效票均正常 `end_turn`，含 1 个文本块和 1 个非文本块，因此这是输出契约稳定性问题，不是 token（令牌）截断。主结论仍有 6 条内部不稳定，回答行为有 1 条内部不稳定；按预先门禁本轮未通过，不得启动 20×5 次完整复测。run（运行）与 trace（轨迹）哈希分别为 `913f81bcf22d7c7bd7b669c66d073bab32d158505bda35f9c4a332b836bfb8aa`、`d9b6c087e7af57f6dce17071d2773bef56b223a02a60f50209bfb67d2c3373ff`，严格解码、覆盖对账和常见凭据 / 生产标识扫描通过；产物继续由 Git（版本控制系统）忽略。没有调用 Voyage（向量服务）、回答模型、重建索引、写入 bad case（问题用例）或晋升 baseline（基线）。下一步先无模型审核结构化输出契约；任何重试仍须另行明确模型调用授权。
- 2026-07-30 已完成定向失败后的无模型输出契约修复。官方 DeepSeek Anthropic-compatible API（深度求索 Anthropic 兼容接口）支持字段没有 OpenAI-compatible API（OpenAI 兼容接口）的 `response_format`，因此没有切换客户端、增加依赖或新建平行网络层。原提示末尾的 `true 或 false` 等内容并非合法 JSON（数据格式）示例，现已替换为有 / 无 `[policy]` 的两个合法对象，并明确首尾必须是单一对象、无策略来源时完全省略 `policy` 且禁止 `null`；严格解析器及 `judge-vote-parser-v5` 身份保持不变。35 项直接测试、完整 317/317 项测试、TypeScript（类型检查）和差异格式检查通过。新候选继续绑定九条 dataset hash（数据集哈希）`44c958823e0e9bec11811d701d83eeacebd1849b71cac48a8f91d49a68dd1b77`，但新 `promptHash=7703d18a4dd8f4c7d15ff62523822a1fda00cba840067e3739b991d7dac6a79c`；上一轮八条成功结果不能与新提示拼接为一次正式通过。该时点要求另行授权重新执行同一 9×5 次定向运行，并以九条全部达到法定人数且所有已标注维度与人工一致作为申请完整复测的前提；执行结果见下一条。本阶段没有新增模型调用、Voyage（向量服务）调用、索引重建、问题账本写入或 baseline（基线）晋升。
- 2026-07-30 经再次明确授权完成 v7（第 7 版）输出契约下的 Judge targeted run（裁判定向运行）`2026-07-30T09-58-06-201Z-judge-targeted`。运行绑定上述九条 dataset hash（数据集哈希）、`promptHash=7703d18a4dd8f4c7d15ff62523822a1fda00cba840067e3739b991d7dac6a79c`、`judge-vote-parser-v5` 和每条 5 票协议；9/9 条 trace（轨迹）与 45/45 次计划投票完整，41 票有效、4 票为非法 JSON（数据格式）、0 次请求错误、0 个 harness error（评估框架错误）。9/9 条忠实度结论、9/9 条回答行为结论和四条策略用例的 distinguished（来源区分）、conflictExplained（冲突解释）、misstatedAsOfficial（冒充官方规则）均达到法定人数并与人工标签一致；上一轮不可判定的 `refusal-nonexistent-field` 本轮 5/5 票有效且正确判为不忠实。四张无效票分布为 2 张正常结束和 2 张达到 8,192 token（令牌）上限的非单一 JSON；主结论有 3 条内部不稳定，回答行为有 1 条内部不稳定，策略冲突解释有 2 条内部不稳定，因此本轮证明预设定向门禁通过，不证明单票结构化输出或裁判稳定性已经解决。run（运行）与 trace（轨迹）哈希分别为 `aaf3c03c879c95963651acd917732e948a7e47a6a356f04c6119042f3f590258`、`de5439450e553e3ba14cbf900d76c0f0db07094336a6d9331911d0b897548ff`；严格解码、九条覆盖对账、Git ignore（版本控制忽略规则）和常见凭据 / 生产标识扫描通过。没有调用 Voyage（向量服务）、回答模型、重建索引、写入问题账本或晋升 baseline（基线）；20×5 次完整 Judge（裁判校准）复测没有启动，必须再次获得明确模型调用授权。
- 2026-07-30 经明确授权完成当前 20 条人工校准集每条 5 票的完整 Judge（裁判校准）运行 `2026-07-30T10-34-25-790Z-judge`。运行绑定 dataset hash（数据集哈希）`665a1cccfaa4910e394c0e933a8dbfe129779f93927c6d1c11da240c3235bb73`、上述 `promptHash`、`judge-vote-parser-v5` 和 `calibration`（校准）范围；20/20 条 trace（轨迹）与 100/100 次计划投票完整，91 票有效、9 票为非法 JSON（数据格式）、0 次请求错误、0 个 harness error（评估框架错误）。忠实度的 17 条可判定结论全部与人工一致，但 `pod-imagepullpolicy`、`rolebinding-roleref`、`refusal-prometheus-retention` 均以 2:2 平票不可判定，主结论共有 8 条内部不稳定；回答行为为 19/19 一致，`refusal-prometheus-retention` 另以 2:2 平票不可判定。策略维度 distinguished（来源区分）与 misstatedAsOfficial（冒充官方规则）均为 11/11，conflictExplained（冲突解释）为 10/11，唯一分歧 `policy-pod-privileged` 的五张有效票一致判为 true，而人工标签为 false。九张无效票均是非单一 JSON，其中 5 张正常结束、4 张达到 8,192 token（令牌）上限，证明合法示例没有关闭结构化输出和截断风险。无模型逐条审核确认：`rolebinding-roleref` 和 `refusal-prometheus-retention` 的人工标签与固化证据 / 回答一致，平票继续反映裁判能力不稳定；`pod-imagepullpolicy` 的固化回答示例引入来源未覆盖的 `name`、`image` 字段，与当前严格主张规则及人工 `faithful=true` 存在冲突；`policy-pod-privileged` 的回答实际解释了 schema（模式定义）允许与组织策略禁止的两层关系，当前 `conflictExplained=false` 应重新判断为 true 或 N/A（不适用）。因此本轮只通过 80% 主一致率，不通过完整质量门禁，不修改人工标签、不追加模型运行或晋升 baseline（基线）。run（运行）与 trace（轨迹）哈希分别为 `953c94e2f73b8278f9d56422107a62ea5462dec0928a45dd0030eb7aea6b0918`、`25a7ba73c7279f4b928393880ef62d833d8b111443a5cd3f38a1554a3b182ab6`；严格解码、20 条覆盖对账、Git ignore（版本控制忽略规则）和常见凭据 / 生产标识扫描通过。没有调用 Voyage（向量服务）、回答模型、重建索引或写入问题账本；下一步先人工 review（审核）上述两处尺子边界，任何修订后的模型复测仍须再次授权。

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

Retrieval/Grounded Answer/Generation/Fix（检索 / 有依据回答 / 生成 / 修复）数据集由 `npm run eval:check` 核对；Judge Calibration（裁判校准）由当前校准快照的严格解码和最新完整运行覆盖对账核对：

| 数据集 | 数量 | task（任务） | origin（来源） | role（角色） |
|---|---:|---|---|---|
| Semantic Retrieval（语义检索） | 88 | field_explanation=79，policy_explanation=9 | human=88 | development=76，regression=11，holdout=1 |
| Grounded Answer（有依据回答） | 88 | field_explanation=74，policy_explanation=9，error_explanation=2，refusal=3 | human=88 | development=76，regression=11，holdout=1 |
| Judge Calibration（裁判校准） | 20 | field_explanation=10，policy_explanation=7，refusal=3 | human=20 | development=18，regression=2 |
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
| run/trace/baseline/bad case | runtime protocol、metric registry、compare/promote 门禁已实现；Judge（裁判校准）已有独立问题边界、回答行为维度和人工绑定校准快照 | 完整 20×5 票复测有 3 条忠实度不可判定、1 条回答行为不可判定、1 个策略维度分歧及两处待审核尺子边界；没有晋升 baseline（基线），单票格式与内部稳定性仍有风险，usage/cost（用量 / 费用）尚未贯通 |
| Generation/Fix repair loop | 修尺后模型复测 27/27 与 9/9 首次尝试全部通过 | 精确命令、目标值、关系、保留项和副作用断言已通过；尚未晋升 baseline（基线） |
| `[S]` 引用、schema/policy 分层 | 带来源回答的引用编号和快照结构保持对齐；Faith（忠实度）现分开表达忠实、回答行为、检索和来源覆盖 | 当前 Faith（忠实度）只有 `61/88` 有依据完整通过，三条应拒答用例均实际作答；父子字段证据、answer correctness（答案正确性）与 claim-level verification（主张级验证）未完成 |
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
8. 当前边界：原有 83 条 retrieval（检索）用例保持全通过；五条新增跨资源契约的 Control（对照组）暴露四条问题用例，多资源提示与直接父 schema 补候选方案未通过定向 A/B Test（对照实验）并已完整撤销。修尺后 Generation/Fix（生成 / 修复）模型复测通过。v5（第 5 版）Faith（忠实度）只有 `61/88` 有依据完整通过，三条应拒答用例均实际作答。20×5 票完整 Judge（裁判校准）运行的 17 条可判定忠实度结论全部与人工一致，但 3 条忠实度和 1 条回答行为平票不可判定，策略冲突解释有 1 条分歧，且 100 票中仍有 9 张格式无效、主结论有 8 条内部不稳定。逐条审核把 `pod-imagepullpolicy` 人工忠实标签和 `policy-pod-privileged` 策略冲突标签列为待 review（审核）的尺子边界，其余两个平票保留为真实裁判不稳定证据；不能放宽解析、拼接不同运行、修改标签迎合结果或按单用例语义特判。全部人工行为标签仍为 `answer`，不提供真实 `refusal|non_answer` 校准证据。当前没有 baseline（基线）晋升；2026-07-31 用户明确接受拒答行为覆盖缺口、跨资源父子字段尺子和四条问题用例作为现阶段剩余风险，本轮候选可以继续，但所有问题证据与后续待办保持有效。
9. Task 18（任务 18）后续待办按依赖执行：① 先人工审核 `pod-imagepullpolicy` 与 `policy-pod-privileged` 两处尺子边界；② 若标签修订获确认，仅无模型更新人工标签、校准快照和数据集身份并通过完整本地门禁；③ 分开诊断 `rolebinding-roleref`、`refusal-prometheus-retention` 的真实裁判不稳定，以及 9 张格式无效票 / 4 张 8,192 token（令牌）截断，不以继续抬高预算作为默认修复；④ 任何定向或完整模型复测再次取得明确授权；⑤ Judge（裁判）尺子稳定后再处理 Faith（忠实度）的 25 条无依据主张、4 条行为不符和 `0/3` 正确拒答；⑥ 单独重新设计四条跨资源 retrieval（检索）候选并先做定向 A/B Test（对照实验）；⑦ 只有各类别完整运行、人工审核和风险结论收敛后，才逐类决定 baseline（基线）晋升或继续拒绝。

### Production Deployment（生产部署，当前优先插入主线）

1. 已完成并审核：`superpowers/specs/2026-07-19-k3s-production-deployment-design.md` 的 Phase 0-3（阶段 0-3）明确华为云单机 K3s（轻量 Kubernetes）、GHCR（GitHub 容器镜像仓库）、单人 draft Release（草稿发布版本）人工确认、生产 self-hosted runner（自托管运行器）、镜像内置索引和安全 observation（观测）边界；其中未部署的 Phase 4-5（阶段 4-5）双访问模式候选已被 2026-07-29 公共体验控制设计替代。
2. 已完成并审核：Phase 0（阶段 0）本地与服务器只读审计；Phase 1（阶段 1）的固定版本 K3s（轻量 Kubernetes）变更包、安装加固和节点外分离备份。非敏感证据记录在 `deploy/k3s/README.md`。
3. Phase 0-2（阶段 0-2）、特权 deployment adapter（部署适配器）Task 1-7（任务 1-7）和 Task 14（任务 14）的私有发布、部署、人工回滚、恢复及节点重启证据已经完成实现与审核；Step 5（步骤 5）的长期观测生命周期保持部分验收，Step 6（步骤 6）的真实自动恢复演练因没有合格候选明确延期。在线索引使用共享连续 `Float32Array` 和 fail-closed（失败关闭）加载，并通过文件哈希验证 `chunks.jsonl` 和 `embeddings.f32`。
4. 新 Task 16-17（任务 16-17）的本地身份、三态控制、额度/费用、统一页面和直接入口候选已经按 `superpowers/specs/2026-07-29-public-experience-control-design.md` 与对应计划完成并通过 review（审核），控制库 OBS（对象存储服务）备份已在部署前清退，三项模型操作状态也已按 DeepSeek（回答模型）与 Voyage（向量服务）的真实依赖拆分。Task 18（任务 18）修尺后 Generation/Fix（生成 / 修复）模型复测通过；v5（第 5 版）Faith（忠实度）完整运行只有 `61/88` 有依据完整通过，且三条应拒答用例实际全部作答，仍未通过。20×5 票完整 Judge（裁判校准）运行达到主一致率门槛，但有 3 条忠实度和 1 条回答行为不可判定、1 个策略维度分歧、9 张格式无效票及两处待审核人工尺子边界，因此完整质量门禁未通过。全部行为标签均为 `answer`，尚不能校准真实拒答或非回答识别；新增跨资源尺子仍有四条问题用例，首个候选方案已经按门禁淘汰，仍未晋升新 baseline（基线）。2026-07-31 用户已明确接受上述现阶段风险，本轮候选可以继续；该接受不改变指标、不晋升 baseline（基线），也不授权模型调用、发布或部署。OAuth App（开放授权应用）、真实 GitHub callback（开放授权回调）、候选发布、安全组、证书管理器安装、Kubernetes（容器编排系统）写入、后续模型调用和节点重启仍须分别获得授权。
5. SWR（华为云容器镜像服务）企业版可用前，应用或回滚 Draft Release（草稿发布版本）通过人工证据核对后，必须在 Publish（正式发布）前运行 `bash scripts/k3s-image-preheat.sh <目标草稿标签>`。应用草稿的目标摘要来自 `release-manifest.json`，规范回滚草稿的目标摘要来自标签；脚本成功只证明该精确镜像根摘要已导入生产 K3s（轻量 Kubernetes），不替代部署流水线对发布来源、证明和台账的校验。失败时保留草稿并停止，不能继续 Publish（正式发布）。执行脚本涉及生产节点写入，仍须获得当次明确授权；后续 Publish（正式发布）和部署继续使用各自独立授权。
6. 部署完成后返回 AI 应用训练主线；部署不把项目扩张为通用 Kubernetes 运维平台。

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
