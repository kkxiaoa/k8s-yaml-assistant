# 华为云单机 K3s 生产部署实施计划

> 状态：执行中；Phase 0-1（阶段 0-1）和 Task 5-10（任务 5-10）已审核；Task 11（任务 11）的实现已经通过 Pull Request #2（合并请求 #2）合入 `main`。8,410 条正式索引已经构建、校验和签名，Release Pull Request #3（发布合并请求 #3）已压缩合并为 `aa3baeb047241f0bf3ead262c10b48f26f577a2c`，`v0.1.0` Draft Release（草稿发布版本）已经创建。发布状态和恢复修复已通过 Pull Request #6（合并请求 #6）合入 `main`；手工恢复已验证草稿、索引并构建候选镜像，但因 5 项 `HIGH`（高危）运行时依赖漏洞在签名和附件前失败关闭。当前安全修复分支升级受影响依赖并把 Trivy `HIGH/CRITICAL`（容器高危 / 严重漏洞）扫描前移到 Pull Request（合并请求）门禁；既有草稿仍无附件和实际 Git tag（Git 标签），合入后必须先重定向到精确新提交并更新发布说明，再恢复六项证据。
> 对应设计：`docs/superpowers/specs/2026-07-19-k3s-production-deployment-design.md`，该设计已通过 review（审核）。
> 用途：把已审核的生产部署设计拆成可验证、可回滚、逐阶段停下的实施任务；本文不构成服务器、GitHub（代码托管平台）、模型调用或公开访问授权。
> Task 10（任务 10）合并提交：`273704fb72133abed5d70678d0259de9c Merge pull request #1 from kkxiaoa/feat/github-pr-gates`。
> Task 11（任务 11）实现提交：`59fa0b81bbe45082f8ee20c51e3aaefab614bb91 feat: add production release lifecycle`；GitHub merge commit（GitHub 合并提交）：`a6d12ad2b2430c1cd8bbf0f935085a7ce6f61432`。

## Goal（目标）

在不扩张 K8s YAML Authoring Copilot（K8s YAML 编写助手）产品边界的前提下，把当前 Next.js（React 全栈框架）应用交付到华为云单节点 K3s（轻量 Kubernetes），形成以下可审核闭环：

```text
clean source（干净源码）
  -> test/type/build/security gates（测试 / 类型 / 构建 / 安全门禁）
  -> manual immutable index artifact（手工触发的不可变索引产物）
  -> Release Please Pull Request（发布自动化合并请求）
  -> immutable candidate image（不可变候选应用镜像）
  -> draft Release manual confirmation（草稿发布版本人工确认）
  -> release.published（发布版本已发布）
  -> fixed deployment adapter（固定部署适配器）
  -> private K3s rollout（私有 K3s 发布）
  -> restricted TLS/auth verification（受限 TLS / 认证验证）
  -> controlled public portfolio（受控公开作品集）
```

第一阶段只承诺单节点、单副本和可回滚发布，不承诺 high availability（高可用）。portfolio（作品集展示）可以公开页面、静态资源和不调用外部模型的 YAML 检查；匿名 Ask/Generate/Fix（询问 / 生成 / 修复）必须等待独立 token/usage/cost metering（令牌 / 用量 / 成本计量）设计、实现和审核。

## Authority Boundaries（授权边界）

本计划把操作分为三类，不能用前一类授权推导后一类授权：

| 类别 | 典型操作 | 本 plan review（计划审核）是否授权执行 |
| --- | --- | --- |
| 本地只读 | 读取仓库、运行不联网检查、生成差异报告 | 否；执行每个 Task（任务）时仍按停止点确认 |
| 本地写入 | 修改应用、测试、Dockerfile、工作流或部署清单 | 否；按 Task（任务）逐项实现、review（审核） |
| 外部或生产变更 | 创建远程仓库、写 GitHub Secret（GitHub 密钥）、调用模型、推送 GHCR（GitHub 容器镜像仓库）、SSH 写服务器、安装 K3s、修改安全组/DNS（域名系统）、发布 Release（发布版本） | 绝不自动授权；每类操作必须获得当次明确授权 |

编写或审核本计划不授权：连接服务器、创建 remote（远程仓库）、推送、调用模型、重建索引、创建 Secret（密钥）、注册 self-hosted runner（自托管运行器）、修改安全组、公开 80/443 或部署任何 Kubernetes（容器编排系统）资源。

## Execution Rules（执行规则）

- 严格按 Task（任务）和 Phase（阶段）顺序执行；每个 Task 完成后停止汇报，每个 Phase 结束后必须等待独立 review（审核）。
- 每轮开始重新执行并核对 `pwd`、`git status --short`、`git branch --show-current`、`git log -1 --oneline`、`git remote -v`，完整阅读当时的 `AGENTS.md`。
- 仓库命令只在 `/Users/xiaokuangkuang/workspace/k8s-yaml-assistant` 执行；服务器命令只在对应 Task 获得明确授权后执行。
- 所有代码和部署契约先写反例测试，再实现；不能用静态字符串搜索代替可执行行为测试，静态检查只能补充安全门禁。
- 每个容器构建从 clean checkout（干净检出）开始，并先执行 `npm ci`；不把当前 ignored artifacts（被忽略产物）当作发布输入。
- 不调用真实 DeepSeek、Voyage、embedding（向量嵌入）或 rerank（重排），除非当前 Task 明确列出调用范围、费用上限并获得当次授权。
- 不在仓库、文档、命令参数、日志、Actions artifact（流水线产物）或对话中输出密码、私钥、API key（应用程序接口密钥）、cookie secret（浏览器会话密钥）、runner credential（运行器凭据）或完整 kubeconfig（Kubernetes 客户端配置）。
- 不用 `latest`、移动标签或浮动第三方 Action（流水线动作）；镜像部署只接受完整 digest（内容摘要），第三方 Action 固定完整 commit SHA（提交哈希）。
- 不让生产 self-hosted runner（自托管运行器）处理 Pull Request（合并请求）、任意分支代码或仓库脚本；它只调用 root-owned deployment adapter（root 所有部署适配器）。
- 当前源码仓库变为 public repository（公开仓库）前，必须先创建独立 private deployment repository（私有部署仓库），迁移生产 workflow/manifest/ledger/access-mode control（流水线 / 清单 / 台账 / 访问模式控制），从源码仓库移除并注销生产 runner（运行器），再把运行器注册到私有部署仓库并重验全部权限；不能把生产 runner（运行器）留给公开源码仓库。
- 不把 `number[] | Float32Array` 保留为生产 serving index（在线服务索引）的最终契约；在 Task 7（任务 7）关闭运行时重建时同时完成类型收口。
- 不在匿名计量设计前创建额度表、SQLite（嵌入式数据库）、Redis（内存数据存储）、计量 PVC（持久卷声明）、Interview Pass（面试临时通行证）占位命令或隐藏后门。
- 未经用户再次明确授权，不对本计划及后续实现执行 `git add` 或 `git commit`。

## Phase Graph（阶段图）

| Phase（阶段） | Tasks（任务） | 出口 |
| --- | --- | --- |
| Phase 0（阶段 0） | Task 1-2（任务 1-2） | 本地与服务器只读事实通过审核 |
| Phase 1（阶段 1） | Task 3-4（任务 3-4） | 固定版本 K3s 安装、加固与备份边界通过审核 |
| Phase 2（阶段 2） | Task 5-11（任务 5-11） | 可复现容器、有效索引、GHCR 候选镜像与草稿发布版本通过审核，不部署 |
| Phase 3（阶段 3） | Task 12-14（任务 12-14） | 固定部署适配器、生产 runner（运行器）和私有发布/回滚通过审核 |
| Phase 4（阶段 4） | Task 15-17（任务 15-17） | 域名、TLS（传输层安全）、认证、保护和双访问模式在受限来源通过审核 |
| 公开前质量闸 | Task 18（任务 18） | 正式评估人工审核通过，或形成显式风险接受记录 |
| Phase 5（阶段 5） | Task 19-20（任务 19-20） | 公开发布、恢复演练和观察期通过审核 |

虽然 Phase 2（阶段 2）的部分仓库工作在技术上不依赖 K3s（轻量 Kubernetes），当前计划仍保持 Phase 0 → 1 → 2（阶段 0 → 1 → 2）的审核顺序，不以并行工作绕过阶段停止点。Phase 1（阶段 1）和 Phase 2（阶段 2）任一未通过都不能进入 Phase 3（阶段 3）；Phase 4（阶段 4）不得与 Phase 3（阶段 3）私有验证合并，Phase 5（阶段 5）不得与 Phase 4（阶段 4）受限入口验证合并。

截至 2026-07-20，Phase 1（阶段 1）的非敏感实施证据已记录在 `deploy/k3s/README.md`：固定版本 K3s（轻量 Kubernetes）安装、准入与静态加密、SSH（安全远程登录）加固、节点外分离备份及管理员独立摘要校验均已通过。公网 TCP（传输控制协议）入口关闭已从实施机验证；22/TCP 的来源限制与 8472/UDP 的关闭依据云安全组规则核对，未从另一非允许来源主动探测，作为本阶段审核风险保留。尚未创建应用 Namespace（命名空间）、Secret（密钥）、runner（运行器）或工作负载，也未修改公网安全组。

## Phase 0（阶段 0）：只读审计

## Task 1（任务 1）：冻结本地发布事实

**Authority（授权）：** 仓库事实只读；允许按项目基线用 `npm ci` 恢复被忽略的本地依赖，但不修改已跟踪源码、不联网调用模型、不重建索引。

**Files（文件）：**

- Read only（只读）：`AGENTS.md`
- Read only（只读）：`package.json`
- Read only（只读）：`package-lock.json`
- Read only（只读）：`next.config.mjs`
- Read only（只读）：`app/layout.tsx`
- Read only（只读）：`app/api/**/route.ts`
- Read only（只读）：`src/retrieval/index-store.ts`
- Read only（只读）：`src/retrieval/retrieve.ts`
- Read only（只读）：`src/retrieval/trace.ts`
- Read only（只读）：`.gitignore`
- Read only（只读）：Git 已跟踪的 `data/` 发布输入

- [x] **Step 1（步骤 1）：核对 Git（版本控制系统）与依赖基线**

```bash
pwd
git status --short
git branch --show-current
git log -1 --oneline
git remote -v
node --version
npm --version
npm ci
```

记录当前分支、完整 HEAD（当前提交）、remote（远程仓库）状态、Node.js（JavaScript 运行时）和 npm（Node 包管理器）版本。若工作区不干净，先区分用户改动和当前 Task（任务）改动，不覆盖或顺带提交。

- [x] **Step 2（步骤 2）：核对发布输入闭包**

使用 `git ls-files` 和现有项目命令核对：schema（模式）、policy（策略）、alias（别名）、字体、public/static（公共 / 静态资源）、索引构建输入和运行时读取路径。必须证明 clean checkout（干净检出）拥有完整的 28 个 curated resources（精选资源）闭包，不能从 ignored generated files（被忽略的生成文件）补齐。

- [x] **Step 3（步骤 3）：核对当前阻断项**

重新确认：

- `next/font/google` 外网字体依赖；
- 未启用 `output: 'standalone'`；
- 缺少 Dockerfile、`.dockerignore`、`.github/workflows` 和部署资源；
- 8,127 条旧索引相对 8,410 条语料失效；
- 索引 miss（未命中）仍会在线重建；
- Ask（询问）仍默认写 raw trace（原始轨迹）；
- 缺少健康端点、认证、运行时解码、请求体上限、限流和费用保护；
- 模型端点/模型名硬编码边界。

- [x] **Step 4（步骤 4）：运行无模型门禁**

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npm run schemas:check
npm run corpus:stats
npm run eval:check
npm run aliases:check
npm run build
git diff --check
```

**Rollback（回滚）：** 无写入，无需回滚。若 `npm ci` 只恢复被迁移时排除的依赖，不把生成目录或缓存加入 Git。

**Stop and report（停止并汇报）：** HEAD（当前提交）、依赖/构建事实、发布输入闭包、索引身份、全部阻断项和本地门禁结果。等待 review（审核）。

## Task 2（任务 2）：执行华为云服务器只读审计

**Precondition（前置条件）：** Task 1（任务 1）通过；用户当次明确授权只读 SSH（安全远程登录）。

**Authority（授权）：** 服务器只读。不得安装软件、写文件、修改服务、防火墙、安全组或云配置。

**Files（文件）：** 无仓库写入。

- [x] **Step 1（步骤 1）：核对主机身份与容量**

只读取发行版、CPU 架构、内存、swap（交换空间）、磁盘/文件系统、inode（索引节点）、时间同步、路由和云实例事实。不得输出 SSH 私钥或认证代理配置。

- [x] **Step 2（步骤 2）：核对端口与系统服务**

```bash
uname -a
lsb_release -a
lscpu
free -h
df -h
lsblk -f
ip -brief address
ip route
ss -lntup
timedatectl
systemctl --failed
sudo ufw status verbose
```

确认 80/443 是否被占用，记录 22、6443、8472、10250 和其他监听端口；只记录安全组规则摘要，不复制完整云控制台配置。

- [x] **Step 3（步骤 3）：核对安装与恢复前提**

确认 systemd（系统服务管理器）、container runtime（容器运行时）冲突、内核能力、自动安全更新、日志轮转、备份目标、出站 DNS/443 和服务器 CPU 架构。只核对 K3s 所需事实，不安装 K3s 或诊断工具。

**Rollback（回滚）：** 无状态变更。任何命令要求安装、提权写入或改变配置时立即停止。

**Phase 0 Stop（阶段 0 停止点）：** 汇报服务器事实与用户输入差异、端口冲突、磁盘/内存风险、出站限制和 Phase 1（阶段 1）前置决策。等待独立 review（审核），不得顺势安装 K3s。

## Phase 1（阶段 1）：K3s 安装与加固

## Task 3（任务 3）：形成固定版本 K3s 变更包

**Precondition（前置条件）：** Phase 0（阶段 0）通过；用户授权编写仓库内非敏感运维资源，但尚未授权服务器写入。

**Files（文件）：**

- Create（创建）：`deploy/k3s/config.yaml`
- Create（创建）：`deploy/k3s/admission-config.yaml`
- Create（创建）：`deploy/k3s/README.md`
- Create（创建）：`scripts/deployment-contract.test.ts`
- Modify（修改）：`package.json`，只增加无网络、无 Secret（密钥）的部署契约检查命令
- Modify（修改）：`scripts/README.md`

- [x] **Step 1（步骤 1）：先写配置反例**

测试至少覆盖：

- 缺少固定 K3s 版本或 installer checksum（安装器校验和）的变更包失败；
- `write-kubeconfig-mode` 不是 `0600` 失败；
- 未启用 `secrets-encryption` 失败；
- admission config（准入配置）没有 restricted Pod Security Admission（受限 Pod 安全准入）默认边界失败；
- 配置包含 server token（服务端令牌）、kubeconfig（客户端配置）、公网 6443、浮动 channel（通道）或占位 Secret（密钥）失败；
- 备份说明把 K3s database（数据库）和 server token（服务端令牌）混在未加密单一位置时失败。

测试解析真实 YAML（配置文件）结构，不以字符串是否出现作为唯一判定。

- [x] **Step 2（步骤 2）：固定实施日版本和来源**

实施当日从 K3s 官方 release（发布版本）核对仍受支持版本、CPU 架构、安装器和 checksum（校验和）。变更包只记录版本、来源、摘要和验证方法，不把下载二进制提交到仓库，不使用 `curl | sh`。

- [x] **Step 3（步骤 3）：实现最小 K3s 配置**

配置只覆盖已审核边界：单 server（服务端）、默认 SQLite（嵌入式数据库）、Traefik（入口控制器）、ServiceLB（服务负载均衡器）、NetworkPolicy controller（网络策略控制器）、`write-kubeconfig-mode=0600`、`secrets-encryption=true` 和受限准入。任何 Phase 0（阶段 0）发现的防火墙/网段特殊项必须在 README（说明文档）写清原因，不用关闭全部防火墙解决冲突。

- [x] **Step 4（步骤 4）：验证变更包**

```bash
node --import tsx --test scripts/deployment-contract.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

**Rollback（回滚）：** 仅仓库文件，恢复当前 Task（任务）的精确差异；不操作服务器。

**Stop and report（停止并汇报）：** K3s 版本/摘要、配置字段、准入边界、备份方案、测试和仍待服务器验证的假设。等待 review（审核）。

## Task 4（任务 4）：安装、加固并验证 K3s

**Precondition（前置条件）：** Task 3（任务 3）通过；安装窗口、备份位置和确切服务器写入获得当次明确授权。

**Authority（授权）：** 只允许安装和配置已审核的 K3s/系统边界；不创建应用 Namespace（命名空间）、runner（运行器）、Secret（密钥）或工作负载，不修改公网安全组。

**Files（文件）：** 使用 Task 3（任务 3）已审核配置；服务器实际配置不回写 Secret（密钥）到仓库。

- [x] **Step 1（步骤 1）：安装前快照与摘要验证**

记录服务、端口、磁盘、配置文件状态和维护窗口；下载到受控临时目录，核对官方来源与 SHA-256，摘要不符立即停止。不得把 registration token（注册令牌）、server token（服务端令牌）或 kubeconfig（客户端配置）写入命令日志。

- [x] **Step 2（步骤 2）：安装固定版本**

只使用已审核配置安装；不跟随 moving channel（移动通道），不开放 6443，不禁用 Traefik/ServiceLB/NetworkPolicy controller（入口控制器 / 服务负载均衡器 / 网络策略控制器），除非 Phase 0（阶段 0）已有经审核的冲突结论。

- [x] **Step 3（步骤 3）：验证集群与加固**

```bash
sudo systemctl status k3s
sudo k3s --version
sudo k3s kubectl get nodes -o wide
sudo k3s kubectl get pods -A -o wide
sudo k3s kubectl get --raw=/readyz
sudo k3s check-config
sudo k3s secrets-encrypt status
sudo stat -c '%a %U:%G %n' /etc/rancher/k3s/k3s.yaml
sudo ss -lntup
sudo journalctl -u k3s --since "30 minutes ago"
```

从非允许来源验证 22/6443 不可达；不能为测试先开放端口。确认 80/443 的 ServiceLB（服务负载均衡器）行为与 Phase 0（阶段 0）事实一致。

- [x] **Step 4（步骤 4）：建立恢复材料**

建立 K3s database（数据库）与 server token（服务端令牌）分离、加密、访问受限的备份流程；验证备份可读、版本/时间/摘要可核对。当前阶段只验证备份流程，不在生产节点执行破坏性恢复演练。

**Rollback（回滚）：** 安装异常时先停止 K3s 并保留诊断。卸载会删除集群数据，只有列出确切目标、核对备份并获得单独破坏性操作授权后才能执行；不能把卸载写成自动失败处理。

**Phase 1 Stop（阶段 1 停止点）：** 汇报版本、checksum（校验和）、配置差异、监听端口、系统 Pod（容器组）、加固结果、备份证据和剩余风险。等待独立 review（审核）。

## Phase 2（阶段 2）：应用发布准备、容器与 GHCR

## Task 5（任务 5）：固定 Node.js、移除字体外网依赖与 standalone output（独立运行产物）

**Precondition（前置条件）：** Phase 0（阶段 0）通过；实施日重新核对 Node.js 24 LTS（Node.js 24 长期支持版）受支持状态和具体补丁版本。

**Files（文件）：**

- Create（创建）：`.nvmrc`
- Create（创建）：`scripts/release-build-contract.test.ts`
- Modify（修改）：`package.json`
- Modify（修改）：`package-lock.json`
- Modify（修改）：`next.config.mjs`
- Modify（修改）：`app/layout.tsx`
- Modify（修改）：`app/globals.css`
- Modify（修改）：`app/page.tsx`
- Modify（修改）：根 `README.md`、`CLAUDE.md`、`scripts/README.md` 和对应部署设计文档中的字体边界

- [x] **Step 1（步骤 1）：先写构建契约反例**

覆盖：Node.js（JavaScript 运行时）版本文件与 `engines.node` 不一致、Next.js（React 全栈框架）未启用 standalone output（独立运行产物）、应用重新导入 `next/font`、加入字体二进制或恢复旧 IBM Plex CSS variable（CSS 变量）时失败。测试不得伪造 Google 字体响应作为生产通过条件。

- [x] **Step 2（步骤 2）：移除项目字体资产依赖**

按 2026-07-20 review（审核）决策移除 IBM Plex 和全部 `next/font` 加载，使用浏览器系统 sans/monospace（无衬线 / 等宽）字体栈。项目不提交字体二进制，不承担仅为视觉风格维护字体许可证和供应链身份的成本。

- [x] **Step 3（步骤 3）：固定工具链和独立产物**

在 `.nvmrc`、`package.json`/`package-lock.json` 根元数据和后续容器基础镜像中使用同一具体 Node.js（JavaScript 运行时）版本。`next.config.mjs` 增加 `output: 'standalone'`，并修正已经不符合迁移后目录事实的旧注释。

- [x] **Step 4（步骤 4）：验证固定运行时与独立构建**

```bash
npm ci
node --import tsx --test scripts/release-build-contract.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
npm run build
test -f .next/standalone/server.js
git diff --check
```

本 Task（任务）用契约测试和真实 Next.js build（Next.js 构建）证明不存在字体加载路径并生成独立产物；Task 9（任务 9）仍须在正式容器阶段执行禁网 build（构建），验证完整构建过程没有其他外网依赖。

Next.js 16.2.9 会把本地构建时加载的 `.env` 或 `.env.production` 主动复制到 `.next/standalone`。本次只验证独立产物结构，已在不读取内容的前提下删除生成的 `.next/standalone/.env` 副本，原始 `.env` 未修改；该本地产物不得直接发布。Task 9（任务 9）必须从不含 `.env*` 的 clean checkout（干净检出）和 `.dockerignore` 构建，并扫描最终镜像确认没有环境文件或密钥。

**Rollback（回滚）：** 恢复本 Task（任务）的精确版本、构建配置和系统字体栈差异；不删除用户本地缓存或 ignored artifacts（被忽略产物）。

**Stop and report（停止并汇报）：** 固定版本、系统字体边界、独立产物内容、外网依赖证据和测试结果。等待 review（审核）。

## Task 6（任务 6）：完成 Serving Observation Safety（在线观测安全）依赖计划

**Precondition（前置条件）：** `docs/superpowers/specs/2026-07-14-serving-observation-safety-design.md` 和 `docs/superpowers/plans/2026-07-14-serving-observation-safety.md` 重新核对当前代码；该计划获得独立 review（审核）。

**Files（文件）：** 以既有 Serving Observation Safety plan（在线观测安全计划）为唯一文件清单，本计划不复制一套平行实现。

- [x] **Step 1（步骤 1）：修订过期执行位置**

四份 2026-07-12 纠偏计划和 Case Governance（评估用例治理）已经完成，既有 observation plan（观测计划）中“Task 1 后返回纠偏计划”和“Task 2-6 尚不可执行”的说明已经过期。只更新状态与执行位置，不放宽 schema（模式）、脱敏、采样、轮转、保留、删除和安全失败边界；修订后停止等待该计划的 review（审核）。

- [x] **Step 2（步骤 2）：按既有 Task 1-3（任务 1-3）隔离原始轨迹并建立安全协议**

先删除 Ask（询问）默认 raw sink（原始写入端），再实现 strict observation schema（严格观测模式）、结构化脱敏、二次敏感扫描、显式配置和稳定采样。每个既有 Task（任务）保持原停止点，不合并审核。

既有 Task 1-3（任务 1-3）均已通过审核：默认 raw sink（原始写入端）和可绕过安全协议的 retrieval file API（检索文件接口）已经删除，内存 `RetrievalTrace`（检索轨迹）及显式内存 sink（写入端）仍保留；独立 strict schema（严格模式）、结构化脱敏、二次敏感扫描、allowlist projection（白名单投影）、显式配置和稳定采样已经完成。

- [x] **Step 3（步骤 3）：执行既有 Task 4（任务 4）transport decision gate（传输方案决策闸）**

结合单节点、单副本、`maxSurge=0`、`maxUnavailable=1` 和候选 local sink（本地写入端）重新选择同步写或有界队列。不得在同一 Task（任务）边选边实现，不引入无界队列或未经审核的自研生产 logger（日志记录器）。

审核选择同步请求路径和受控 local sink（本地写入端），接受低流量单写入端下的同步文件 I/O（输入输出）与节点掉电时最后少量观测丢失；不引入队列、worker（工作线程）或逐条 `fsync`（同步落盘）。

- [x] **Step 4（步骤 4）：按既有 Task 5-6（任务 5-6）实现和集成**

实现受控 JSONL（逐行 JSON）分段、symlink-safe cleanup（符号链接安全清理）、权限、轮转、7 天/256 MiB 候选配置、失败不回退原文和 Ask（询问）集成。生产候选配置必须通过临时目录故障测试，旧 `serving-traces.jsonl` 不读取、不迁移。

受控分段、本地生命周期和 Ask（询问）接线均已实现；代码 hard cap（硬上限）和生产 candidate profile（候选配置）保持分离，真正的 PVC（持久卷声明）、Pod（容器组）单写入端与性能边界仍由后续部署 Task（任务）验证。

- [x] **Step 5（步骤 5）：运行既有全量门禁**

执行 observation plan（观测计划）列出的全部专项测试、`npm test`、TypeScript（类型系统）检查、静态泄漏人工检查和 `git diff --check`。

67 项定向测试、131 项全量测试、TypeScript（类型系统）检查和差异格式检查通过；raw persistence API（原始持久化接口）无命中，敏感字段查询命中已逐项确认只属于检测规则和反例。

**Rollback（回滚）：** 任一 Task（任务）失败都保持 raw persistence（原始持久化）关闭；不得为恢复 trace（轨迹）重新接回 `appendServingTrace` 或把 payload（负载）写到 console（控制台）。

**Stop and report（停止并汇报）：** 逐 Task（任务）审核记录、生产候选配置、敏感字段丢弃证据、文件生命周期、单写入端假设和剩余生产 PVC（持久卷声明）验证。等待 review（审核）。

## Task 7（任务 7）：索引 fail-closed（失败关闭）、类型收口与健康端点

**Precondition（前置条件）：** Task 5（任务 5）通过；不得重建 `data/index` 或调用 Voyage。

**Files（文件）：**

- Create（创建）：`src/server/health.ts`
- Create（创建）：`src/server/health.test.ts`
- Create（创建）：`app/api/health/live/route.ts`
- Create（创建）：`app/api/health/ready/route.ts`
- Create or modify（创建或修改）：无副作用的索引构建模块，具体路径在实施时根据当前引用确定
- Modify（修改）：`src/retrieval/retrieve.ts`
- Modify（修改）：`src/retrieval/index-store.ts`
- Modify（修改）：`src/retrieval/embeddings.test.ts`
- Modify（修改）：`scripts/index-build.ts`
- Modify（修改）：`src/server/pipeline-retrieval.test.ts`

- [x] **Step 1（步骤 1）：先写 fail-closed（失败关闭）反例**

覆盖：

- 索引文件缺失、数量/语料/模型/格式/文件哈希不匹配时，serving loader（在线加载器）返回封闭错误，不调用 rebuild callback（重建回调）或 Voyage；
- readiness（就绪状态）失败且只返回稳定错误码，不暴露路径、哈希明细或环境变量；
- liveness（存活状态）不读取索引、不调用供应商；
- 有效索引只加载一次，Ask（询问）和 readiness（就绪状态）复用同一初始化状态；
- DeepSeek/Voyage 暂时不可用不触发 liveness（存活状态）失败；
- 持久化索引中的全部 document vector（文档向量）是共享连续缓冲区的 `Float32Array` 视图。

反例先证明旧 serving loader（在线加载器）仍接受重建回调、缺少健康模块和路由门禁；索引门禁覆盖全部 miss reason（未命中原因）、当前 v5 文件哈希、零重建/零供应商调用、封闭响应、连续缓冲区和一次性状态复用。

- [x] **Step 2（步骤 2）：分离 build input（构建输入）与 serving index（在线索引）类型**

模型 API（应用程序接口）边界可以继续接收 `number[]`，但只允许进入独立 builder input（构建器输入）类型并立即写入 Float32 索引文件。生产 `IndexedChunk.embedding` 收紧为 `Float32Array`；删除 `number[] | Float32Array` 联合类型，避免未来在线路径重新保留膨胀的 JavaScript 数组。

`scripts/index-build.ts` 只依赖无副作用 builder（构建器）以及 index store（索引存储）的 `writeIndex()` / `readIndex()`；写入后必须立即通过与 serving（在线服务）相同的读取路径回读。serving 模块不 import（导入）带 `main()` 的 runner（运行器），也不拥有在线全量构建分支。

`src/retrieval/index-builder.ts` 是唯一 document embedding `number[]`（文档向量数组）边界；`writeIndex()` 只接收该构建输入，按 chunk ID（知识片段标识）稳定排序并同步重排 embedding（向量嵌入），再写为 Float32 文件。`IndexedChunk.embedding` 只允许 `Float32Array`，在线模块已删除 `buildIndex()` 和全量重建分支。当前索引格式为 v5，在 manifest（清单）中显式记录 knowledge identity v2（知识身份版本 2）的 corpus manifestHash（语料清单哈希），并绑定 `chunks.jsonl` 与 `embeddings.f32` 的 SHA-256（安全哈希算法）摘要。

- [x] **Step 3（步骤 3）：实现一次性本地初始化和封闭健康状态**

启动/首次 readiness（就绪检查）校验 schema closure（模式闭包）、alias/policy（别名 / 策略）和 index identity（索引身份），结果在进程内稳定缓存。`/api/health/live` 只返回进程状态；`/api/health/ready` 只返回 `ready` 或有限错误码。业务请求在未 ready（就绪）时返回安全 503，不触发构建。

readiness（就绪状态）只暴露 `schema_invalid`、`policy_invalid`、`aliases_missing`、`aliases_invalid`、`index_missing`、`index_identity_mismatch` 或 `index_invalid`；不返回路径、哈希、环境变量或底层异常。Ask（询问）在解析请求体和加载业务 pipeline（管线）前复用同一 readiness（就绪状态）。当前 v2 旧索引的真实检查返回安全 503 `index_invalid`，供应商调用计数为 0；liveness（存活状态）返回 200 且供应商调用计数为 0。

- [x] **Step 4（步骤 4）：验证无模型路径**

```bash
node --import tsx --test src/retrieval/embeddings.test.ts
node --import tsx --test src/server/health.test.ts
node --import tsx --test src/server/pipeline-retrieval.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
npm run build
git diff --check
```

固定 Node.js 24.18.0 下，三项定向测试分别通过 17、5、10 项，`npm test` 通过 136 项，TypeScript（类型系统）检查、真实 Next.js build（Next.js 构建）和差异格式检查通过；构建产物包含动态 `/api/health/live` 与 `/api/health/ready`。静态补充核对确认 serving（在线服务）没有 `buildIndex(CORPUS)` 或 runner（运行器）导入；可执行 miss（未命中）反例和当前旧索引请求均证明模型/重建调用次数为 0。

静态补充检查必须人工确认 serving（在线服务）路径不再引用 `buildIndex(CORPUS)`，但不能用静态检查替代“miss（未命中）时模型调用次数为 0”的可执行反例。

**Rollback（回滚）：** 回退整个 Task（任务）时恢复原行为；不能只恢复在线重建而保留声称 fail-closed（失败关闭）的健康端点。

**Stop and report（停止并汇报）：** 类型边界、`number[]` 保留位置、索引 miss（未命中）行为、健康错误码、模型调用计数和全量门禁。等待 review（审核）。

## Task 8（任务 8）：显式运行时配置与供应商失败边界

**Precondition（前置条件）：** Task 7（任务 7）通过；本 Task（任务）不调用真实供应商。

**Files（文件）：**

- Create（创建）：`src/server/runtime-config.ts`
- Create（创建）：`src/server/runtime-config.test.ts`
- Create（创建）：`src/server/upstream-error.ts`
- Create（创建）：`src/server/upstream-error.test.ts`
- Modify（修改）：`src/server/agent-contract.ts`
- Modify（修改）：`src/server/health.ts`
- Modify（修改）：`src/server/health.test.ts`
- Modify（修改）：`src/server/pipeline.ts`
- Modify（修改）：`src/server/pipeline-retrieval.test.ts`
- Modify（修改）：`src/retrieval/embeddings.ts`
- Modify（修改）：`src/retrieval/embeddings.test.ts`
- Modify（修改）：`src/retrieval/index-store.ts`
- Modify（修改）：`src/retrieval/rerank.ts`
- Modify（修改）：`src/retrieval/retrieve.ts`
- Modify（修改）：`src/eval/judge.ts`
- Modify（修改）：`src/eval/metrics/generation-metrics.ts`
- Modify（修改）：`src/eval/runner-protocol.test.ts`
- Modify（修改）：`app/api/ask/route.ts`
- Modify（修改）：`app/api/generate/route.ts`
- Modify（修改）：`app/api/fix/route.ts`
- Modify（修改）：`.env.example`
- Modify（修改）：`README.md`
- Modify（修改）：`tsconfig.json`
- Modify（修改）：`scripts/release-build-contract.test.ts`

- [x] **Step 1（步骤 1）：先写配置与泄露反例**

覆盖：

- 模型名、兼容端点、索引模型、索引目录或 query expansion（查询扩展）配置缺失/非法时返回封闭配置错误；
- 非 HTTPS（安全超文本传输协议）供应商 URL（网址）、含 credential（凭据）的 URL（网址）或未知配置字段被拒绝；
- decoder（解码器）错误、健康状态、API 响应和日志不包含环境变量原值；
- DeepSeek key（密钥）缺失只关闭 Ask/Generate/Fix（询问 / 生成 / 修复），`/api/check` 仍可用；
- Voyage key（密钥）缺失时 Ask（询问）安全返回 503，不触发索引构建；
- 上游超时、认证失败、配额、余额和未知错误分别映射到有限 502/503 错误码，不透传供应商错误体。

9 项 runtime config（运行时配置）反例和 5 项 upstream error（上游错误）反例先证明旧 route（路由）会返回 500/原始错误且缺少单一解码器；实现后覆盖配置缺失/未知/非法、URL（网址）凭据、Secret（密钥）缺失降级、DeepSeek 402、Voyage 402/429、无原始错误体和 Check（检查）旁路。

- [x] **Step 2（步骤 2）：实现单一 runtime config（运行时配置）解码器**

显式定义 DeepSeek compatible endpoint/model（DeepSeek 兼容端点 / 模型）、Voyage embedding/rerank model（Voyage 向量嵌入 / 重排模型）、`INDEX_DIR` 和查询扩展开关。代码不读取 `.env` 文件本身；本地 `dotenv`（环境变量加载器）只属于开发入口。Secret（密钥）只验证存在性，不进入可序列化配置 snapshot（快照）。

实施前已把旧的 `https://api.deepseek.com/anthropic` 与 `claude-sonnet-4-6` 组合列为待确认供应商契约；若模型/端点不能由官方契约证明，必须停止并由用户选择真实供应商配置，不能靠改环境变量名称掩盖歧义。

DeepSeek 官方契约确认 Anthropic-compatible API（Anthropic 兼容接口）端点有效，且 `claude-sonnet-*` / `claude-opus-*` 分别映射 Flash / Pro（快速模型 / 高能力模型）。经用户确认，在线回答改为无歧义的 `DEEPSEEK_ANSWER_MODEL=deepseek-v4-flash`，离线 judge（裁判）独立固定 `deepseek-v4-pro`。Voyage 官方契约确认 embedding/rerank（向量嵌入 / 重排）端点、`voyage-3` 可访问性和 `rerank-2.5` 身份；本 Task（任务）不改变已有检索模型决策。参考：[DeepSeek Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api)、[Voyage text embeddings](https://docs.voyageai.com/docs/embeddings)、[Voyage rerankers](https://docs.voyageai.com/docs/reranker)。

`src/server/runtime-config.ts` 现在是在线非敏感配置的唯一严格解码器；未知供应商字段、非 HTTPS（安全超文本传输协议）或含凭据的 URL（网址）、未显式模型/索引目录/查询扩展均封闭失败。Secret（密钥）不进入可序列化 snapshot（快照），只用于对应能力可用性检查。

- [x] **Step 3（步骤 3）：集中供应商错误映射**

Ask/Generate/Fix（询问 / 生成 / 修复）复用同一安全错误分类，不在每个 route（路由）复制字符串判断。SSE（服务器发送事件）在 headers sent（响应头已发送）后出现错误时发送封闭 error event（错误事件）并正常结束/中止，不把异常对象直接交给框架日志。

`src/server/upstream-error.ts` 集中输出 `upstream_timeout`、`upstream_authentication_failed`、`upstream_balance_exhausted`、`upstream_quota_exceeded`、`upstream_unavailable`、`upstream_request_rejected` 或 `upstream_error`，仅使用 502/503。Ask（询问）在 SSE（服务器发送事件）已开始后发送只含安全码的 `error` 事件并关闭流，不再执行 `controller.error(error)`。

- [x] **Step 4（步骤 4）：验证**

```bash
node --import tsx --test src/server/runtime-config.test.ts
node --import tsx --test src/server/upstream-error.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
npm run build
git diff --check
```

固定 Node.js 24.18.0 下，runtime config / upstream error（运行时配置 / 上游错误）专项分别通过 9 / 5 项，`npm test` 通过 152 项，TypeScript（类型系统）检查和真实 Next.js build（Next.js 构建）通过。全部供应商反例使用注入的本地 `fetch`（网络请求）响应，未调用真实 DeepSeek/Voyage；本地构建产生的 `.next/standalone/.env` 副本已立即删除，原始 `.env` 未读取或修改。

Task 8 review（任务 8 审核）期间继续全仓库核对错误类公开字段和 TypeScript（类型系统）未使用诊断，删除了无消费者的 `CorpusIndexUnavailableError.code`、`UpstreamHttpError.provider`、运行时配置快照中的重复 `answerModel` 字段及一个死类型导入。`tsconfig.json` 已启用 `noUnusedLocals` 和 `noUnusedParameters`，发布构建契约包含对应反例；其余错误字段均核实存在运行时消费者。沙箱内 Next.js build（Next.js 构建）因 Turbopack（增量构建器）禁止绑定本地端口失败，使用相同源码和命令在允许该构建行为的环境中通过。

**Rollback（回滚）：** 恢复单一 Task（任务）差异；不得恢复把 Secret（密钥）名称/值或上游原始错误体返回给客户端的旧行为。

**Stop and report（停止并汇报）：** 配置矩阵、供应商契约结论、能力降级、错误码、SSE（服务器发送事件）错误边界和无泄露证据。等待 review（审核）。

## Task 9（任务 9）：实现多阶段容器与本地镜像门禁

**Precondition（前置条件）：** Task 5-8（任务 5-8）通过；本 Task（任务）不使用真实 Voyage key（密钥），不构建有效生产索引。

**Files（文件）：**

- Create（创建）：`Dockerfile`
- Create（创建）：`.dockerignore`
- Create（创建）：`scripts/container-smoke.ts`
- Create（创建）：`scripts/container-smoke.test.ts`
- Modify（修改）：`package.json`
- Modify（修改）：`scripts/README.md`
- Modify（修改）：`src/observability/local-sink.ts`
- Modify（修改）：`src/observability/local-sink.test.ts`

- [x] **Step 1（步骤 1）：先写容器反例**

测试/冒烟流程覆盖：

- `.dockerignore` 允许 `.env`、Git 元数据、`node_modules`、`.next`、旧 `data/index`、observation/eval trace（观测 / 评估轨迹）进入构建上下文时失败；
- 宽泛排除 `data/schemas/generated` 导致已跟踪 schema closure（模式闭包）丢失时失败；
- 最终 runtime（运行时）阶段实际复用的无索引 `runtime-base` stage（运行时基础阶段）必须能启动但 readiness（就绪状态）失败，并证明 Voyage 调用为 0；不得为测试另造可误发的玩具镜像路径；
- 最终进程 uid/gid 不是 10001、根文件系统可写、`/tmp` 无上限语义、应用目录可写或 ServiceAccount token（服务账户令牌）依赖时失败；
- runtime image（运行时镜像）含 `.env`、`.git`、TypeScript（类型系统）编译器、测试文件、npm 缓存、原始 trace（轨迹）或构建凭据时失败；
- 镜像标签为空、`latest` 或部署输入不是 digest（内容摘要）时失败。

专项容器测试可以要求本机 Docker（容器工具），但不能被静态字符串测试伪装通过。`npm test` 中只运行不依赖 Docker daemon（Docker 后台服务）的纯契约部分，真实 image smoke（镜像冒烟测试）由显式命令执行。

- [x] **Step 2（步骤 2）：实现 multi-stage build（多阶段构建）**

至少建立 deps/verify/index-build/index-artifact/build/runtime（依赖 / 验证 / 索引构建 / 索引产物 / 构建 / 运行时）职责。依赖只用 `npm ci`；build（构建）复制 `.next/standalone`、`.next/static`、`public`（如存在）和运行必需 `data`，runtime（运行时）再从外部 `verified-index` BuildKit context（BuildKit 构建上下文）复制已验证索引，不复制开发依赖。

index-build stage（索引构建阶段）只能通过 BuildKit secret mount（BuildKit 密钥挂载）或审核后的等价机制读取 Voyage 索引构建凭据。构建指令不得把 key（密钥）变成 `ARG`、`ENV`、层、cache metadata（缓存元数据）或日志。Task 9（任务 9）只构建最终 runtime（运行时）真实复用的无索引 `runtime-base` stage（运行时基础阶段）和无密钥阶段；有效 `index-build/index-artifact/verified-index`（索引构建 / 索引产物 / 已验证外部索引）衔接留到 Task 11（任务 11）。

基础镜像和 runtime image（运行时镜像）必须固定 digest（内容摘要）。实施时核对“Debian bookworm-slim（Debian 精简镜像）工具链”和“最终镜像不新增 shell/curl/package manager（命令解释器 / 网络工具 / 包管理器）”能否同时满足；若选定镜像自带超出设计的工具，停止并修订设计，不静默接受。

- [x] **Step 3（步骤 3）：证明字体和构建可复现**

依赖层准备后，在 build（构建）阶段禁用网络执行 Next.js build（Next.js 构建）；任何 Google 字体或其他构建期下载都必须失败。核对 clean checkout（干净检出）与本地脏工作区构建上下文 hash（哈希）不会混用。

- [x] **Step 4（步骤 4）：运行镜像负例和内容审计**

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run container:build:runtime-base
npm run container:smoke:runtime-base
docker image inspect k8s-yaml-assistant:test-runtime-base
git diff --check
```

命令名/target（目标）可在反例测试确定后调整，但不得创建会被误发为生产的玩具索引镜像。

Task 9（任务 9）实现使用 Git 跟踪文件清单生成临时 clean context（干净构建上下文），只额外接纳本 Task（任务）尚未提交的固定容器文件；本地 2,699 个未跟踪 generated schema artifacts（生成模式产物）不会进入上下文。`.dockerignore` 独立排除环境文件、Git 元数据、依赖、旧构建、索引、观测和评估轨迹，同时契约测试保证 269 个已跟踪 schema closure（模式闭包）文件没有被宽泛规则排除。

Node.js build image（Node.js 构建镜像）固定为 `node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`。最初候选 `distroless/base-debian12`（无发行版工具的 Debian 基础运行时）在真实启动中因缺少 `libstdc++.so.6` 失败；最终改为原生包含 Node 所需 C/C++ 动态库、仍不含 shell/curl/package manager（命令解释器 / 网络工具 / 包管理器）的 `gcr.io/distroless/cc-debian12:nonroot@sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e`。两者均为支持 amd64/arm64（AMD / ARM 64 位架构）的多架构 digest（内容摘要）。

容器内 verify stage（验证阶段）运行完整测试和类型检查，build stage（构建阶段）以 `--network=none`（禁网）完成 Next.js build（Next.js 构建）。真实 `runtime-base` stage（运行时基础阶段）以 uid/gid 10001、只读根文件系统、64 MiB `/tmp`、无网络和无 ServiceAccount token（服务账户令牌）启动；liveness（存活状态）返回 200，readiness（就绪状态）因无索引返回 503/`index_missing`。索引 miss（未命中）的 fetch spy（网络请求替身）测试证明 Voyage 调用为 0，容器禁网再提供网络出口为 0 的独立证据。rootfs（根文件系统）审计确认不存在 `.env`、Git 元数据、旧索引、原始轨迹、测试、TypeScript compiler（TypeScript 编译器）、npm cache（npm 缓存）、构建凭据、shell、curl 或包管理器。

真实容器测试同时发现 overlayfs（容器联合文件系统）可能在目录删除重建后立即复用 `dev/ino`（设备号 / 索引节点号），旧 local observation sink（本地观测写入端）仅保存这两个数字会漏判根目录替换。新增反例后，sink（写入端）在初始化时使用 `O_DIRECTORY|O_NOFOLLOW`（只允许目录 / 不跟随符号链接）固定持有根目录文件描述符，阻止旧 inode（索引节点）在 sink 生命周期内被复用；未改变观测 schema（模式）、采样、脱敏、轮转或保留语义。

**Rollback（回滚）：** 删除当前 Task（任务）产生的本地测试镜像/BuildKit cache（构建缓存）属于本地可恢复清理，执行前列出精确目标；不清理其他项目镜像或用户缓存。

**Stop and report（停止并汇报）：** Docker stage（Docker 阶段）、基础镜像 digest（内容摘要）、上下文清单、禁网构建、非 root/只读验证、负例 readiness（就绪状态）和镜像内容审计。等待 review（审核）。

## Task 10（任务 10）：建立私有 GitHub 仓库、GHCR 与 Pull Request 门禁

**Precondition（前置条件）：** 用户明确选择 GitHub owner/repository（GitHub 所有者 / 仓库）、保持 private repository（私有仓库）、确认套餐和 MFA（多因素认证）；创建 remote（远程仓库）和推送分别获得当次授权。

**Files（文件）：**

- Create（创建）：`.github/CODEOWNERS`
- Create（创建）：`.github/workflows/pr-verify.yml`
- Create（创建）：`scripts/workflow-contract.test.ts`
- Modify（修改）：`package.json`
- Modify（修改）：`scripts/README.md`

- [x] **Step 1（步骤 1）：先写 workflow（流水线）安全反例**

解析真实 YAML（配置文件）并覆盖：

- PR workflow（合并请求流水线）使用 `self-hosted`、请求 write permission（写权限）、引用 Secret（密钥）、使用 `pull_request_target` 或运行索引/模型命令时失败；
- 第三方 Action（流水线动作）不是完整 commit SHA（提交哈希）时失败；
- checkout（检出）没有禁止持久化凭据、Docker（容器）任务可推送、fork（分叉仓库）路径可见受保护配置时失败；
- workflow（流水线）未运行 `npm ci`、测试、类型、schema/corpus/eval contract（模式 / 语料 / 评估契约）、build（构建）和无密钥容器负例时失败；
- 生产 runner label（运行器标签）或 production Environment（生产环境）出现在 PR workflow（合并请求流水线）时失败。

- [x] **Step 2（步骤 2）：核对实际 GitHub 能力**

在网页/官方 API（应用程序接口）只读取并记录：仓库 owner scope（所有者范围）、套餐、Environment secret（环境密钥）、immutable release（不可变发布版本）、artifact attestation（产物证明）、repository-level runner（仓库级运行器）和 branch rules（分支规则）能力。当前唯一维护者不启用 required reviewers/prevent self-review（必需审核人 / 禁止自我审核），也不声称 CODEOWNERS（代码所有者）形成独立批准。

2026-07-23 实测仓库为个人 owner（所有者）`kkxiaoa` 下的 private repository（私有仓库），默认分支为 `main`，GitHub Pro（GitHub 个人专业版）和 MFA（多因素认证）已由所有者确认。Repository rulesets（仓库规则集）接口可用且当前为 0 条；Environment（部署环境）和 repository-level runner（仓库级运行器）均为 0 个。私有仓库可创建 Environment secret（环境密钥），但 GitHub Pro（GitHub 个人专业版）不能在私有仓库使用 required reviewers/wait timer（必需审核人 / 等待计时器），因此当前不创建虚假的独立人工门禁。

immutable releases（不可变发布版本）能力可用，并在 2026-07-23 获得当次外部写入授权后启用；API（应用程序接口）回读为 `enabled=true`、`enforced_by_owner=false`，后者表示不是组织所有者策略强制，不影响仓库级开关生效。该设置只保护启用后发布的版本。私有仓库的 GitHub artifact attestation（GitHub 产物证明）要求 GitHub Enterprise Cloud（GitHub 企业云）；Task 11（任务 11）必须按既定设计单独审核 Sigstore/Cosign（Sigstore 镜像签名工具）的公开 transparency log metadata（透明日志元数据）边界。

Actions（自动化流水线）已启用，默认 `GITHUB_TOKEN` 为只读；每个 workflow job（流水线任务）仍必须单独声明更窄的实际权限。2026-07-23 只读回读为 `can_approve_pull_request_reviews=false`，对应仓库界面的 “Allow GitHub Actions to create and approve pull requests（允许流水线创建和批准合并请求）” 未启用。Release Please（发布自动化工具）使用内置 `GITHUB_TOKEN` 创建 Release Pull Request（发布合并请求）前，必须获得当次授权后启用该仓库设置，或者重新审核 GitHub App / fine-grained PAT（GitHub 应用 / 细粒度个人访问令牌）方案；不得静默扩大长期凭据。内置 `GITHUB_TOKEN` 创建的 Pull Request（合并请求）不会自行触发后续流水线，因此维护者整理 `CHANGELOG.md` 的人工提交必须触发常规 Pull Request gate（合并请求门禁），门禁完成前不得合并。获得当次授权后，仓库级 `sha_pinning_required=true` 已回读确认；当前保留 `allowed_actions=all`，但所有 Action（流水线动作）都必须引用完整 commit SHA（提交哈希）。当前 `gh` 授权缺少 `read:packages`，GHCR package（GHCR 软件包）清单留到首次推送后按最小权限核对，不为本地实现扩张长期权限。

- [x] **Step 3（步骤 3）：实现无密钥 PR workflow（合并请求流水线）**

只使用 GitHub-hosted runner（GitHub 托管运行器），权限默认 `contents: read`，从 clean checkout（干净检出）执行本地门禁和 Task 9（任务 9）的无密钥容器负例。禁止 `pull_request_target` 执行不可信代码，禁止访问 Voyage/DeepSeek/GHCR（Voyage / DeepSeek / GitHub 容器镜像仓库）写凭据。

- [x] **Step 4（步骤 4）：创建私有仓库和 GHCR 边界**

只有当次外部写入授权后才创建/配置 remote（远程仓库）、默认分支规则和 GHCR package（GHCR 软件包）归属。GHCR push（推送）只允许后续短期 `GITHUB_TOKEN`；当前阶段不注册生产 runner（运行器）、不创建 Kubernetes Secret（Kubernetes 密钥）、不推候选镜像。

remote（远程仓库）已按明确授权配置为个人私有仓库 `kkxiaoa/k8s-yaml-assistant`。`Protect main` Repository ruleset（仓库规则集）以 active（启用）状态精确保护 `refs/heads/main`，无 bypass actor（绕过者）；要求所有更新经过 Pull Request（合并请求），批准数为 0，不要求 CODEOWNERS（代码所有者）批准或 last-push approval（最后推送批准），禁止删除和 non-fast-forward push（非快进强推）。必需检查为 `PR verify`，固定来源 GitHub Actions（GitHub 自动化流水线）应用标识 `15368`，并要求针对最新默认分支进行严格检查。当前没有 GHCR package（GHCR 软件包）、Environment（部署环境）、repository-level runner（仓库级运行器）、Kubernetes Secret（Kubernetes 密钥）或候选镜像。

- [x] **Step 5（步骤 5）：验证**

```bash
node --import tsx --test scripts/workflow-contract.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
git diff --check
```

在 GitHub（代码托管平台）上使用一个不含 Secret（密钥）的 Pull Request（合并请求）验证 workflow（流水线）；fork（分叉仓库）验证不能通过向生产仓库提交恶意改动来进行，只使用受控测试仓库或官方权限证据。

本地反例先在 workflow/CODEOWNERS（流水线 / 代码所有者）文件缺失时按预期失败；实现后 `npm run workflow:check` 4/4、完整 `npm test` 164/164、schema/alias/corpus/eval contract（模式 / 别名 / 语料 / 评估契约）、TypeScript（类型检查）、Next.js build（Next.js 构建）、无索引容器构建和 fail-closed smoke test（失败关闭冒烟测试）均通过。容器构建仍使用 Task 9（任务 9）的已跟踪 clean context（干净上下文）；Task 10（任务 10）文件在提交前未进入该上下文，因此本地容器内运行的是基线 160 个测试。

2026-07-23 创建的受控 [Pull Request #1](https://github.com/kkxiaoa/k8s-yaml-assistant/pull/1) 已通过必需检查并合并到 `main`，合并提交为 `273704fb72133abed5d70678d0259de9c600c21c`。首轮 [PR verify run 29997143775](https://github.com/kkxiaoa/k8s-yaml-assistant/actions/runs/29997143775) 在 GitHub-hosted runner（GitHub 托管运行器）上对提交 `5d8d06cc960d48024558bb7833d8d95c47042baa` 成功完成全部步骤：宿主和容器内测试均为 164/164，curated closure（精选闭包）为 28 个资源入口、240 个依赖定义和 268 个文件，tracked build context（已跟踪构建上下文）为 490 个文件、3.01 MB，容器冒烟结果为 `live=200`、`ready=503/index_missing`、`provider network=none`。检查来源回读为 GitHub Actions（GitHub 自动化流水线）应用标识 `15368`，未使用 Secret（密钥）、模型、索引构建、GHCR push（GHCR 推送）、production Environment（生产环境）或 self-hosted runner（自托管运行器）。

**Rollback（回滚）：** 本地 workflow（流水线）可回退；外部仓库/规则变更先停止 Actions（自动化流水线）再恢复上一审核设置。删除仓库或 package（软件包）是破坏性操作，必须单独批准，不能作为自动回滚。

**Stop and report（停止并汇报）：** 仓库归属/套餐、MFA（多因素认证）、规则、PR 权限、Action SHA（流水线动作提交哈希）、GHCR 边界、fork（分叉仓库）结果和剩余功能差异。等待 review（审核）。

## Task 11（任务 11）：独立索引产物、Release Please 与候选发布

**Precondition（前置条件）：** Task 5-10（任务 5-10）全部通过。本地契约和流水线实现不需要模型授权；首次执行 `index-build`（索引构建）、写入 GHCR（GitHub 容器镜像仓库）、合并 Release Pull Request（发布合并请求）和人工发布 Draft Release（草稿发布版本）仍分别需要当次确认。

**Files（文件）：**

- Create（创建）：`src/release/manifest.ts`
- Create（创建）：`src/release/manifest.test.ts`
- Create（创建）：`scripts/release-manifest.ts`
- Create（创建）：`.release-please-manifest.json`
- Create（创建）：`release-please-config.json`
- Create（创建）：`.github/workflows/release.yml`
- Create（创建）：`.github/workflows/release-artifacts.yml`
- Create（创建）：`.github/workflows/index-build.yml`
- Generate and review in Release PR（在发布合并请求中生成并审核）：`CHANGELOG.md`
- Modify（修改）：`.github/workflows/pr-verify.yml`
- Modify（修改）：`Dockerfile`
- Modify（修改）：`scripts/workflow-contract.test.ts`
- Modify（修改）：`scripts/container-smoke.ts`
- Modify（修改）：`scripts/container-smoke.test.ts`
- Modify（修改）：`package.json`
- Modify（修改）：`scripts/README.md`

- [x] **Step 1（步骤 1）：先写发布所有权、索引产物和清单反例**

反例覆盖：

- `package.json`、`package-lock.json` 与 `.release-please-manifest.json` 版本漂移、占位版本 `0.0.0`、非稳定 SemVer（语义化版本）或 tag（标签）不一致时失败；
- `CHANGELOG.md` 缺状态、用途、`Unreleased`（未发布）或唯一当前版本标题，以及包含占位、绝对路径或密钥赋值时失败；
- Draft Release（草稿发布版本）不是 draft（草稿）、是 prerelease（预发布）、`tagName/targetCommitish`（标签名 / 目标提交）与 Release Please（发布自动化工具）输出不一致、发布说明缺少真实变更或 `Known limitations`（已知限制）时失败；
- release manifest（发布清单）缺 source/image/corpus/model/index/index artifact/rollback/proof identity（源码 / 镜像 / 语料 / 模型 / 索引 / 索引产物 / 回滚 / 证明身份），或者 digest/count/hash（内容摘要 / 数量 / 哈希）不一致时失败；
- Release Please（发布自动化工具）设置 `skip-github-release`、在非当前 Release Pull Request merge（发布合并请求合并）场景设置 `skip-github-pull-request`，或者把草稿、标签、版本和发布说明所有权拆回另一个流水线时失败；
- 当前 source version / Git tag / GitHub Release / active application draft / associated Pull Request（源版本 / Git 标签 / GitHub 发布版本 / 活动应用草稿 / 关联的合并请求）状态不一致、多于一个稳定 SemVer draft（语义化版本草稿）、活动草稿期间仍准备下一版本，或发布合并提交同时存在草稿时失败；
- release artifacts workflow（发布证据流水线）出现 `workflow_dispatch`（手工触发）、`VOYAGE_API_KEY`、`index:build`、`gh release create/edit`（创建 / 修改发布版本）、Git tag API（Git 标签接口）、`--notes-file`、自动 Publish（发布）或 self-hosted runner（自托管运行器）时失败；
- `index-build`（索引构建）以外任一 workflow（流水线）读取 Voyage 密钥时失败；索引工作流非手工触发、第三方 Action（流水线动作）未固定完整 SHA（提交哈希）或索引 tag（标签）使用可变名称时失败。

- [x] **Step 2（步骤 2）：固定 Release Please 的单一所有权**

Release Please（发布自动化工具）同时负责：

1. 在普通 `main` push（主分支推送）后创建或更新唯一 Release Pull Request（发布合并请求）；
2. 根据 Conventional Commit（约定式提交）更新 `package.json`、`package-lock.json`、`.release-please-manifest.json` 和 `CHANGELOG.md`；
3. Release Pull Request（发布合并请求）合并后创建 Draft Release（草稿发布版本），并生成正文；
4. 输出 `release_created/sha/tag_name/version`（发布已创建 / 提交 / 标签名 / 版本）给同一次 workflow run（流水线运行）的候选任务。

`release-please-config.json` 使用 `draft: true`。GitHub 官方语义是：创建 Draft Release（草稿发布版本）时只有 `tag_name/target_commitish`（标签名 / 目标提交）关联，不创建 Git tag（Git 标签）；维护者点击 Publish（发布）时才创建标签并产生 `release.published`（发布版本已发布）事件。

`manifest.ts` 不再从 `CHANGELOG.md` 摘取正文，也不生成 `release-notes.md`。它只验证源码版本与完整 changelog identity（变更日志身份），再对 Release Please（发布自动化工具）已经写入 Draft Release（草稿发布版本）的正文执行安全校验和 SHA-256（安全哈希算法）绑定。release artifacts workflow（发布证据流水线）不能修改该正文。

每次 `main` push（主分支推送）先由独立 state inspection job（状态检查任务）读取源码版本、GitHub Release（GitHub 发布版本）、实际 Git tag（Git 标签）和当前提交关联的 Pull Request（合并请求），再决定是否调用 Release Please（发布自动化工具）：

1. 首发占位版本且没有发布历史，或当前版本已有匹配的正式发布版本与真实标签：允许创建或更新 Release Pull Request（发布合并请求）。
2. 当前提交正是 Release Pull Request merge（发布合并请求合并），且该版本尚无草稿、正式发布版本或真实标签：调用 Release Please（发布自动化工具）创建当前 Draft Release（草稿发布版本），同时设置 `skip-github-pull-request: true`，禁止同一次运行继续创建下一版本发布合并请求。
3. 当前版本已有唯一、同版本且目标提交属于 `main` 历史的活动应用草稿：跳过 Release Please（发布自动化工具），普通功能开发和合并继续，但下一版本准备延后到当前草稿 Publish（发布）后出现新的 `main` push（主分支推送）。
4. 其余缺标签、缺正式发布版本、版本不一致、多草稿或目标提交漂移状态一律 fail-closed（失败关闭），不猜测修复。

稳定 `v<SemVer>` tag（语义化版本标签）保留给应用发布，只有这类 Draft Release（草稿发布版本）参与互斥；明确使用其他命名空间的 operational draft（运维草稿）不阻塞应用发布。Release Pull Request（发布合并请求）还包含一个不检出代码、不运行第三方 Action（流水线动作）的隔离状态任务：如果已经存在活动应用草稿，则在源码门禁前拒绝该发布合并请求。必需的 `PR verify`（合并请求验证）任务即使依赖门禁失败也会启动并显式失败，不能退化为可能被规则集接受的 `skipped`（已跳过）结论。该状态任务用于防御旧的、竞态产生的或人工误保留的下一版本发布合并请求，不能替代主分支状态检查。

首轮真实运行确认两个首发边界：没有历史 Release（发布版本）时，Node release type（Node 发布类型）默认生成 `1.0.0`；使用 merge commit（合并提交）合并同一个 `feat:` 提交时，原提交和包含相同正文的合并提交会分别进入发布说明。仓库已改为只允许 Squash merge（压缩合并），默认使用 Pull Request title（合并请求标题）且提交正文留空，后续 `main` 对每个合并请求只保留一个 Conventional Commit（约定式提交）。

当前 `.release-please-manifest.json` 仍为 `0.0.0` 时，`release-please-config.json` 必须使用一次性 `release-as: 0.1.0` 强制首发版本，并以 `bump-minor-pre-major: true` 固定 `1.0.0` 前的破坏性变更策略。Release Pull Request #3（发布合并请求 #3）更新为 `0.1.0` 后，维护者必须在该分支删除一次性 `release-as`，保留长期版本策略，并补齐 `CHANGELOG.md` 的状态、用途、`Unreleased`（未发布）、单一真实用户变化与 `Known limitations`（已知限制）；其 Pull Request body（合并请求正文）也必须删除重复变化并增加同一已知限制，因为 Release Please（发布自动化工具）会从该正文解析 Draft Release（草稿发布版本）的发布说明。常规 Pull Request gate（合并请求门禁）和正式索引检查通过前不得合并。

- [x] **Step 3（步骤 3）：把付费索引构建拆成独立、可复用产物**

`.github/workflows/index-build.yml` 是唯一可读取 `VOYAGE_API_KEY` 的 workflow（流水线），且只允许管理员手工 `workflow_dispatch`（手工触发）：

1. `inspect`（检查）在接触 Secret（密钥）前执行源码、语料、测试、类型和流水线门禁，并根据 `formatVersion + corpus identityVersion + corpus manifest hash + embedding model`（格式版本 + 语料身份版本 + 语料清单哈希 + 向量模型）计算确定性 `indexHash`（索引哈希）与 `index-v5-<indexHash>` 标签；`RELEASE_INDEX_EMBEDDING_MODEL` 是受版本控制的单一模型来源，三个 workflow（流水线）不得再传入模型字面量，Dockerfile（容器构建文件）只接收由该身份输出形成的构建参数；
2. 已存在的 GHCR index artifact（GHCR 索引产物）必须先解析为 digest（内容摘要），通过固定 workflow identity（流水线身份）的 Cosign（签名工具）验证，并完整读取 `manifest.json/chunks.jsonl/embeddings.f32` 校验；有效则结束，不重复调用 Voyage；
3. 只有明确的 `manifest unknown/not found`（清单未知 / 未找到）才进入受保护 `index-build` Environment（索引构建环境）；网络、鉴权、签名或内容异常一律 fail-closed（失败关闭），不能误当“缺失”后付费重建；
4. `build`（构建）通过 BuildKit secret mount（BuildKit 密钥挂载）生成真实全量索引，推送 `ghcr.io/kkxiaoa/k8s-yaml-assistant-index:<identity>`，回读 digest（内容摘要）、完整校验索引并做 Cosign keyless signature（Cosign 无密钥签名）。

Dockerfile（容器构建文件）中的 `index-artifact`（索引产物）目标是只包含 `/data/index` 的 scratch image（空基础镜像）。最终应用 `runtime`（运行时）目标只能通过 `verified-index=docker-image://...@sha256:...` 外部 BuildKit build context（构建上下文）复制索引；候选构建不依赖 `index-build` 阶段，也不接触 Voyage 密钥。最终应用镜像仍把索引烘焙到 `/app/data/index`，因此生产不需要 PVC（持久卷声明）、Kubernetes Job（Kubernetes 任务）、数据库或向量数据库，Pod（容器组）重启也不会重建索引。

Release Pull Request（发布合并请求）额外运行一个不检出 PR head（合并请求头部提交）、不执行不可信代码的 `release_index`（发布索引）任务：它只检出受保护 `main`，确认当前 identity（身份）的索引 digest（内容摘要）存在且签名有效。普通 Pull Request（合并请求）不读取 GHCR（GitHub 容器镜像仓库），也不会被索引状态阻塞。索引工作流完成后需人工 rerun（重新运行）失败的 Release Pull Request check（发布合并请求检查）。

- [x] **Step 4（步骤 4）：实现无人工参数的候选衔接**

Release Pull Request（发布合并请求）合并后，`.github/workflows/release.yml` 的同一次 Release lifecycle run（发布生命周期流水线运行）只在 `release_created == true` 时调用 `.github/workflows/release-artifacts.yml` reusable workflow（可复用发布证据流水线）。维护者不需要查找 PR ID（合并请求标识）、输入 source SHA（源提交哈希）、版本或标签；这些值全部来自 Release Please（发布自动化工具）输出。

发布证据流水线分为：

1. `verify`（验证）：检出已通过受保护 Pull Request（合并请求）门禁的精确 source SHA（源提交哈希），只复核 release identity / Draft Release / index artifact（发布身份 / 草稿发布版本 / 索引产物）这些发布期状态；首次读取并校验草稿后，把该 JSON snapshot（JSON 快照）作为保留 1 天的 GitHub Artifact（GitHub 任务产物）传给后续构建。不重复执行 schema、corpus、eval、测试、类型检查、Next.js 构建或无索引容器门禁。最终 `runtime` Docker build（运行时容器构建）仍通过 Dockerfile 的 `verify` 与 `build` 阶段执行 `npm test`、TypeScript type check（TypeScript 类型检查）和 Next.js build（Next.js 构建）；
2. `build`（构建）：下载已校验草稿快照，以索引 digest（内容摘要）作为只读外部 build context（构建上下文）构建应用镜像，执行 ready smoke test（就绪冒烟测试）、镜像内容审计、Trivy（容器漏洞扫描）、SPDX SBOM（SPDX 软件物料清单）、SLSA provenance（SLSA 来源证明）和 Cosign（签名工具）门禁，生成严格 release manifest（发布清单）。它不再读取 GitHub Draft Release（GitHub 草稿发布版本），因此 `contents:read` 足够；
3. `attach`（附加）：上传前重新读取草稿并确认正文哈希仍与 release manifest（发布清单）一致，只使用 `gh release upload --clobber` 把六项证据附加到既有草稿，随后再次回读正文与资产、下载文件并逐项核验。三次草稿读取分别对应初始受信快照、外部写入前防漂移和外部写入后回读，不在同一信任边界重复计算；该任务没有创建/编辑发布版本、创建标签或 Publish（发布）的能力。

GitHub 将 Draft Release（草稿发布版本）读取限制给具有 push access（推送权限）的身份，因此直接读取草稿的 `verify`（验证）、`attach`（附加）、主分支状态检查和手工草稿解析任务声明 `contents:write`；它们各自只在需要的步骤注入令牌。`build`（构建）只使用 `contents:read + packages:write + id-token:write`（仓库读取 + 软件包写入 + 身份令牌写入）。checkout（检出）均保持 `persist-credentials:false`，只有 `attach`（附加）调用上传命令。

若索引缺失，Release Pull Request（发布合并请求）应先失败；若被绕过或发布证据阶段才发现缺失，该流水线同样 fail-closed（失败关闭）。外部瞬时故障且 workflow（工作流）代码不变时，在原 Release lifecycle run（发布生命周期流水线运行）点击 rerun failed jobs（重新运行失败任务）。若故障需要修改 workflow（工作流），旧运行仍固定使用旧提交，必须先通过 Pull Request（合并请求）合入修复，再在 `main` 手工运行 `Release lifecycle`（发布生命周期）：`resolve_draft`（解析草稿）不运行 Release Please（发布自动化工具）、不接收身份参数，而是从受保护 `main` 的版本推导当前草稿，只接受该版本、未发布状态和 `main` 祖先 source SHA（源提交哈希）；`recover_artifacts`（恢复证据）对同一 source SHA（源提交哈希）重新执行完整证据流水线。手工运行时 `GITHUB_SHA` 指向当前 `main`，并不等于旧草稿目标提交，因此不能把两者相等作为门禁；真实约束是草稿目标属于 `main` 历史、该提交内版本匹配、检出结果等于目标提交。发布源提交中的 CLI（命令行接口）仍可能是修复前版本，所以恢复工作流保持其既有命令契约，并通过任务产物传递草稿快照。不改变 package version（包版本），也不创建第二个 Draft Release（草稿发布版本）。

开发流程不等待某次 release finalize（发布收口）：Release Pull Request（发布合并请求）未合并时，后续 `feat/fix`（功能 / 修复）提交继续进入同一个 PR（合并请求）并刷新版本与 changelog（变更日志）。Release Pull Request（发布合并请求）合并并形成活动草稿后，普通功能合并仍可进入 `main`，但状态门禁暂停下一版本发布合并请求，避免一个尚未人工 Publish（发布）的源码版本被 Release Please（发布自动化工具）错误视为已发布基线。只有维护者决定合并时才冻结一个发布 source commit（源提交）。

- [x] **Step 5（步骤 5）：固定六项证据与本地门禁**

候选 Draft Release（草稿发布版本）只附加：

1. `sbom.spdx.json`：SPDX SBOM（SPDX 软件物料清单）。
2. `provenance.slsa.json`：SLSA provenance（SLSA 来源证明）。
3. `release-manifest.json`：版本、源码、Release Please notes hash（发布说明哈希）、镜像、索引产物、回滚和证明身份。
4. `sbom-attestation.sigstore.json`：绑定镜像 digest（内容摘要）的软件物料清单证明包。
5. `provenance-attestation.sigstore.json`：绑定同一镜像 digest（内容摘要）的来源证明包。
6. `release-manifest.sigstore.json`：绑定发布清单文件摘要的签名包。

当前私有仓库与 GitHub Pro（GitHub 专业版）采用固定 Cosign `v3.1.2`（签名工具版本）的 keyless signing（无密钥签名），并接受 Sigstore transparency log（Sigstore 透明日志）公开 workflow identity/digest metadata（流水线身份 / 摘要元数据）。未来主代码开源后可以切换到 GitHub artifact attestation（GitHub 产物证明），但六项证据和 digest binding（内容摘要绑定）语义不变。

本地验证命令：

```bash
node --import tsx --test src/release/manifest.test.ts
node --import tsx --test scripts/workflow-contract.test.ts
node --import tsx --test scripts/container-smoke.test.ts
npm run release:check
npm run workflow:check
npm test
npm run typecheck
npm run schemas:check
npm run corpus:closure
npm run eval:check
npm run build
npm run container:build:runtime-base
npm run container:smoke:runtime-base
git diff --check
```

2026-07-26 本地门禁结果：本轮相关定向契约 45/45、`npm run release:check` 9/9、`npm run workflow:check` 6/6、完整测试 208/208、TypeScript（类型检查）、schema/corpus/eval contract（模式 / 语料 / 评估契约）、Next.js build（Next.js 构建）和 `git diff --check` 全部通过。真实 clean-context container build（干净上下文容器构建）首次暴露“未暂存的 Task 11（任务 11）新文件未进入临时上下文”，先新增反例再把明确审核文件加入白名单；修复后容器内 208/208 与类型检查通过，无索引 runtime-base smoke test（运行时基础镜像冒烟测试）为 `live=200`、`ready=503/index_missing`、`provider network=none`。本轮未调用模型、未重建索引、未推送 GHCR（GitHub 容器镜像仓库）、未创建 Release（发布版本）或 Git tag（Git 标签）。

2026-07-26 外部执行结果：`index-build` Environment（索引构建环境）只允许 `main` 并只含 `VOYAGE_API_KEY` 环境密钥，repository variable（仓库变量）`CURRENT_PRODUCTION_DIGEST` 为 `none`。手工运行 `30171546490` 对 8,410 条语料执行一次 Voyage document embedding（Voyage 文档向量嵌入），成功生成、回读校验并签名独立索引产物；Release Pull Request #3（发布合并请求 #3）的索引门禁随后通过并压缩合并为 `aa3baeb047241f0bf3ead262c10b48f26f577a2c`。Release lifecycle run（发布生命周期运行）`30192091050` 创建了 `v0.1.0` Draft Release（草稿发布版本），但证据 `verify`（验证）任务以 `contents:read` 读取仅对 push access（推送权限）可见的草稿时返回 `release not found`，在构建候选镜像前失败关闭。后续恢复审查发现的最小权限、旧 source commit（源提交）兼容和重复准备下一版本问题已由 Pull Request #6（合并请求 #6）合入 `423e18e6537a1b6fa5c8c6bf4bf0c2766d15bce2`；自动运行 `30208015368` 正确暂停 Release Please（发布自动化工具）。无参数恢复运行 `30208130964` 随后成功解析既有草稿、验证 8,410 条签名索引、构建并推送旧源码候选、执行就绪冒烟、导出 SLSA provenance（SLSA 来源证明）并生成 SPDX SBOM（SPDX 软件物料清单），但 Trivy（容器漏洞扫描器）拒绝了 5 项 `HIGH`（高危）依赖漏洞，后续签名、发布清单和附件任务均未执行。草稿仍指向 `aa3baeb047241f0bf3ead262c10b48f26f577a2c`，没有附件或实际 Git tag（Git 标签），K3s（轻量 Kubernetes）保持零变化。

2026-07-26 运行时安全修复本地证据：先以反例固定安全版本与 Pull Request（合并请求）镜像扫描契约，再把 Next.js（Next.js 框架）升级到 `16.2.12`、`sharp`（图像处理库）统一到 `0.35.3`、`js-yaml`（YAML 解析库）升级到 `4.3.0`，并把 `postcss`（CSS 处理库）统一到 `8.5.23`。`npm audit --omit=dev`（npm 生产依赖安全审计）不再包含 `HIGH/CRITICAL`（高危 / 严重），仍有 2 项来自 Monaco Editor（Monaco 编辑器）固定 DOMPurify（HTML 清理库）的 `MODERATE`（中危）报告，当前不属于高危发布阻断但必须保留为遗留风险。本地 214/214 测试、类型检查、Next.js 构建、无索引容器构建和失败关闭烟测通过；固定 Trivy `0.70.0` 对真实运行镜像扫描结果为 0 项 `HIGH/CRITICAL`（高危 / 严重）。

- [ ] **Step 6（步骤 6）：执行首次独立索引和候选发布**

外部执行前必须核对：

- `index-build` GitHub Environment（索引构建环境）只含专用 `VOYAGE_API_KEY` Environment secret（环境密钥）；
- repository variable（仓库变量）`CURRENT_PRODUCTION_DIGEST` 首次为 `none`，以后为当前生产镜像 digest（内容摘要）；
- Actions（自动化流水线）可创建 Release Pull Request（发布合并请求），GHCR（GitHub 容器镜像仓库）写入和读取权限符合最小权限；
- `v*` tag ruleset（标签规则集）允许维护者从 Draft Release（草稿发布版本）人工 Publish（发布），同时禁止非审核路径改写或删除已发布标签；
- 当次 Voyage document embedding（Voyage 文档向量嵌入）费用、GHCR push（GHCR 推送）、Release Pull Request（发布合并请求）合并和 Draft Release（草稿发布版本）人工发布分别获得确认。

首次索引和 Release Pull Request #3（发布合并请求 #3）已经完成，不得为了恢复候选而重复调用 Voyage。错误的 Pull Request #5（合并请求 #5）已经关闭；旧草稿源码的运行时漏洞不能通过重跑旧提交修复。安全修复合并请求通过全部门禁并合入 `main` 后，管理员必须先把尚未发布、无附件的 `v0.1.0` 草稿目标重定向到该精确合并提交，并把已审核的 `0.1.0` changelog（变更日志）安全修复写入草稿发布说明；不得指向分支名或未审核提交。随后手工运行无参数 `Release lifecycle`（发布生命周期），由 `resolve_draft`（解析草稿）重新校验版本、目标提交和 `main` 祖先关系，再由 `recover_artifacts`（恢复证据）完整构建新候选镜像和六项证据。候选通过后仅停在草稿页面，K3s（轻量 Kubernetes）零变化；维护者审核六项证据和 `v*` tag ruleset（标签规则集）后才另行决定是否点击 Publish（发布）。

**Rollback（回滚）：** 索引或候选失败时保留 digest（内容摘要）作为审计证据但不发布；修复应生成新身份或新应用 source SHA（源提交哈希），不得覆盖已审核 digest（内容摘要）。凭据疑似泄露时立即吊销、暂停 `index-build`（索引构建）、审核日志和费用；保留或删除 Draft Release（草稿发布版本）都不会部署，只有 Publish（发布）才进入后续生产流水线。

**Phase 2 Stop（阶段 2 停止点）：** 汇报本地门禁、Release Pull Request（发布合并请求）版本/changelog（变更日志）、独立索引调用次数与费用、索引 digest/signature（内容摘要 / 签名）、应用镜像 digest（内容摘要）和大小、漏洞、六项证据、Draft Release（草稿发布版本）正文及“生产 K3s 零变化”证据。等待独立 review（审核），不得未经审核点击 Publish（发布）。

## Phase 3（阶段 3）：私有部署与直接发布验证

## Task 12（任务 12）：先设计 privileged deployment adapter（特权部署适配器）

**Precondition（前置条件）：** Phase 1（阶段 1）和 Phase 2（阶段 2）均通过；当前 draft Release（草稿发布版本）仍未发布。

**Authority（授权）：** 只编写 deployment adapter（部署适配器）的 design/plan（设计 / 计划）；不得在同一 Task（任务）实现、安装、注册 runner（运行器）或发布应用。

**Files（文件）：**

- Create（创建）：`docs/superpowers/specs/2026-07-20-k3s-deployment-adapter-design.md`
- Create（创建）：`docs/superpowers/plans/2026-07-20-k3s-deployment-adapter.md`
- Modify（修改）：`docs/README.md`

- [ ] **Step 1（步骤 1）：重新核对真实部署面**

只读核对 K3s（轻量 Kubernetes）版本、Namespace/Deployment/container（命名空间 / 工作负载 / 容器）最终名称、GHCR repository（GHCR 仓库）、证明格式、runner scope（运行器范围）、服务器 CPU 架构、可用验证工具和 systemd（系统服务管理器）边界。不能根据本文占位名称编写命令。

- [ ] **Step 2（步骤 2）：定义最小输入协议**

适配器只接受固定动作和封闭输入：

```text
deploy sha256:<64-hex> <bounded-provenance-bundle>
rollback sha256:<64-hex> <bounded-provenance-bundle>
```

Phase 4（阶段 4）审核前不实现 `set-access-mode`。目标 registry/repository/namespace/deployment/container（镜像仓库 / 命名空间 / 工作负载 / 容器）全部编译或 root-owned config（root 所有配置）固定；禁止命令、路径、URL（网址）、任意 manifest（清单）和额外 `kubectl` 参数输入。

- [ ] **Step 3（步骤 3）：选择实现与证明验证边界**

设计必须选择可测试的实现语言、锁/并发协议、超时、幂等、原子状态台账、日志 schema（模式）、systemd/sudoers（系统服务 / 提权规则）和升级方式。签名/证明验证复用固定版本 GitHub CLI（GitHub 命令行工具）或 Cosign（镜像签名工具），不自研密码算法。

必须明确 runner（运行器）不持有完整 kubeconfig（Kubernetes 客户端配置）、模型 Secret（密钥）、SSH 私钥、Docker socket（Docker 套接字）或 registry push token（镜像仓库推送令牌）；root-owned adapter（root 所有适配器）在本机访问 K3s API（K3s 应用程序接口）。

- [ ] **Step 4（步骤 4）：定义先失败后实现的测试矩阵**

至少覆盖参数注入、错误 registry/repository（镜像仓库）、非 SHA-256、证明包超限/篡改/identity（身份）不符、subject digest（主体内容摘要）不符、未验收回滚 digest（内容摘要）、并发发布、锁遗留、超时、部分失败、readiness（就绪状态）失败、自动恢复失败、重复执行、日志泄露和 runner offline（运行器离线）。测试必须在隔离 fixture cluster/fake adapter boundary（夹具集群 / 伪适配器边界）运行，不能用生产集群试错。

- [ ] **Step 5（步骤 5）：单独 review（审核）**

design（设计）先审核，确认后再完成实施 plan（计划）的文件和步骤；不能以本总计划已审核代替适配器 review（审核）。

**Rollback（回滚）：** 仅文档差异，无服务器变更。

**Stop and report（停止并汇报）：** 输入协议、实现选择、trust root/workflow identity（信任根 / 工作流身份）、权限、锁/回滚、测试矩阵和未解决风险。等待独立 review（审核）。

## Task 13（任务 13）：实现适配器、Kubernetes bootstrap（Kubernetes 引导配置）和生产 runner（运行器）

**Precondition（前置条件）：** Task 12（任务 12）的 design/plan（设计 / 计划）通过；服务器 bootstrap（引导配置）、GitHub runner registration（GitHub 运行器注册）和 Kubernetes Secret（Kubernetes 密钥）创建分别获得当次授权。

**Files（文件）：**

- Implement（实现）：以 Task 12（任务 12）审核后的适配器 plan（计划）为准
- Create（创建）：`deploy/k8s/bootstrap/namespace.yaml`
- Create（创建）：`deploy/k8s/bootstrap/service-account.yaml`
- Create（创建）：`deploy/k8s/bootstrap/config-map.yaml`
- Create（创建）：`deploy/k8s/bootstrap/service.yaml`
- Create（创建）：`deploy/k8s/bootstrap/observation-pvc.yaml`
- Create（创建）：`deploy/k8s/bootstrap/network-policy.yaml`
- Create（创建）：`deploy/k8s/app/deployment-template.yaml`
- Create（创建）：`deploy/k8s/README.md`
- Modify（修改）：`scripts/deployment-contract.test.ts`
- Modify（修改）：`scripts/workflow-contract.test.ts`

- [ ] **Step 1（步骤 1）：先写资源和权限反例**

解析真实 Kubernetes（容器编排系统）资源并覆盖：

- Namespace（命名空间）缺 restricted Pod Security（受限 Pod 安全）标签失败；
- ServiceAccount（服务账户）自动挂载 token（令牌）、绑定 RBAC（基于角色的访问控制）或可以读 Secret/ConfigMap（密钥 / 普通配置）时失败；
- Service（服务）不是 ClusterIP（集群内地址）或出现 NodePort/LoadBalancer（节点端口 / 负载均衡器）时失败；
- Deployment（工作负载）不是单副本、不是 digest（内容摘要）、缺 non-root/read-only/seccomp/drop capabilities（非 root / 只读 / 系统调用限制 / 删除能力）、资源边界、探针或 `revisionHistoryLimit=3` 时失败；
- 索引目录/PVC（持久卷声明）可写、observation PVC（观测持久卷声明）被用于索引/计量/Secret（密钥）或 `/tmp` 没有 size limit（大小上限）时失败；
- `maxSurge` 非 0、`maxUnavailable` 非 1，或出现第二个 observation writer（观测写入端）时失败；
- ConfigMap（普通配置）包含 Secret（密钥）、非法 `ACCESS_MODE`、未显式索引/模型/observation（观测）配置时失败；
- 仓库出现 base64 Secret（Base64 编码密钥）、完整 kubeconfig（客户端配置）或真实 pull token（拉取令牌）时失败。

- [ ] **Step 2（步骤 2）：实现固定非敏感资源和模板**

bootstrap（引导配置）只包含 Namespace（命名空间）、安全标签、ServiceAccount（服务账户）、ConfigMap（普通配置）、ClusterIP Service（集群内服务）、NetworkPolicy（网络策略）和 observation PVC（观测持久卷声明）等固定非版本资源；不提前创建已运行应用版本。

root-owned deployment template（root 所有工作负载模板）固定 replicas/resources/probes/securityContext/volumes（副本 / 资源 / 探针 / 安全上下文 / 卷）和目标名称，只留由适配器注入且严格校验的 image digest（镜像内容摘要）。`ACCESS_MODE=private` 显式配置，缺失/非法仍由应用解释为 private（私有）。

第一轮资源候选沿用已审核设计：CPU requests/limits（处理器请求 / 上限）为 500m/2，memory requests/limits（内存请求 / 上限）为 768 MiB/2 GiB，ephemeral-storage requests/limits（临时存储请求 / 上限）为 256 MiB/1 GiB；`fsGroup=10001`、`fsGroupChangePolicy=OnRootMismatch`。这些只是私有压测候选值，不能在 Task 20（任务 20）实测前写成容量承诺。

- [ ] **Step 3（步骤 3）：安全创建运行时凭据**

从外部密码管理器通过服务器本地受限临时输入创建分职责 Kubernetes Secret（Kubernetes 密钥）和只读 imagePullSecret（镜像拉取密钥）。不使用会把值留在 shell history/process list（命令历史 / 进程列表）的参数，不把生成 YAML（配置文件）、base64（Base64 编码）或 Secret（密钥）值保存到仓库/对话。创建后删除受控临时输入并验证权限；删除前列出精确文件并确认不包含其他数据。

- [ ] **Step 4（步骤 4）：安装适配器与生产 runner（运行器）**

按 Task 12（任务 12）安装 root-owned adapter（root 所有适配器）、独立无登录非 root runner account（运行器账号）、最小 sudoers（提权规则）和 systemd service（系统服务）。runner（运行器）不加入 docker group（Docker 组），不 checkout（检出）源码，不监听公网端口，只出站 443。

GitHub organization（GitHub 组织）能力允许时使用只授权当前仓库/固定 workflow（工作流）的 runner group（运行器组）；个人私有仓库只能 repository-level runner（仓库级运行器）时，记录并接受较低隔离保证，不能用 label（标签）冒充访问控制。

- [ ] **Step 5（步骤 5）：只验证 bootstrap（引导配置），不发布应用**

```bash
sudo k3s kubectl apply --server-side --dry-run=server -f <reviewed-bootstrap-dir>
sudo k3s kubectl apply -f <reviewed-bootstrap-dir>
sudo k3s kubectl -n <namespace> get all,configmap,pvc,networkpolicy
sudo systemctl status <runner-service>
sudo ss -lntup
```

尖括号在执行时替换为审核后的固定值。确认 80/443 仍未公开、6443 未公开、runner（运行器）没有收到任务、Deployment（工作负载）尚未存在。

**Rollback（回滚）：** runner/adapter（运行器 / 适配器）异常时先在 GitHub 禁用 runner（运行器）并停止本地服务。删除 Namespace/PVC/Secret（命名空间 / 持久卷声明 / 密钥）是有状态破坏操作，必须先列出全部资源并单独批准；优先保留状态并撤销入口。

**Stop and report（停止并汇报）：** 资源 diff（差异）、server-side dry-run（服务端试运行）、Secret（密钥）职责/权限但不含值、runner scope（运行器范围）、sudoers（提权规则）、监听端口、适配器测试和“应用尚未部署”证据。等待 review（审核）。

## Task 14（任务 14）：验证 draft → publish → direct deploy（草稿 → 发布 → 直接部署）和回滚

**Precondition（前置条件）：** Task 13（任务 13）通过；发布 Task 11（任务 11）的 draft Release（草稿发布版本）、执行首次私有部署和有限模型 smoke test（冒烟测试）分别获得明确授权。

**Files（文件）：**

- Create（创建）：`.github/workflows/published-release-deploy.yml`
- Create（创建）：`.github/workflows/rollback-candidate.yml`
- Modify（修改）：`scripts/workflow-contract.test.ts`
- Modify（修改）：`src/release/manifest.ts`
- Modify（修改）：`src/release/manifest.test.ts`

- [ ] **Step 1（步骤 1）：先写 direct deploy（直接部署）反例**

覆盖：

- deploy workflow（部署流水线）由 `workflow_dispatch`、push、Pull Request（推送 / 合并请求）或 draft release（草稿发布版本）触发时失败；只允许 `release: types: [published]`；
- GitHub-hosted validation job（GitHub 托管验证任务）未重新验证 release/tag/commit/manifest/digest/provenance（发布版本 / 标签 / 提交 / 清单 / 内容摘要 / 来源）时失败；
- self-hosted job（自托管任务）运行 checkout（检出）、第三方 Action（流水线动作）、仓库脚本、任意下载、shell input interpolation（命令输入插值）或持有模型/SSH/GHCR/Kubernetes secret（模型 / SSH / 镜像仓库 / Kubernetes 密钥）时失败；
- 部署输入不是确认过的 digest/provenance bundle（内容摘要 / 来源证明包）、并发组允许 cancel（取消）在途部署或重跑可替换新 digest（内容摘要）时失败；
- rollout（滚动发布）失败不恢复上一 digest（内容摘要）、回滚可选择发布台账外镜像或无新人工确认时失败；
- draft（草稿）保存/删除能创建 GitHub deployment（GitHub 部署记录）或改变 K3s 时失败。

- [ ] **Step 2（步骤 2）：实现 published release（已发布版本）验证与部署工作流**

GitHub-hosted job（GitHub 托管任务）只做不可变身份验证，成功后才调度生产 runner（运行器）。生产 job（任务）不 checkout（检出），只调用已安装的固定适配器；`production-deploy` concurrency（生产部署并发）设置 `cancel-in-progress=false`。记录 Release ID（发布版本标识）、发布确认账号、前后 digest（内容摘要）、workflow run（流水线运行）和结果，不记录 payload（负载）或 Secret（密钥）。

- [ ] **Step 3（步骤 3）：先证明草稿不部署**

保留、编辑和删除一个受控测试 draft Release（草稿发布版本），确认生产 runner（运行器）没有 job（任务）、K3s 中没有应用 Deployment（工作负载）、GitHub deployment（GitHub 部署记录）没有成功记录。不得用“暂时关闭 runner（运行器）”掩盖触发器错误。

- [ ] **Step 4（步骤 4）：人工发布并执行首次 direct deploy（直接部署）**

唯一维护者逐项核对 release manifest（发布清单）、漏洞、索引身份、候选/回滚 digest（内容摘要）和维护窗口后，手工点击 Publish release（发布版本）。验证只有发布事件触发适配器创建固定单副本 Deployment（工作负载），实际运行 image ID（镜像标识）等于确认 digest（内容摘要）。

- [ ] **Step 5（步骤 5）：通过隧道完成私有验收**

80/443 继续不公开。只通过固定来源 SSH tunnel/port-forward（SSH 隧道 / 端口转发）验证：

- live/ready（存活 / 就绪）、索引身份和零在线重建；
- `/api/check` 无模型工作流；
- Ask/Generate/Fix（询问 / 生成 / 修复）仅在另行批准的非敏感输入、次数和费用内 smoke test（冒烟测试）；
- DeepSeek/Voyage key（密钥）失效、供应商超时和索引篡改的安全行为；
- non-root/read-only root filesystem（非 root / 只读根文件系统）、资源请求/上限和冷启动 RSS（常驻内存）；
- observation（观测）候选配置、脱敏、轮转、7 天/256 MiB、人工删除、symlink（符号链接）拒绝和失败无原文回退；
- rollout（滚动发布）期间最多一个 writer（写入端）和单副本短暂不可用边界；
- 日志无 YAML、prompt、answer、Secret（YAML / 提示词 / 回答 / 密钥）或供应商错误体。

- [ ] **Step 6（步骤 6）：演练自动与人工确认回滚**

用经审核的故障候选证明 rollout timeout（滚动发布超时）会在同一已确认任务内恢复上一 digest（内容摘要）。功能回归则生成只引用发布台账内历史 digest（内容摘要）的新 draft rollback release（草稿回滚发布版本），再次人工发布后回滚。不能通过重跑旧 workflow（流水线）绕过确认。

**Rollback（回滚）：** 运行器/工作流边界异常时先禁用 runner（运行器）、停止本地服务并保持 80/443 关闭；必要时从固定来源 SSH 使用同一已验收 digest（内容摘要）break-glass rollback（紧急回滚），事后补录。不得开放公网 22/6443。

**Phase 3 Stop（阶段 3 停止点）：** 汇报草稿不部署证据、人工发布证据、实际 digest（内容摘要）、runner/workflow（运行器 / 流水线）权限、私有功能/安全反例、模型调用次数/费用、RSS（常驻内存）、observation（观测）文件生命周期、单写入端和两类回滚。等待独立 review（审核）。

## Phase 4（阶段 4）：域名、TLS、认证与保护

## Task 15（任务 15）：实现应用侧访问策略、请求解码与费用前置保护

**Precondition（前置条件）：** Phase 3（阶段 3）通过；匿名模型能力保持关闭。本 Task（任务）只修改本地代码，不配置 DNS（域名系统）或公开端口。

**Files（文件）：**

- Create（创建）：`src/server/api-contract.ts`
- Create（创建）：`src/server/api-contract.test.ts`
- Create（创建）：`src/server/request-body.ts`
- Create（创建）：`src/server/request-body.test.ts`
- Create（创建）：`src/server/access-policy.ts`
- Create（创建）：`src/server/access-policy.test.ts`
- Create（创建）：`src/server/request-limiter.ts`
- Create（创建）：`src/server/request-limiter.test.ts`
- Modify（修改）：`app/api/ask/route.ts`
- Modify（修改）：`app/api/check/route.ts`
- Modify（修改）：`app/api/generate/route.ts`
- Modify（修改）：`app/api/fix/route.ts`
- Modify（修改）：`src/server/runtime-config.ts`
- Modify（修改）：`src/server/runtime-config.test.ts`
- Modify（修改）：页面/面板中的最小隐私与费用提示，具体文件按当前 UI（用户界面）复核

- [ ] **Step 1（步骤 1）：先写 API contract（应用程序接口契约）与字节上限反例**

覆盖：

- unknown field（未知字段）、错误类型、空白必填值、超长数组/字符串、非法 `mode/context/errors` 被 strict runtime decoder（严格运行时解码器）拒绝；
- `Content-Length` 缺失、伪小、非法或使用 chunked transfer（分块传输）的请求仍按实际读取字节受限；
- 总 body（请求体）超过全局 256 KiB hard cap（硬上限）或路由更小限制时，在继续读取/解析前安全返回 413；
- UTF-8（Unicode 字符编码）跨 chunk（分块）边界、流中断、JSON（JavaScript 对象表示）非法和 reader error（读取错误）不会产生未处理异常或日志 payload（负载）；
- error response（错误响应）不回显 body（请求体）、YAML、选中内容、校验错误或供应商错误。

- [ ] **Step 2（步骤 2）：先证明认证 identity header（身份头）信任链**

在实现应用授权前，明确 Traefik → oauth2-proxy ForwardAuth → application（入口控制器 → 认证代理前置认证 → 应用）的头清理和注入顺序：所有客户端可提交的身份头必须先删除，只有成功认证结果可以重新注入；NetworkPolicy（网络策略）只允许审核后的入口/认证组件访问应用 Service（服务）。

如果不能通过实际版本配置、集成反例和网络策略证明应用收到的主体不可由公网客户端伪造，立即停止，重新选择 oauth2-proxy reverse proxy（认证代理反向代理）或带签名的内部身份契约；不得仅凭 `X-Auth-Request-User` 字符串存在就宣称认证。

- [ ] **Step 3（步骤 3）：实现 fail-safe ACCESS_MODE（安全失败访问模式）**

只接受 `private|portfolio`；缺失、空白、大小写错误和未知值一律解释为 private（私有）。不创建管理 API（应用程序接口）、隐藏页面、特殊 header（请求头）或 URL（网址）参数修改模式。

策略矩阵固定为：

| 路由 | private（私有） | portfolio（作品集展示，计量未实现） |
| --- | --- | --- |
| 页面/静态资源 | 可信 allowlist identity（允许名单身份） | 匿名 |
| `/api/check` | 可信 allowlist identity（允许名单身份） | 匿名，仍受请求体与速率限制 |
| Ask/Generate/Fix（询问 / 生成 / 修复） | 可信 allowlist identity（允许名单身份） | 仍只允许可信 allowlist identity（允许名单身份） |
| 健康端点 | 不通过公共路由暴露 | 不通过公共路由暴露 |

应用业务 API（应用程序接口）再次执行同一策略，使 Ingress（入口）路由误配时模型路由仍拒绝匿名请求。页面级认证由入口承担，不能把前端隐藏按钮当作授权。

- [ ] **Step 4（步骤 4）：实现私有阶段限速、并发与费用保护**

单副本内存 token bucket/semaphore（令牌桶 / 信号量）只承担短窗口削峰和并发，不作为跨重启费用事实源。实现有限主体/路由 key（键）、过期清理、容量上限和可信代理来源；不能无界积累任意 IP（互联网协议地址）。候选速率使用设计中的 allowlist（允许名单）测试值，生产值由 Phase 4（阶段 4）受限测试确认。

Ask/Generate/Fix（询问 / 生成 / 修复）还必须设置单请求输入/输出 token（令牌）、上游超时、有限重试、并发和 emergency stop（紧急停止）。全局日费用在计量模块前依赖供应商侧硬额度和人工预算；代码/文档不得把请求次数限流描述成 token/cost metering（令牌 / 成本计量）。

- [ ] **Step 5（步骤 5）：添加隐私提示**

页面明确区分本地 `/api/check` 与会向 DeepSeek/Voyage 发送必要输入的模型能力；首次模型操作附近提示不要提交 Secret（密钥）、私钥或生产集群敏感配置。当前不接入 Turnstile（人机验证）或匿名 cookie（浏览器会话）。

- [ ] **Step 6（步骤 6）：验证**

```bash
node --import tsx --test src/server/api-contract.test.ts
node --import tsx --test src/server/request-body.test.ts
node --import tsx --test src/server/access-policy.test.ts
node --import tsx --test src/server/request-limiter.test.ts
node --import tsx --test src/server/runtime-config.test.ts
npm test
npx tsc --noEmit -p tsconfig.json
npm run build
git diff --check
```

- [ ] **Step 7（步骤 7）：通过既有发布链私有部署本次应用变更**

Task 15（任务 15）的代码不能通过 SSH 手工替换。按 Task 10-14（任务 10-14）已经验收的同一流程生成新候选镜像、draft Release（草稿发布版本）和人工发布记录，在 443 仍受限时部署并重复私有访问/回滚验证。模型 smoke test（冒烟测试）仍需单独费用授权。

**Rollback（回滚）：** 安全异常时回滚到 Phase 3（阶段 3）镜像并保持 80/443 非公开；不能通过默认 portfolio（作品集展示）、关闭 body limit（请求体上限）或信任客户端头恢复功能。

**Stop and report（停止并汇报）：** API（应用程序接口）模式、字节读取、身份信任链、访问矩阵、限流/并发/费用边界、隐私提示和全部安全反例。等待 review（审核）。

## Task 16（任务 16）：部署 DNS、TLS、oauth2-proxy 与受限双模式入口

**Precondition（前置条件）：** Task 15（任务 15）通过且对应新 digest（内容摘要）已经沿既有发布链完成私有部署/回滚验证；用户确定最终域名和 DNS（域名系统）控制权；GitHub OAuth App（GitHub OAuth 应用）、安全组 80/443 变更和 Kubernetes（容器编排系统）资源写入分别获得当次授权。

**Files（文件）：**

- Create（创建）：`deploy/k8s/access/oauth2-proxy.yaml`
- Create（创建）：`deploy/k8s/access/private-routes.yaml`
- Create（创建）：`deploy/k8s/access/portfolio-routes.yaml`
- Create（创建）：`deploy/k8s/access/middlewares.yaml`
- Create（创建）：`deploy/k8s/access/network-policy.yaml`
- Create（创建）：`deploy/k8s/tls/issuer-staging.yaml`
- Create（创建）：`deploy/k8s/tls/issuer-production.yaml`
- Create（创建）：`deploy/k8s/tls/certificate.yaml`
- Modify（修改）：`deploy/k8s/README.md`
- Modify（修改）：`scripts/deployment-contract.test.ts`
- Modify（修改）：Task 12（任务 12）的适配器 design/plan（设计 / 计划），增加单独审核的访问模式动作

- [ ] **Step 1（步骤 1）：先设计并审核 `set-access-mode` 扩展**

在适配器 design/plan（设计 / 计划）中增加且只增加：

```text
set-access-mode private
set-access-mode portfolio
```

输入仍是固定枚举，不能接受任意 ConfigMap/Ingress/kubectl（普通配置 / 入口 / Kubernetes 命令行工具）内容。设计并先写反例：未满足 portfolio（作品集展示）门禁、非法模式、并发切换、开启顺序错误、关闭顺序错误、部分失败、审计写入失败和重复执行。该扩展通过独立 review（审核）后才实现/安装。

- [ ] **Step 2（步骤 2）：先写入口与认证资源反例**

覆盖：

- oauth2-proxy/cert-manager（认证代理 / 证书管理器）镜像或安装资源未固定 digest/version（内容摘要 / 版本）失败；
- OAuth callback/Ingress host/Certificate DNS name（OAuth 回调 / 入口主机名 / 证书域名）不一致失败；
- private（私有）存在匿名业务旁路、portfolio（作品集展示）公开模型路由/健康端点/管理操作失败；
- 客户端身份头未清理、ForwardAuth（前置认证）顺序错误、非 allowlist（允许名单）身份可达应用失败；
- 请求体/速率/并发 middleware（中间件）缺失或顺序错误失败；
- 80 除 ACME challenge（证书挑战）/固定跳转外代理应用、6443/NodePort（Kubernetes API / 节点端口）公开失败；
- Git 仓库包含 OAuth/cookie/TLS/Turnstile secret（OAuth / 浏览器会话 / TLS / 人机验证密钥）失败。

- [ ] **Step 3（步骤 3）：创建 DNS 与受限证书入口**

创建最终域名 A record（A 记录），不在未确认 IPv6 时创建 AAAA record（AAAA 记录）。安装实施日仍受支持的固定 cert-manager（证书管理器），先用 ACME staging issuer（ACME 预发布签发器）。

80/TCP 只为 HTTP-01（HTTP 验证）向公网开放，其他路径固定拒绝；443/TCP 只允许当前固定来源或另行审核的测试来源。staging（预发布）证书、续期和路由通过后，单独切换 production issuer（生产签发器）。不开放 6443。

- [ ] **Step 4（步骤 4）：部署 oauth2-proxy（认证代理）和 allowlist（允许名单）**

OAuth client secret/cookie secret（OAuth 客户端密钥 / 浏览器会话密钥）从密码管理器创建为独立 Kubernetes Secret（Kubernetes 密钥），不提交 YAML（配置文件）。allowlist（允许名单）只包含明确审核身份；当前唯一维护者是管理员，普通允许用户没有模式修改能力。

Traefik（入口控制器）删除客户端身份头后调用 ForwardAuth（前置认证），只把认证成功的受控字段传给应用。用 NetworkPolicy（网络策略）证明应用 Service（服务）不能从未经审核的 Pod（容器组）直接访问。

- [ ] **Step 5（步骤 5）：部署两个固定访问模式并做有序切换**

private → portfolio（私有 → 作品集展示）：先部署/验证应用策略，保持全部 ForwardAuth（前置认证），最后一步才开放页面和 `/api/check`；Ask/Generate/Fix（询问 / 生成 / 修复）仍要求 allowlist（允许名单）。

portfolio → private（作品集展示 → 私有）：第一步恢复全部业务路由 ForwardAuth（前置认证），验证匿名拒绝，再更新应用配置/rollout（滚动发布）。任一步失败必须收敛到 private（私有）；模式变更写操作者、时间、前后状态、原因和结果，不记录 Secret（密钥）。

- [ ] **Step 6（步骤 6）：在受限来源执行安全矩阵**

至少验证：

- 缺失/非法模式默认 private（私有）；
- 未登录、非 allowlist（允许名单）、伪造身份头/cookie/URL/header（浏览器会话 / 网址 / 请求头）、直接 Service（服务）访问无法调用业务能力；
- portfolio（作品集展示）仅页面、静态资源和 `/api/check` 匿名；匿名模型路由全部拒绝；
- 公共请求、ServiceAccount（服务账户）、非管理员 workflow（流水线）不能改模式；
- 超大/分块请求 413，超速/超并发 429，供应商错误为封闭 502/503；
- HTTP（超文本传输协议）仅证书挑战/跳转，TLS（传输层安全）证书链和 SNI（服务器名称指示）正确；
- Turnstile（人机验证）、匿名额度和 Interview Pass（面试临时通行证）均不存在占位旁路。

```bash
dig +short <app-host> A
sudo k3s kubectl -n <namespace> get ingress,certificate,certificaterequest,order,challenge
sudo k3s kubectl -n <namespace> describe certificate <certificate>
curl --fail --head https://<app-host>/
openssl s_client -connect <app-host>:443 -servername <app-host>
```

**Rollback（回滚）：** 首先执行 `set-access-mode private` 并验证匿名拒绝；失败时关闭公网 443，必要时关闭 80。回滚入口/认证/证书到上一审核版本，轮换受影响 Secret（密钥），通过 SSH tunnel（SSH 隧道）恢复；不开放 6443、不降级明文。

**Stop and report（停止并汇报）：** DNS（域名系统）、证书链/续期、身份头信任、allowlist（允许名单）、双模式矩阵、模式审计、请求保护、异常流量和回滚证据。最终切回 private（私有），443 仍只允许审核来源。等待 review（审核）。

## Task 17（任务 17）：匿名模型与 Interview Pass（面试临时通行证）分叉闸

**Precondition（前置条件）：** Task 16（任务 16）通过。此 Task（任务）不默认要求实现匿名模型能力。

**Files（文件）：**

- 若不启用匿名模型：只在发布清单/运维文档记录 `anonymous_model=false`，不新增存储或代码
- 若准备启用：创建独立 token/usage/cost metering（令牌 / 用量 / 成本计量）spec/plan（设计 / 计划），确切日期和文件名在执行时确定

- [ ] **Step 1（步骤 1）：选择 Phase 5（阶段 5）公开范围**

默认推荐：portfolio（作品集展示）只公开页面、静态资源和 `/api/check`；Ask/Generate/Fix（询问 / 生成 / 修复）继续要求 allowlist（允许名单）。该路径不需要数据库、Turnstile（人机验证）、匿名 session（会话）或 Interview Pass（面试临时通行证）。

- [ ] **Step 2（步骤 2，可选）：如需匿名模型，先写独立设计**

设计必须基于届时真实 usage/cost（用量 / 成本）数据定义：供应商用量事实源、调用前预留、流式中断/重试、调用后结算、跨重启原子状态、并发、对账、全局费用熔断、Turnstile Siteverify（Turnstile 服务端校验）、匿名安全会话、Interview Pass（面试临时通行证）一次兑换/有限额度/到期/撤销、备份恢复和隐私删除。

只有设计证明需要持久状态后才选择最小存储；不能先建 SQLite/PVC/Redis（嵌入式数据库 / 持久卷声明 / 内存数据存储）再反推需求。设计完成后停止等待 review（审核），不得在同一次 Task（任务）实现。

- [ ] **Step 3（步骤 3，可选）：按独立 plan（计划）实施和审核**

匿名模型与 Interview Pass（面试临时通行证）只有在独立 Tasks（任务）全部通过后才进入 Phase 5（阶段 5）验收。任一计量/Turnstile（人机验证）组件不可用或状态不确定时，匿名模型安全关闭，页面和 `/api/check` 继续服务。

**Rollback（回滚）：** 任意不确定状态都切回 private（私有）或维持匿名模型关闭；不得回退为内存额度、无限 token（令牌）、隐藏通行码或跳过服务端人机校验。

**Phase 4 Stop（阶段 4 停止点）：** 明确 Phase 5（阶段 5）的公开路由矩阵。默认状态为 private（私有）、443 受限、匿名模型关闭；如选择匿名模型，必须附独立计量 design/plan（设计 / 计划）及完整审核记录。等待独立 review（审核）。

## Public Quality Gate（公开前质量闸）

## Task 18（任务 18）：使用候选镜像的 8,410 条索引完成正式质量审核

**Precondition（前置条件）：** Phase 3（阶段 3）私有部署稳定、Phase 4（阶段 4）受限入口通过；正式模型评估调用次数和费用获得单独授权。

**Authority（授权）：** 本地/受控评估。清理 ignored artifacts（被忽略产物）、调用真实模型和晋升 baseline（基线）分别需要当次授权；不修改生产入口。

**Files（文件）：**

- Read/write（读写）：现有 eval run/trace/baseline（评估运行 / 轨迹 / 基线）协议规定的 ignored artifacts（被忽略产物）
- Read only（只读）：Task 11（任务 11）release manifest（发布清单）与候选镜像内索引
- Modify（修改）：只有人工审核确认的 bad case/eval case（问题用例 / 评估用例）及对应治理文件；不能自动回灌

- [ ] **Step 1（步骤 1）：列出并确认 ignored artifact（被忽略产物）清理范围**

使用只读命令列出旧 schema v1/v2 run/trace（模式 v1/v2 运行 / 轨迹）、旧 calibration（校准）、临时报告和旧索引目录的精确路径、大小和协议版本。移动到受控临时归档或删除属于破坏性操作，必须在列出目标后获得确认；不清理 `.env`、用户文件、当前/上一候选镜像或未知目录。

- [ ] **Step 2（步骤 2）：复用发布候选的精确索引身份**

正式评估必须使用与候选镜像完全相同的 corpus/model/index identity（语料 / 模型 / 索引身份）。优先从固定 image digest（镜像内容摘要）读取/提取并校验索引 artifact（产物），避免为了得到相同索引再次付费构建；如果工具链不能安全复用而必须重新执行 `index:build`，先获得 Voyage 费用授权，并要求新旧 index hash/file hash（索引哈希 / 文件哈希）完全一致，否则停止调查。

不得用当前失效的 8,127 条 `data/index`、运行时在线重建结果或未固定模型生成的索引评估候选发布版本。

- [ ] **Step 3（步骤 3）：按治理顺序运行正式 full evaluation（完整集评估）**

先运行所有无模型 preflight（预检），再按检索、忠实度、裁判、生成、修复的顺序执行 full（完整集）范围。每类开始前记录 dataset/config/model/corpus/index identity（数据集 / 配置 / 模型 / 语料 / 索引身份）和费用预算；上一类 harness（评估框架）不完整或 identity（身份）不一致时不继续。

示意命令必须以当前 README/runner（说明文档 / 运行器）的真实参数为准：

```bash
npm ci
npm run eval:check
npm run schemas:check
npm run aliases:check
npm run corpus:stats
npm run eval -- --full
npm run eval:faith -- --full
npm run eval:judge
npm run eval:gen -- --full
npm run eval:fix -- --full
```

不得把 retrieval（检索）通过当作 answer/generation/fix（回答 / 生成 / 修复）通过，也不得用 smoke/tuning/holdout（冒烟 / 调优 / 留出集）替代 full（完整集）。

- [ ] **Step 4（步骤 4）：人工审核 metrics/trace/bad case（指标 / 轨迹 / 问题用例）**

逐类核对：

- selected/completed/harness error（选择 / 完成 / 评估框架错误）可对账；
- Holdout（留出集）没有进入调优或自动回灌；
- 错误解释的 correctness/completeness（正确性 / 完整性）逐条人工审核；
- `[S]` 引用与实际 context/source snapshot（上下文 / 来源快照）一致；
- Generation/Fix（生成 / 修复）目标值、跨资源关系、保留项和副作用真实通过；
- trace（轨迹）、日志和报告无 Secret（密钥）或生产敏感 YAML；
- bad case（问题用例）先形成候选，只有人工脱敏、复现和治理标记后进入提交数据。

- [ ] **Step 5（步骤 5）：人工晋升或明确拒绝 baseline（基线）**

只有 full run（完整集运行）完成、协议/定义可比较、trace coverage（轨迹覆盖）完整、harness error（评估框架错误）为 0 且人工审核通过时，才逐 kind（类别）显式执行 promotion（晋升）。任何未通过项都记录为阻断，不用 override（覆盖开关）或降低断言强度晋升。

如果用户决定先公开受控作品集而不等待新 baseline（基线），必须形成书面风险接受：明确哪些能力/指标未证实、匿名模型仍关闭、页面展示文案不得宣称生产质量已经验证。

**Rollback（回滚）：** 不合格评估不晋升 baseline（基线），继续使用上一合法基线或“无当前基线”状态；不修改候选生产镜像来迎合结果。疑似敏感 artifact（产物）立即隔离并按安全事件处理。

**Stop and report（停止并汇报）：** 清理范围、索引复用/重建证据、五类运行身份/费用、指标、人工 trace（轨迹）结论、bad case（问题用例）、baseline（基线）决定和剩余质量风险。等待 review（审核）。

## Phase 5（阶段 5）：公开发布与运维验收

## Task 19（任务 19）：先以 private（私有）公开 443，再人工开启 portfolio（作品集展示）

**Precondition（前置条件）：** Phase 4（阶段 4）和 Task 18（任务 18）通过，或 Task 18（任务 18）具有明确风险接受；生产证书、告警、回滚、当前/上一 digest（内容摘要）和 emergency stop（紧急停止）已验证。修改华为云安全组和公开访问获得当次明确授权。

**Files（文件）：**

- Create（创建）：`docs/operations/production-release-runbook.md`
- Create（创建）：`docs/operations/incident-response-runbook.md`
- Create（创建）：`docs/operations/release-ledger-format.md`
- Modify（修改）：`docs/README.md`
- Modify（修改）：根 `README.md`，只记录真实公开范围、隐私/费用边界和已知限制

所有运维文档顶部标明状态和用途，不包含密码、私钥、API key（应用程序接口密钥）、完整 kubeconfig（Kubernetes 客户端配置）、真实 cookie（浏览器会话）或可兑换 Interview Pass（面试临时通行证）。

- [ ] **Step 1（步骤 1）：先准备公开与紧急回退清单**

清单固定当前 commit/digest/index identity（提交 / 内容摘要 / 索引身份）、当前/上一版本、ACCESS_MODE=private（访问模式为私有）、证书、监控、供应商硬额度、模式切换、关闭模型路由、关闭 443、停用 Ingress（入口）、runner（运行器）停用和固定来源 SSH break-glass（SSH 紧急处置）步骤。

- [ ] **Step 2（步骤 2）：只扩大 443，保持 private（私有）**

先把 443/TCP 从审核来源扩大为公网，保持所有业务路由 private（私有）；80 只处理 ACME challenge/HTTPS redirect（证书挑战 / HTTPS 跳转）。从多个外部网络验证：匿名/非 allowlist（允许名单）访问被拒绝，允许名单身份正常，22 仍仅固定来源，6443/内部端口不可达。

观察认证失败、429/5xx、节点资源、证书、runner（运行器）和供应商费用；任何异常先关闭 443 或恢复受限来源，不急于开启 portfolio（作品集展示）。

- [ ] **Step 3（步骤 3）：人工确认 operational Release（运维发布版本）**

生成独立 draft operational Release（草稿运维发布版本），记录当前 image digest（镜像内容摘要）、private → portfolio（私有 → 作品集展示）路由差异、安全门禁、匿名模型是否启用和回退动作。唯一维护者核对后手工发布；不能由定时任务或应用 API（应用程序接口）自动切换。

- [ ] **Step 4（步骤 4）：开启受控 portfolio（作品集展示）**

默认只公开页面、静态资源和 `/api/check`；Ask/Generate/Fix（询问 / 生成 / 修复）继续要求 allowlist（允许名单）。只有 Task 17（任务 17）的独立计量计划已经完整实施和审核时，才追加 Turnstile（人机验证）、有限匿名额度和 Interview Pass（面试临时通行证）。不存在“不限制 token（令牌）”角色。

- [ ] **Step 5（步骤 5）：执行公网验收与模式演练**

从外部网络验证 TLS（传输层安全）、缓存/静态资源、页面、`/api/check`、认证模型路由、请求体/速率/并发、隐私提示和安全错误。执行一次 portfolio → private → portfolio（作品集展示 → 私有 → 作品集展示）有序演练，核对审计和中途失败收敛；不在日志/报告保留请求内容。

使用 allowlist（允许名单）身份和非敏感 YAML 验证 Ask/Check/Generate/Fix（询问 / 检查 / 生成 / 修复）闭环，核对安全 observation（观测）不含原始 YAML、answer（回答）或 Secret（密钥）。匿名模型未启用时必须验证其明确拒绝。

**Rollback（回滚）：** 安全/费用异常首先切回 private（私有）并把模型 emergency stop（紧急停止）设为关闭；失败时关闭 443 或停用 Ingress（入口）。应用回归通过新 draft rollback Release（草稿回滚发布版本）人工确认上一 digest（内容摘要）；Actions（自动化流水线）不可用时才使用固定来源 SSH break-glass（SSH 紧急处置）。不降级 HTTP（超文本传输协议）、不开放 6443、不恢复原始 trace（轨迹）。

**Stop and report（停止并汇报）：** 安全组差异、private（私有）公网反例、operational Release（运维发布版本）、最终公开矩阵、模式演练、费用/流量/错误、observation（观测）安全检查和回滚证据。将状态标记为“受控试运行”，等待 review（审核）。

## Task 20（任务 20）：完成恢复演练、容量基线与观察期验收

**Precondition（前置条件）：** Task 19（任务 19）受控试运行已开始；破坏性重启、隔离恢复和 Secret（密钥）轮换分别获得维护窗口与明确授权。

**Files（文件）：**

- Modify（修改）：`docs/operations/production-release-runbook.md`
- Modify（修改）：`docs/operations/incident-response-runbook.md`
- Create（创建）：`docs/operations/backup-restore-runbook.md`
- Create（创建）：`docs/operations/capacity-baseline.md`
- Modify（修改）：`docs/AI应用开发能力训练实现方案.md`
- Modify（修改）：`docs/README.md`

- [ ] **Step 1（步骤 1）：建立最小监控和告警证据**

覆盖节点 CPU/load/memory/swap/disk/inode/network（处理器 / 负载 / 内存 / 交换空间 / 磁盘 / 索引节点 / 网络）、K3s/Pod/certificate（K3s / 容器组 / 证书）、应用 live/ready/RSS/event-loop/429/5xx（存活 / 就绪 / 常驻内存 / 事件循环 / 限流 / 服务错误）、runner online/jobs（运行器在线 / 任务）、image drift（镜像漂移）、observation drop/rotation/size（观测丢弃 / 轮转 / 大小）和供应商聚合费用。

磁盘候选阈值：70% 提醒、80% 阻止发布、90% 关闭非必要写入并人工处置。不能以自动删除未知文件作为恢复策略。

- [ ] **Step 2（步骤 2）：记录真实容量基线**

在受控低并发下记录：冷启动/索引加载 RSS（常驻内存）、Ask/Generate/Fix（询问 / 生成 / 修复）并发的 CPU/内存、K3s 系统组件余量、镜像拉取时间、6 Mbps 带宽影响、observation（观测）磁盘增长和 SSE（服务器发送事件）终止。根据数据审核 `requests/limits/probes`（资源请求 / 上限 / 探针），不因一次 OOM（内存耗尽）直接提高上限。

- [ ] **Step 3（步骤 3）：演练故障和回滚**

逐项、分维护窗口验证：

- DeepSeek/Voyage/key（供应商 / 密钥）故障时 `/api/check` 保持可用，模型路由安全失败且无重试风暴；
- 索引身份失效时 readiness（就绪状态）失败、模型调用为 0，回滚上一 digest（内容摘要）；
- GHCR（GitHub 容器镜像仓库）或 runner（运行器）不可用时当前服务继续，发布安全失败；
- OAuth/TLS/observation（开放授权 / 传输层安全 / 观测）异常时切回 private（私有）或关闭入口，不旁路；
- 节点重启后 K3s、系统 Pod（容器组）、应用、证书、固定 digest（内容摘要）和 observation writer（观测写入端）恢复；
- 当前/上一镜像回滚和单副本短暂不可用符合记录。

- [ ] **Step 4（步骤 4）：验证备份、恢复与 Secret（密钥）边界**

在隔离环境验证 K3s database/server token（数据库 / 服务端令牌）匹配恢复；不直接用生产节点做首次破坏性恢复。验证外部密码管理器可重建 Kubernetes Secret/imagePullSecret/OAuth secret（Kubernetes 密钥 / 镜像拉取密钥 / OAuth 密钥），但不导出/展示真实值或完整 kubeconfig（客户端配置）。

接受 observation PVC（观测持久卷声明）未晋升数据随节点丢失，不备份原始轨迹；索引通过源语料、构建代码、身份报告和固定镜像重建，不单独备份解压目录。记录实测恢复步骤后再给出 RTO/RPO（恢复时间 / 恢复点目标），不能预先承诺。

- [ ] **Step 5（步骤 5）：完成 24 小时与 7 天观察**

汇总 uptime/error/resource/disk/certificate/traffic/cost（可用性 / 错误 / 资源 / 磁盘 / 证书 / 流量 / 成本）、runner job（运行器任务）、模式变更、observation（观测）写入/丢弃/轮转/删除和异常流量；只保留聚合安全元数据。7 天保留验证必须证明到期受管分段被清理，未知文件/symlink（符号链接）未被删除。

- [ ] **Step 6（步骤 6）：更新路线并恢复训练主线**

只有 24 小时和 7 天证据、回滚/重启/恢复、Secret（密钥）边界和遗留风险通过用户 review（审核）后，才把部署状态从“受控试运行”改为“生产可用”。随后回到唯一训练路线的下一项：贯通 token/usage/cost（令牌 / 用量 / 成本），再继续 official docs/examples/Claim-level Grounding/feedback（官方文档 / 示例 / 声明级依据校验 / 反馈）闭环；不能因部署完成扩张为通用 Kubernetes 运维平台。

**Rollback（回滚）：** 观察期任一重大安全、费用、隐私或恢复失败都把 ACCESS_MODE（访问模式）切回 private（私有）或关闭 443，保持已验收镜像与诊断状态；修复后重新开始对应观察窗口，不能补写成功证据。

**Phase 5 Stop（阶段 5 停止点）：** 汇报 24 小时/7 天数据、容量候选值、故障/回滚/重启/恢复、Secret（密钥）恢复边界、公开模式、质量风险和最终状态建议。只有用户明确确认才标记“生产可用”。

## Completion Definition（完成定义）

本计划只有在以下条件全部满足时才完成：

- Phase 0-5（阶段 0-5）都有独立 review（审核）记录，没有跳过停止点；
- 部署镜像固定 commit SHA/digest（提交哈希 / 内容摘要），索引为 8,410 条当前 identity（身份）且运行时零重建；
- 应用 non-root/read-only（非 root / 只读）、单副本和故障边界实测；
- raw trace（原始轨迹）已退役，安全 observation（观测）持续启用并通过脱敏、轮转、保留、删除、容量和单写入端验证；
- PR（合并请求）不接触 Secret（密钥）或生产 runner（运行器）；Release Please（发布自动化工具）只创建 Draft Release（草稿发布版本），release artifacts workflow（发布证据流水线）只附加证据，只有人工发布才直接部署；
- 生产 runner（运行器）不执行仓库代码，只调用经过独立设计/测试的固定适配器；
- 22 仍限固定来源，6443 不公开，80 只挑战/跳转，443 是唯一应用入口；
- private/portfolio（私有 / 作品集展示）双模式、管理员控制、认证、请求保护和紧急收紧通过；
- 未完成独立计量时匿名模型和 Interview Pass（面试临时通行证）保持关闭，不存在隐藏后门；
- 公开质量闸、镜像回滚、节点重启、备份恢复、Secret（密钥）边界和观察期通过；
- 文档、release ledger（发布台账）和日志不包含凭据或用户敏感 YAML。

以下仍不是完成承诺：高可用、多节点、跨区域容灾、通用集群运维、匿名无限模型调用、完整 token/usage/cost metering（令牌 / 用量 / 成本计量）、Stage 7 feedback（阶段 7 反馈）闭环或新的质量优化。
