# 公开仓库迁移与历史清洗设计

> 状态：2026-08-01 已获用户方案确认，尚未执行历史重写、远端强制推送或仓库公开。
> 用途：约束 G1（反馈第一闭环）完成后的开源收口、历史清洗、现有发布链保留和最终公开验收。本文件属于私有执行资料，公开前从当前树移除并由忽略规则阻止重新提交。

## 1. 目标与非目标

继续使用 `kkxiaoa/k8s-yaml-assistant` 这一个仓库作为后续开发、发布和部署的唯一维护仓库。G1 完成后在本地备份基础上清洗当前仓库历史，再覆盖同一远端；不新建长期并行的公开仓库，也不迁移生产 Runner（工作流运行器）。

公开结果同时满足：

- 保留可公开的真实开发历史、提交人员身份和版本演进；
- 当前树不包含内部执行指令、开发日志、私有路线或预热实现；
- 指定文件不再存在于将推送的任何分支或标签历史；
- `README.md` 成为面向使用者和招聘审核者的稳定项目入口；
- 现有 GitHub Actions（自动化工作流）、GHCR（GitHub 容器镜像仓库）和生产部署链在新发布基线建立后继续使用。

本设计不授权历史重写、强制推送、删除 GitHub（代码托管平台）对象、发布、部署、生产修改、Runner 变更、包可见性变更、Pro（专业版）退订或仓库公开。上述外部写操作按本文边界分别再次确认。

## 2. 单仓库目标形态

### 2.1 公开当前树

公开仓库保留产品源码、测试、生成数据契约、部署清单、发布工作流和稳定的用户/贡献者说明。以下内容不进入公开当前树：

- `AGENTS.md`、`CLAUDE.md`；
- `HANDOFF.md`；
- `docs/` 下的内部训练方案、实施计划、复盘、运行记录和路线；
- `scripts/k3s-image-preheat.sh` 及只服务它的测试、清单说明和脚本入口；
- README（项目说明）中的任务流水账、内部阶段编号、运行编号、临时阻断、私有文档链接和内部发布操作记录。

`.gitignore` 与 `.dockerignore` 必须覆盖 `AGENTS.md`、`CLAUDE.md`、`HANDOFF.md`、`docs/` 和预热脚本路径。忽略规则只防止后续重新提交，不能替代从当前索引和历史中移除已跟踪内容。

需要保留的内部资料进入清洗前的私有只读备份；公开后不在仓库内维护第二套可提交的私有资料。后续新增公开文档只表达稳定用户契约，不恢复内部开发日志或任务路线。

### 2.2 README（项目说明）

`README.md` 重写后只保留：

- K8s YAML Authoring Copilot（K8s YAML 编写辅助）的价值主张和明确能力边界；
- 在线演示、界面截图或短动图；
- Ask/Validate/Generate/Fix（询问 / 校验 / 生成 / 修复）及其依据、拒答和校验语义；
- 可公开的架构、数据来源、评估证据、隐私/费用边界和已知限制；
- 本地开发、测试、贡献、安全报告和许可证入口。

旧 README 历史也要逐版本审计。命中内部日志、私有文档引用或不适合公开内容的历史 blob（文件版本）只做定向清理，安全的产品演进记录继续保留；不能只修改最新版本后让旧内容仍可通过提交历史访问。移出的信息只进入私有备份，不换一个公开路径继续暴露。

### 2.3 历史清洗范围

以下路径从准备推送的全部本地分支、标签和其他可写引用中彻底移除，并先审计历史重命名路径：

- `AGENTS.md`；
- `CLAUDE.md`；
- `scripts/k3s-image-preheat.sh`。

`docs/` 的当前版本全部移除并忽略；按用户已接受边界，旧提交中的 docs（文档）历史不执行全路径清除，因此公开后仍可能通过旧提交访问。这是明确保留的暴露风险，不得在最终公开验收中误报为“docs 从历史消失”。README 的历史定向清理是新增范围，不等同于清除整个 README 历史。

## 3. 提交身份与历史可信度

历史重写必须逐提交保留以下原值：

- author name / email（作者姓名 / 邮箱）；
- committer name / email（提交者姓名 / 邮箱）；
- author date / committer date（作者时间 / 提交时间）；
- 可保留的父子关系、合并结构和提交顺序。

因目标文件删除而变空的提交不自动裁剪，退化的合并提交也不因工具默认行为静默丢弃。message（提交说明）只在包含待清理路径、私有说明或其他不适合公开信息时最小修改，其余保持原文。

清洗在一次性镜像副本中执行，不直接拿日常工作副本试错。清洗前后生成私有 commit-map（提交映射）和机器可核对清单，逐提交比较上述八项身份/时间字段；任一非预期差异、提交丢失或映射不唯一都停止远端更新。

所有被重写提交及其后代的哈希都会变化，原提交签名与标签签名不能继续有效。关闭的 PR（合并请求）差异、旧链接、旧发布证明和依赖旧哈希的自动化也可能失效。这些是 GitHub 官方列出的历史重写副作用，不能以保留姓名和邮箱来宣称签名仍可信。

## 4. 备份、冻结和重写边界

执行前必须：

1. 完成 G1 本地实现；G1 的任何发布和生产验收仍分别授权。
2. 关闭或合并所有开放 PR，冻结其他写入并记录远端所有分支、标签和 Release（发布版本）引用。
3. 创建与活动工作副本分离的只读镜像备份，核对全部引用和对象可读取；备份不进入公开仓库。
4. 盘点历史重命名、README 敏感版本、Git LFS（大文件存储）、子模块、PR 引用、Actions 日志/产物和 Release 附件。
5. 确认没有运行中或排队中的 Actions 任务。

重写使用受控版本的 `git-filter-repo`，先在可丢弃镜像副本演练并固定工具版本、参数和结果摘要。不得在变量未解析、目标引用不完整或备份未验收时执行镜像强制推送。

GitHub 的 `refs/pull/*` 为只读引用，普通强制推送不能清除；缓存视图、旧 clone（克隆）和 fork（派生仓库）也可能继续持有旧对象。GitHub Support（GitHub 支持）通常只协助处理真实敏感数据，不负责清除普通内部文档。因此最终表述只能是“已清理所有可控并准备推送的引用”，不能承诺互联网或 GitHub 缓存中绝对不存在旧副本。

## 5. Runner 与发布部署链

仓库 owner/name、工作流文件路径、生产 Runner 注册和标签保持不变。以下部分不迁移、不重装：

- repository-level self-hosted Runner（仓库级自托管运行器）的注册和本地服务；
- `k8s-yaml-assistant-prod` 标签；
- root-owned deployment adapter（超级用户所有的部署适配器）及其 `sudo` 边界；
- 受保护环境和发布、部署工作流的基本分工。

历史强制推送本身不会注销 Runner，也不会修改当前生产 Pod（容器组）、镜像或 Traefik（入口控制器）路由。清洗期间必须临时禁用可能由 `main`/标签变化触发的发布工作流，并在恢复前确认新历史的工作流契约；禁用工作流不等于注销 Runner。临时禁用/恢复、规则调整和远端强制推送属于外部写操作，执行前再次授权。

公开仓库允许不可信贡献者提交 PR。当前安全不变量为：

- PR 验证只使用 GitHub 托管 Runner，不把 fork 代码发送到生产自托管 Runner；
- 生产 Runner job（任务）不 checkout（检出）仓库源码，只消费托管阶段生成并校验的最小部署授权；
- 不引入 `pull_request_target` 检出不可信代码或等价的特权触发；
- `GITHUB_TOKEN` 默认只读，单个 job 只提升直接需要的权限；
- 第三方 Action（动作）继续固定完整提交哈希；
- 公开后重新核对分支/标签规则、Environment（部署环境）、外部贡献者权限和所有 `runs-on` 消费者。

用户已接受在公开仓库保留自托管 Runner 的平台建议偏离风险；该接受不授权扩大 Runner 能力或让 PR 路径使用它。若上述任一不变量无法证明，公开验收停止。

删除仓库内预热脚本后，发布契约必须同步删除它的测试、文档和脚本入口，不能留下 CI（持续集成）失败或虚假的强制步骤。生产部署 Runner 主链保持不变；跨境冷拉取和失去仓库内预热工具的风险由用户接受。未来是否使用私有运维副本属于另一个明确设计，不在公开源码中恢复该脚本。

## 6. Release、包与账户套餐

历史重写后，旧标签、旧提交哈希、签名和发布来源证明不能再作为新主线的可验证基线。旧 Release 附件和 Actions 日志必须先扫描；保留时要明确它们属于清洗前历史，不能让自动部署继续消费旧请求。清洗后的 `main` 需要建立新的发布基线，但创建 Release、Publish（正式发布）和生产部署分别再次授权。

仓库公开不会自动把现有两个私有 GHCR 容器包改为 public（公开）；包可见性是独立且不可逆方向的外部变更，另行决定。按 2026-08-01 官方规则，公开仓库的标准托管 Runner 免费且不限分钟，自托管 Runner 不收 GitHub Actions 分钟费用，公开仓库的 Environment 保护也适用于 GitHub Free（免费版）。本项目公开并完成 Actions、Environment、GHCR 和 Runner 回查后不再依赖 Pro，但退订只能发生在公开验证之后；账户中其他私有仓库、Codespaces（云开发环境）、存储额度或支持权益不在本项目结论内。

## 7. 验收门禁

### 7.1 本地清洗验收

- 备份可读取且包含清洗前全部预期引用；
- 所有准备推送的分支和标签都不存在三项禁入路径及其历史别名；
- README 的当前版本和历史命中版本不含内部日志、任务路线或私有文档引用；
- 当前树不存在 `docs/`、`HANDOFF.md`、内部指令文件和预热脚本，忽略规则与容器构建上下文一致；
- 提交身份/时间逐项一致，提交数量、拓扑和 message 修改均有私有审计结果；
- 专用密钥扫描覆盖当前树和完整可控历史，依赖与生成数据许可证审计完成；
- 全部本地代码、部署、工作流和发布门禁通过；不存在预热脚本的悬空消费者。

### 7.2 远端覆盖验收

在单独授权后才临时调整阻止重写的规则、禁用触发器并强制更新远端。更新后在仓库仍为 private（私有）时完成：

- 默认分支、全部预期标签和新提交映射正确；
- 只有预期的 `refs/pull/*` 或平台缓存可能残留旧对象；
- Actions 未发生意外发布或部署，Runner 仍为 online/idle（在线 / 空闲）；
- 托管 CI、发布契约和 GHCR 读取通过；
- 规则和工作流恢复完成。

恢复旧备份会重新引入已清理内容，远端覆盖后不能把“回滚”当普通操作；只有重大数据丢失且再次明确授权时才可考虑。

### 7.3 最终公开验收

仓库可见性变更必须再次取得用户明确授权。公开后立即回查：

- 实际匿名访问、README、许可证、安全报告和贡献入口；
- 分支/标签规则和强制推送限制；
- Actions 历史/日志/产物、workflow 权限和 fork PR 行为；
- Environment、OAuth（开放授权）、GHCR 包访问和在线演示；
- 自托管 Runner 仍只匹配受控生产 job；
- GitHub Advanced Security（GitHub 高级安全）扫描结果和任何公开后新告警。

只有以上回查通过，才可把迁移标为完成；之后再由用户决定是否取消 Pro。

## 8. 权威外部契约

- GitHub 仓库可见性及公开后的 Actions 日志、规则变化：<https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility>
- GitHub 历史敏感数据清理及副作用：<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository>
- GitHub Actions 安全使用：<https://docs.github.com/en/actions/reference/security/secure-use>
- GitHub 对公开仓库自托管 Runner 的风险提示：<https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners>
- GitHub 套餐：<https://docs.github.com/en/get-started/learning-about-github/githubs-plans>
- GitHub Actions 计费：<https://docs.github.com/en/billing/concepts/product-billing/github-actions>
- GitHub Packages 计费与包可见性：<https://docs.github.com/en/billing/concepts/product-billing/github-packages>、<https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility>
