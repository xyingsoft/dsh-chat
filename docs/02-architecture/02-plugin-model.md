[← 返回 Wiki 首页](../README.md) | **二、整体架构** · 02 插件化架构 | [上一篇：三层总体架构](./01-overall-architecture.md) | [下一篇：服务端结构与部署分层 →](./03-server-and-deployment.md)

---

# 二、架构与插件模型（下）：插件化架构

> **本文档属于架构层**。它定义能力如何切分为插件、三种角色如何协作，以及每项能力的提供者矩阵。**新增能力必须先在此处登记服务定义与提供者**，再实现代码。

## 本篇目录

- [6. 插件化架构](#6-插件化架构)
- [6.1 能力与提供者矩阵](#61-能力与提供者矩阵)

---

## 6. 插件化架构

dsh-chat 遵循 DSH 的“一切皆插件”模型。除 `@dsh-chat/contract` 这一纯类型、schema 与协议库外，所有业务能力都以 Cordis 插件注册到 `ctx`；**没有需要直接修改的特权聊天内核**。插件用 `ctx.effect()` 或 `ctx.on()` 注册服务、事件监听、路由、后台任务和 UI 节点，并在卸载或被撤销时释放注册、连接、租约和任务。

每个能力均由三种角色组成：**服务定义**插件声明稳定接口、配置和错误语义；**服务提供者**插件实现 SQLite、PostgreSQL、Redis、对象存储、SMTP、KMS 或沙箱等后端；**消费者**插件通过接口调用能力，例如消息插件消费成员授权和通知服务，仓库插件消费受控出站服务。**消费者不得导入某个提供者的数据库模型或绕过服务调用。**

插件间的持久协作使用领域事件和事务 outbox，**不用跨插件共享可变内存**。会影响 DSH 模型输入的消息、资源摘录、协作上下文或 Bot 上下文**必须**同时写入对应的 DSH `SessionEvent`，以便重放、审计和权限复核；普通 UI 提示可以是可重建的实时事件。

### 6.1 能力与提供者矩阵

| 插件能力 | 服务定义与主要职责 | 典型提供者 | 消费者与持久事件 |
|---|---|---|---|
| 身份与设备 | `ChatIdentity`：注册、登录、设备证明、恢复、撤销与风险状态 | L1 SQLite；L2 PostgreSQL/Redis；L3 企业身份与 KMS 适配器 | 所有写入插件；`device_registered`、`device_restricted`、`device_revoked` |
| 组织与授权 | `ChatOrganization`：组织、工作区、项目、成员、角色、ACL、套餐与确认挑战 | L1 SQLite；L2 PostgreSQL；L3 目录同步提供者 | 消息、资源、Bot、分析；`membership_changed`、`policy_changed` |
| 在线状态 | `ChatPresence`：心跳、可见范围与订阅 | 本地/Redis 心跳提供者 | 联系人、群列表、通知；`presence_changed` |
| 消息与群日志 | `ChatMessaging`：私聊队列、群日志、编辑、撤回、ACK、游标和水位 | SQLite 队列；PostgreSQL/outbox 分区队列 | 客户端同步、通知、Bot；`message_accepted`、`message_edited`、`message_revoked` |
| 内容与资源 | `ChatContent`：上传预约、`BlobObject`、资源版本、扫描、下载授权和清理 | 本地目录；S3/MinIO；企业 KMS 加密存储 | 消息附件、共享、预览、Bot；`resource_available`、`resource_quarantined` |
| 通知 | `ChatNotification`：收件箱、偏好、邮件、SSE 提示和任务签收通知 | 本地 outbox；SMTP；企业通知适配器 | 工作项、消息、风险、插件目录；`notification_created`、`notification_read` |
| 协作与执行 | `ChatCollaboration`、`ExecutionProvider`：共享、交接、执行租约、沙箱、候选产物与接受流程 | 本地禁网进程；受控容器；企业隔离执行服务 | 工作项、资源、仓库；`execution_started`、`execution_finished`、`artifact_accepted` |
| 工作项与评审 | `ChatWorkItem`：工作项状态机、依赖、签收、评审与评论 | L1 SQLite；L2 PostgreSQL | 通知、协作、分析；`work_item_changed`、`review_requested`、`review_completed` |
| 仓库与出站 | `ChatRepository`、`EgressService`：绑定、验证、webhook、提交归因和受控网络 | L1 不提供；L2 allowlist HTTP；L3 出口代理与专用连接器 | 项目群、分析、自动化；`repository_verified`、`code_update_verified` |
| Bot 与公共工具 | `ChatBot`、`ChatPluginRegistry`：Bot 调度、插件审核、发布、能力租约与撤销 | 本地禁用；L2 隔离 worker；L3 KMS/沙箱/审计提供者 | 群、资源、模型、工作流；`bot_invoked`、`plugin_revoked` |
| 分析与计费 | `ChatAnalytics`、`ChatBilling`：用量归集、预算、报告、同层级排行和套餐限制 | SQLite 聚合；PostgreSQL 聚合；企业数据仓库适配器 | 仪表盘、管理员策略；`usage_aggregated`、`budget_exceeded` |
| 搜索与索引 | `ChatSearch`：索引管线、可搜范围、查询授权复检与索引失效 | L1 host 本地索引；L2 服务端索引提供者；L3 分片索引与设备侧索引 | 消息、资源、工作项、插件目录；`index_updated`、`index_suppressed` |
| 审计 | `ChatAudit`：审计事件写入、哈希链、查询授权与归档导出 | L1 仅追加表；L2 每日锚点；L3 逐条链与外部归档 | 所有写入插件；`audit_recorded`、`audit_chain_broken` |
| 合规与生命周期 | `ChatCompliance`：数据导出、账号注销、组织删除、宽限期与保留执行 | L1 本地导出；L2 对象存储导出；L3 法规归档与法律保留 | 身份、组织、内容、分析；`export_ready`、`account_anonymized`、`organization_purged` |

插件的配置**必须**通过 schema 验证，含 `OrganizationId` 范围、依赖服务、权限、资源上限、保留期和停机行为。启动顺序由 bundle 配置的依赖关系决定：先加载身份、组织和审计，再加载消息/内容等消费者；**缺少必需提供者时 profile 加载失败，不允许静默降级**。可选能力**必须**显式显示为未安装或 `NOT_IMPLEMENTED`。

组织公共插件与系统核心插件使用**不同信任级别**。系统核心插件随 dsh-chat bundle 安装、只能由部署管理员替换并受部署审计；组织公共插件由组织审核后供成员启用，始终运行在能力租约和成员 ACL 内，**不能替换身份、授权、审计、出站或密钥插件**。

> 各能力对应的工程目录结构，见[最小可运行骨架 §43.3 初始工程结构](../04-roadmap/02-minimum-skeleton.md#433-初始工程结构)。
> 插件相关的编码约束，见[契约与规范附录 §48 编码规范](../03-details/06-contracts-and-conventions.md#48-编码规范)。

---

[← 上一篇：三层总体架构](./01-overall-architecture.md) | [返回 Wiki 首页](../README.md) | [下一篇：服务端结构与部署分层 →](./03-server-and-deployment.md)
