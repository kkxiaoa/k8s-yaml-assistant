# 公共体验、身份与费用控制设计

> 状态：2026-07-29 已审核，本地候选已实施并等待本轮 review（审核）。
> 用途：取代尚未部署的 oauth2-proxy（认证代理）与 private/portfolio（私有 / 作品集展示）双模式候选；不改变 Phase 0-3（阶段 0-3）已验收的发布、部署和回滚信任链。

## 1. 目标

公网入口只服务 K8s YAML 编辑工作流：

- 匿名访客可查看完整界面，使用不扣点的 `check`，并以低额度真实体验 `ask`、`generate`、`fix`；
- 登录用户获得独立的每日额度；
- 管理员可开启有限时长的 Open Showcase Mode（开放展示模式）或全局 Sleep Mode（休眠模式）；
- 任何模型请求在发往供应商前都受持久额度和费用预算约束；
- 控制状态不确定时模型能力失败关闭，页面、登录和本地检查继续服务。

本设计不引入白名单、人机验证、反馈入口、用户资料、通用计费平台、多副本协调或动态定价后台。回答反馈仍属于 Stage 7.2（阶段 7.2），本 Task（任务）不实现。

## 2. 产品状态与权限

### 2.1 身份

任何 GitHub（代码托管平台）用户均可登录。应用使用 GitHub 返回的稳定数字用户编号作为身份事实：

- 数字编号只存在于加密会话和请求内存中；
- 持久额度主体是专用密钥计算的 HMAC-SHA256（带密钥安全哈希）；
- 管理员由配置中的固定数字编号判断，登录名 `kkxiaoa` 只用于展示；
- 不读取或保存邮箱、组织、团队、仓库权限和供应商访问令牌。

认证使用应用内 `next-auth@4.24.15`，无数据库适配器，八小时加密会话。GitHub OAuth 2.0（开放授权协议）范围固定为 `read:user`，用户信息只读取 `/user`。

未登录访客由服务端签发 128 位随机标识及 HMAC-SHA256（带密钥安全哈希）签名的 30 天 Cookie（浏览器标识）。Cookie 使用 `HttpOnly`（仅服务器可读）、`SameSite=Lax`（限制跨站携带）和生产 `Secure`（仅安全连接），只在应用基础路径发送；账本只保存按 `anonymous` 域隔离后的主体哈希，不保存 Cookie、网络地址或浏览器指纹。清除 Cookie 或更换浏览器可以获得新体验包，因此该机制只用于低摩擦额度分配，不声称防机器人；硬费用边界仍由全局预算、速率和并发限制提供。

### 2.2 全局状态

控制库只存在一个有效状态：

| 状态 | 页面、登录、管理、`check` | 匿名模型功能 | 登录用户模型功能 | 管理员模型功能 |
| --- | --- | --- | --- | --- |
| `normal` | 可用 | 30 天体验包 7 点 | 每日 10 点 | 可用 |
| `interview` | 可用，主页面显示绿色图标 | 体验包不变 | 每日 50 点 | 可用 |
| `sleep` | 可用，主页面显示休眠图标 | 拒绝 | 拒绝 | 拒绝 |

状态规则：

- 新建数据库从 `sleep` 开始；
- 协议值 `interview` 的用户可见名称固定为“开放展示模式”，只允许 1、4、8 小时，默认管理页选择 4 小时；
- 重复开启从当前时间重新计时，过期后自动解释为 `normal`；
- `interview → sleep` 会清除开放展示到期时间；
- `sleep → normal` 不恢复旧开放展示状态；
- 状态写入事务提交后影响新的模型预留；已开始的供应商调用完成并结算。

`MODEL_ACCESS_ENABLED` 是独立且优先级最高的运维开关。有效状态优先级为：

1. 运维开关关闭；
2. 控制库不可用；
3. 休眠模式；
4. 全局日/月预算耗尽；
5. 模型运行时不可用；
6. 当前主体额度不足；
7. 允许调用。

管理员只绕过个人额度，不绕过前五项。

### 2.3 匿名与登录体验

- 所有操作面板和输入区对匿名访客可用；匿名体验包有 7 点，沿用 `ask=1`、`generate=3`、`fix=3`，初始额度恰好支持每项各执行一次，也允许访客自行分配。
- 匿名体验包在签名 Cookie（浏览器标识）的 30 天有效期内不按自然日重置；登录后的每日额度与匿名账本相互独立，不合并身份或追溯匿名使用。
- 当某项操作所需点数超过当前匿名余额时，执行按钮成为登录入口；点击时只把当前 YAML、问题、生成要求和待执行操作写入当前标签页 `sessionStorage`，不调用模型也不扣点。
- 暂存内容十分钟后失效；登录返回后恢复并要求用户再次确认执行，不自动调用模型。成功恢复或发现过期后立即删除暂存，不保存回答、来源、错误或会话。
- `check` 不扣产品点数，但继续受短窗口速率、并发和请求体限制。
- 主页面不直接展示模式文字；开放展示和休眠分别显示绿色眼睛图标与黄色月亮图标，鼠标悬停或键盘聚焦时才展示模式名称。管理页仍显示完整名称。
- 页面展示当前主体的剩余点数和重置或到期时间，在初次加载、窗口重新获得焦点且状态超过 60 秒、后台每 60 秒以及模型请求完成后刷新。
- 供应商调用开始前失败会删除预留；一旦供应商调用开始，成功、失败或取消都按现有结算规则占用该次点数，避免用中断绕过额度。
- 匿名已经可以获取真实结果，不另维护重复的静态 Ask / Generate / Fix（询问 / 生成 / 修复）示例卡。
- 本阶段不增加点赞、点踩、原因标签、行为采纳或其他反馈闭环。

## 3. 应用接口

### 3.1 体验状态

`GET /api/experience` 返回：

```ts
interface ExperienceResponse {
  authenticated: boolean;
  user: null | { login: string; admin: boolean };
  mode: 'normal' | 'interview' | 'sleep';
  quota:
    | {
        kind: 'anonymous_trial';
        limit: number;
        remaining: number;
        expiresAt: string;
      }
    | {
        kind: 'daily';
        limit: number;
        remaining: number;
        resetsAt: string;
      }
    | { kind: 'unlimited' }
    | null;
  model: Record<
    'ask' | 'generate' | 'fix',
    {
      enabled: boolean;
      reason:
        | null
        | 'model_access_disabled'
        | 'control_state_unavailable'
        | 'sleep_mode'
        | 'global_budget_exhausted'
        | 'runtime_config_invalid'
        | 'quota_exhausted';
    }
  >;
}
```

该接口不返回数字用户编号、费用余额或开放展示模式到期时间，只返回当前请求主体自己的产品额度。运维开关关闭时额度为 `null`，避免把控制库读取变成紧急开关的依赖。控制库无法读取时返回 `control_state_unavailable`/503；前端据此关闭模型操作。

三项模型状态按真实依赖和各自点数独立计算：`ask` 要求 DeepSeek（回答模型）、Voyage（向量服务）、索引目录和查询扩展开关均可用，`generate`、`fix` 只要求 DeepSeek；任一共享模式或费用门禁仍同时关闭三项操作。这里的运行时状态只检查本地配置与 Secret（密钥）是否可用，不对供应商发起健康探测；实际供应商故障仍在用户执行对应请求时通过既有安全错误返回。

### 3.2 管理接口

- `GET /api/admin/experience` 返回有效模式和 `interviewExpiresAt`；
- `POST /api/admin/experience` 只接受：

```ts
type AdminExperienceRequest =
  | { mode: 'normal' }
  | { mode: 'sleep' }
  | { mode: 'interview'; durationHours: 1 | 4 | 8 };
```

管理写入要求：

- 已登录且数字编号等于管理员配置；
- `Content-Type` 为 `application/json`；
- `Origin` 精确等于配置的公开应用来源；
- 生产配置的来源必须是 HTTPS（安全超文本传输协议）；只有 `npm run dev` 的开发环境额外接受显式配置的本机回环 HTTP（超文本传输协议）来源；
- 使用现有有界请求体和严格对象解码；
- 未登录返回 401，非管理员返回 403，状态库不可写返回 503。

### 3.3 模型路由错误

现有 `{ error: { code } }` 结构保持不变：

- `quota_exhausted`：429；登录用户的 `Retry-After` 指向上海时区次日零点，匿名体验包不承诺自动重置；
- `model_access_disabled`、`control_state_unavailable`、`sleep_mode`、`global_budget_exhausted`：503；
- 全局费用耗尽的 `Retry-After` 指向阻断条件最早重置时间。

## 4. 持久化与费用边界

### 4.1 SQLite（嵌入式数据库）

应用单副本使用 `better-sqlite3@12.11.1`，独立 1 GiB PVC（持久卷声明）挂载 `/app/data/control`。应用在卷内创建自己持有的 `0700` 私有子目录，数据库位于 `/app/data/control/private/control.sqlite3` 且权限为 `0600`；不要求非 root（非超级用户）进程修改挂载根目录权限。启用 WAL（预写日志）和有限 `busy_timeout`，写操作使用短 `BEGIN IMMEDIATE` 事务。

最小 schema（数据结构）为：

- `experience_state`：单行 `mode`、`interview_expires_at`；
- `request_ledger`：唯一请求编号、匿名主体、上海日期、路由、点数、状态、最大预留费用、实际费用、租约和完成时间。

持久账本状态只包含 `reserved | settled | charged_max`。能够确定供应商请求尚未开始的失败直接删除预留记录，不保留没有额度或费用消费者的退款历史。月份由上海日期派生，不保存重复字段。账本保留 35 天，不保存 YAML、问题、回答、来源、用户名、网络地址或会话。

### 4.2 产品额度

- 登录额度按上海时区自然日重置；
- 匿名体验包 30 天内总计 7 点；普通模式登录用户每日 10 点，开放展示模式登录用户每日 50 点；
- `ask=1`、`generate=3`、`fix=3`；
- 匿名额度不随模式增加；登录用户当日已使用点数在模式切换后继续累计，高档额度替代低档额度而非额外叠加；
- 管理员不预留产品点数，但仍创建费用账本记录。

### 4.3 费用预留与结算

全局预算为每日 1 美元、每月 20 美元。金额使用整数微美元：

- `ask` 最大预留 100,000 微美元；
- `generate`、`fix` 最大预留 250,000 微美元；
- 未结算预留按最大金额占用预算；
- `ask` 租约 3 分钟，`generate`、`fix` 租约 10 分钟；
- 过期租约转为 `charged_max`。

匿名与登录请求共享这一个全局费用预算，不增加当前没有流量证据的平行预算池。清除 Cookie（浏览器标识）的滥用可以提前耗尽公共预算并使当期模型体验失败关闭，但不能突破日/月费用上限；出现真实的匿名流量挤占证据后，再评估独立匿名预算或人机验证。

授权、模式、运行时、请求体、短窗口限流和并发检查通过后，在第一次供应商调用前用单个事务同时预留产品点数和最大费用。只有能够证明供应商请求尚未开始时才删除预留；一旦请求开始，失败、取消、进程中断、用量缺失或无法确认都转为 `charged_max`。

供应商返回有效 usage（用量）时按以下固定价格向上取整结算：

- DeepSeek（回答模型）输入统一按缓存未命中 0.14 美元 / 百万 token（令牌），输出 0.28 美元 / 百万 token；
- Voyage（向量与重排模型）当前固定的 `voyage-3` 为 0.06 美元 / 百万 token，`rerank-2.5` 为 0.05 美元 / 百万 token；
- 不计免费额度或缓存折扣。

价格于 2026-07-29 按当前固定模型核对；更换模型或供应商价格变化时必须在启用模型前更新并审核该结算实现，不引入当前没有消费者的动态计价后台。DeepSeek SDK（回答模型软件开发工具包）的自动重试关闭；用户重试作为新的、独立预留请求处理。Generate/Fix（生成 / 修复）的代理循环固定为首次生成加最多两次修复，即最多三次回答模型调用；费用汇总沿同一调用链返回，不重复解析供应商响应。

## 5. 控制库故障边界

控制库只保存模式、匿名化额度、费用账本和请求预留状态，不保存用户名、网络地址、YAML、问题、回答、OAuth（开放授权）令牌或供应商凭据。1 GiB local-path PVC（本地路径持久卷声明）可以跨 Pod（容器组）重启保留数据，但与单节点处于同一故障域，不能抵御节点或系统盘完全损坏。

当前训练项目不为这些低价值控制状态引入 OBS（对象存储服务）备份、加密副本、调度器、备份凭据或备份新鲜度门禁。节点磁盘完全损坏时允许丢失控制状态，历史额度与费用累计也会随之丢失并在新库内从零开始；重新创建的数据库从 `sleep` 开始，管理员必须显式恢复 `normal` 或限时开放展示后才会重新产生模型费用。`MODEL_ACCESS_ENABLED` 继续作为独立且优先级最高的紧急开关，日/月费用上限继续在控制库内约束重新开放后的请求。

## 6. 部署与回滚

- Traefik（入口控制器）直接路由 `/k8s-yaml-assistant` 到应用；移除 oauth2-proxy（认证代理）、身份头信任和双路由切换。
- 保留入口请求体、速率和并发中间件；应用内短窗口限流使用有界 TTL/LRU（生存时间 / 最近最少使用）回收，避免任意登录用户形成无界键。
- NetworkPolicy（网络策略）允许入口控制器访问应用，并允许应用访问 443/TCP；不增加通用出站权限。
- 只读根文件系统继续使用既有 64 MiB 有界 `/tmp` emptyDir（临时卷）；不为控制库增加平行临时存储。
- Kubernetes（容器编排系统）探针继续使用旧根路径；新镜像用一次同主机 HTTP `307` 临时重定向把根健康地址连接到基础路径处理器，kubelet（节点代理）按官方契约跟随该重定向。公开入口不匹配根健康地址。
- 回滚到 `v0.1.1` 时根探针仍可通过，但旧镜像在公开基础路径返回 404，从而失败关闭。回滚完成后限制或删除公开入口，并保留控制库 PVC（持久卷声明）。
- 首次部署状态固定为 `MODEL_ACCESS_ENABLED=false` 且数据库为 `sleep`。真实登录和管理权限验证不需要模型调用。

正式发布、生产部署、模型调用、索引重建、公网安全组开放和节点重启均保持独立明确授权。

## 7. 依据与验收边界

- NextAuth.js（身份认证库）应用路由与无数据库会话：
  - <https://next-auth.js.org/configuration/initialization>
  - <https://next-auth.js.org/configuration/options>
- GitHub OAuth 2.0（开放授权协议）范围与稳定数字编号：
  - <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps>
  - <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app>
- Kubernetes HTTP probe（Kubernetes 超文本传输协议探针）的同主机重定向：
  - <https://kubernetes.io/docs/concepts/workloads/pods/probes/#http-probes>
- 供应商用量与价格：
  - <https://api-docs.deepseek.com/quick_start/token_usage/>
  - <https://api-docs.deepseek.com/quick_start/pricing/>
  - <https://docs.voyageai.com/docs/pricing>

本 Task（任务）只以身份、模型准入、费用上限和编辑器体验可测试为完成条件，不扩张为通用账户、账单、运维或多租户平台。
