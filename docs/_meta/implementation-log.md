[← 返回 Wiki 首页](../README.md) | **元文档** · 实现记录 | [上一篇：原文档映射表](./source-mapping.md)

---

# 实现记录

> **本文档只登记事实与待办，不定义任何约束。**
> 它属于元文档层，**不参与约束传递**。这里记录的版本号、选型与缺口，都不能被当作[需求](../01-requirements/)、[架构](../02-architecture/)或[细节](../03-details/)层的规定来引用；要成为规定，得按[文档维护规范 §3.1](./documentation-workflow.md#31-需求架构变更)写入对应层级的文档后才生效。
> 因此本文档**不新增**任何强约束。文中出现的「必须」「不得」「绝不」一律是**引用上层文档的原文**，均带出处链接；不带出处的强约束词即为缺陷。

## 本篇目录

- [1. 外部依赖现状](#1-外部依赖现状)
- [2. 实现选型与待提交的文档变更](#2-实现选型与待提交的文档变更)
- [3. 文档缺口登记](#3-文档缺口登记)
- [4. 开放决策的阶段归属](#4-开放决策的阶段归属)

---

## 1. 外部依赖现状

**核对日期：2026-08-29**

dsh-chat 是一组 DSH 插件，运行在 DeepSeek Harness 之上。相关包发布在公共 npm。

### 1.1 一个需要先说清楚的矛盾

DSH Desktop 的最新发行版是 `v2.0.4`（2026-08-28），但**它依赖的运行时 `0.1.2-alpha.1` 没有发布到 npm** —— 该版本只以本地 tarball 形式存在于 DSH Desktop 的检出中（`resolutions` 指向 `file:vendor/dsh-runtime/0.1.2-alpha.1/*.tgz`）。

| DSH Desktop | 运行时 | 能否从 npm 获取 |
|---|---|---|
| `v2.0.4` | `0.1.2-alpha.1` | **否** |
| `v2.0.2` | `0.1.1-rc.1` | 是 |

结论：**在 `0.1.2` 发布前，仓库外的插件项目无法对齐 `v2.0.4` 的运行时。** 本项目按可从 npm 获取的版本开发，对应的 DSH Desktop 参照版本是 `v2.0.2`，而不是最新的 `v2.0.4`。等 `0.1.2` 发布后再评估升级并同步更新本节。

> 注：本地检出目录 `DSH-desktop/deepseek-harness-desktop-latest/` 的名称有误导性 —— 它是 `v2.0.2`，不是最新版。最新版在 `DSH-desktop-master-fast/`。

### 1.2 版本

| 依赖 | 采用版本 | 说明 |
|---|---|---|
| `@deepseek-ai/cordis` | `4.0.1` | 插件框架。**不是**社区版 `cordis` / `@cordisjs/*`，是 `@deepseek-ai` scope 下的独立发布版本。npm 上 `latest` 即 `4.0.1` |
| `@deepseek-ai/dsh-host-webserver` | `0.1.1-rc.2` | host 路由注册 |
| `@deepseek-ai/dsh-client-ui-slots` | `0.1.1-rc.2` | 客户端 slot 注册 |
| `@deepseek-ai/schemastery` | `^3.18.1` | 配置 schema 校验 |
| Node | `^22.19.0 \|\| >=24.0.0` | 与 harness 的 `engines` 一致 |
| React | 见 1.3 | 客户端插件 |

选 `0.1.1-rc.2` 而非 `v2.0.2` 所用的 `0.1.1-rc.1`：`rc.2` 是当前 npm 上最新的已发布版本，且是 `next` dist-tag 所指。

> **npm 的 `latest` dist-tag 指向 `0.0.1-rc.1`，是个远早于当前的版本。**
> 即 `npm i @deepseek-ai/dsh-host-webserver` 不带版本号会装到 `0.0.1-rc.1`。所有 DSH 依赖都要写死精确版本，不能依赖 `latest`。

具体包名要按实际需要逐个列出，不能用 `@deepseek-ai/dsh-*` 通配 —— **不同版本之间包的集合本身就不同**。例如 `@deepseek-ai/dsh-client-store` 与 `@deepseek-ai/dsh-util-crypto` 在 npm 上返回 404，它们只存在于未发布的 `0.1.2-alpha.1` 中。

### 1.3 React 版本的两个口径

`docs/` 全文没有提到 React —— [客户端结构约定](../02-architecture/01-overall-architecture.md#5-客户端结构与呈现约定)只规定了 DSH store、主题 token 与 CSS Modules。React 来自 DSH 运行时的既有事实，两个口径不同：

- harness 核心包普遍声明 `"react": "^18.2.0"`
- 参考插件 `dsh-plugin-desktop` 锁定 `react` 精确版本 `18.3.1`

本项目跟随后者（精确版本），因为它是「插件」这一角色的实际先例。

## 2. 实现选型与待提交的文档变更

### 2.1 单仓库（无需文档变更）

客户端与服务端同仓，不拆分。这不是新决定 —— [初始工程结构](../04-roadmap/02-minimum-skeleton.md#433-初始工程结构)已经规定 `packages/chat/` 下 `contract`、`host`、`client` 与各领域插件平级并列，且 `@dsh-chat/contract` 是唯一的共享协议包。拆成两个仓库会使 contract 需要发版才能被双方消费，并使跨仓 PR 无法作为一个原子变更评审。

### 2.2 待提交的文档变更

以下三项是实现需要、但**当前文档未覆盖**的内容。按 §3.1 流程，它们要先写入对应层级的文档才能生效；**在那之前本项目不据此实现**。本节只登记提案与去向：

| 提案 | 应写入 | 变更类型 |
|---|---|---|
| 增加一个被 DSH 装载的插件入口包（承载 `dsh.client` / `dsh.bundle` 字段与 `cordis.patch.yml`），命名遵循 DSH 生态的 `dsh-plugin-<name>` 约定 | [§43.3 初始工程结构](../04-roadmap/02-minimum-skeleton.md#433-初始工程结构) + [§6.1 能力与提供者矩阵](../02-architecture/02-plugin-model.md#61-能力与提供者矩阵) + [§47 术语表](../03-details/06-contracts-and-conventions.md#47-术语表) | 新增插件能力 + 新增品牌化 ID |
| 明确包管理器与版本（DSH 生态的桌面产品仓库使用 `yarn@4.18.0`，harness 核心仓库使用 pnpm） | [§48 编码规范](../03-details/06-contracts-and-conventions.md#48-编码规范) | 工程约定 |
| 明确 DSH 运行时依赖的精确版本与升级流程 | [§48 编码规范](../03-details/06-contracts-and-conventions.md#48-编码规范) 或 [§41 协议版本协商](../03-details/05-observability-and-ops.md#41-协议版本协商与升级顺序) | 工程约定 |

> §43.3 目前枚举了 19 个包并明确「全部 19 个包」。新增入口包会改变这个数字，属于[变更分类表](./documentation-workflow.md#2-变更分类与所需更新)中的「新增／调整插件能力」，需架构评审。

### 2.3 Wiki 生成

wiki 由 `scripts/build-wiki.ps1` 从 `docs/` 生成，不手工编辑 wiki 页面。该脚本的 `_Sidebar` 是硬编码的，新增 `docs/` 文档时需要一并更新；页面映射与首页索引则由脚本动态推导，无需改动。

> 文档新增时应同步哪些位置，以[文档维护规范 §5](./documentation-workflow.md#5-文档写作约定)为准（首页目录 + 映射表）。本节只补充「该脚本的侧边栏也是硬编码的」这一实现事实。

## 3. 文档缺口登记

本 Wiki 是散文式规格。部分实体的字段以中文描述给出，缺少英文名与类型标注。下表登记实现前需要补齐的内容。

**本表只登记，不作答。** 每条的答案要通过文档变更 PR 写入对应文档，不在实现中就地定义。

| 缺口 | 现状 | 需补齐之处 |
|---|---|---|
| 字段类型标注与非 ID 字段的英文名 | [§47 术语表](../03-details/06-contracts-and-conventions.md#47-术语表)已定义 32 个品牌化标识符（`AccountId`、`DeviceId`、`MessageRevision`、`DeliverySeq`、`membershipRevision` 等均有英文名）。缺的是**类型标注**，以及标题、描述、优先级这类非 ID 标量字段的英文名 | 契约附录或细节层 |
| 设备状态枚举 | [§34 风险管制](../03-details/04-security-compliance.md#34-风险管制与账号接管防御)给出了 `restricted`、`revoked`、`suspended` 与完整的 `SecurityRiskEvent` 枚举，但没有一处集中声明「设备状态」的完整取值。另注意 `restricted` 一词在[§12](../03-details/01-identity-and-permission.md#12-组织类型容量与订阅)中还用作**订阅**状态，同名不同义 | 契约附录 |
| 工作项状态转换边 | [§17](../01-requirements/02-collaboration-requirements.md#17-工作项与通知)给出 9 个状态，并约束了 `in_review → done` 的评审关口与终态确认规则，但没有完整的转换矩阵 | 需求层或契约附录 |
| 签收状态与工作项状态的耦合 | 签收状态机与工作项状态机在 §17 中并列给出，且明确「通知已送达或已阅读不代表任务已知晓」，但两者之间的对应关系未说明（例如 `acknowledged` 是否必然对应 `assigned`） | 需求层 |
| 非消息命令的幂等键字段名 | 消息侧已明确为 `(senderAccountId, MessageId)`，表情回应为 `(MessageId, revision, accountId, emoji)`。其余命令全文以「操作 ID」「幂等键」描述，未给出字段名与生成规则 | 契约附录 |
| 角色的英文标识符 | [§11.1 角色表](../03-details/01-identity-and-permission.md#111-角色表)的 10 个角色全为中文，无标识符 | 契约附录 |

**已核对、确认不是缺口的项：**

- `AuditEvent` 字段清单 —— [§37 审计事件模型](../03-details/04-security-compliance.md#37-审计事件模型)已完整列出 15 个字段（`AuditEventId`、`OrganizationId`、事件类型、发生时间、服务端序列号、操作者身份、`DeviceId`、来源 IP 前缀与粗粒度区域、目标对象引用、操作结果、错误码、策略版本、关联操作 ID/幂等键、关联领域事件 ID、调用链 ID），并规定了排除项与同事务语义。仅类型标注缺失，归入本表第一行。
- `roleFamily` 的取值 —— [§48 编码规范](../03-details/06-contracts-and-conventions.md#48-编码规范)明确「角色比较组…都是经 schema 校验的组织配置，实现不得把部署可变值写成代码常量」。在文档中固定一份枚举反而违反该条。且排行相关能力定级为 P3。

## 4. 开放决策的阶段归属

[§50 开放决策](../03-details/06-contracts-and-conventions.md#50-开放决策)中标注为 **(P0)** 的共两条。已核对它们对应的[骨架步骤](../04-roadmap/02-minimum-skeleton.md)与[关口划分](../04-roadmap/03-iteration-plan.md#4411-两个验收关口)：

| 开放决策 | 对应骨架步骤 | 该步骤所属关口 |
|---|---|---|
| 第二验证因素是否在 P0 即对组织所有者强制，`webauthn` 能否提前到 P3 | 第 2 步（注册设备、登记 `totp` 与备用码） | `P0-b` |
| 在线/空闲/离线阈值是多少，组织是否允许按项目订阅成员状态变化 | 第 4 步（在线可见范围） | `P0-b` |

**这个映射不改变两条决策的关闭时点。** [文档维护规范 §3.3](./documentation-workflow.md#33-开放决策的关闭)规定「阶段启动前必须关闭标注为该阶段的全部开放决策」，两条的标注是 **(P0)**，而 `P0-a` 是 P0 的第一个验收关口 —— 因此按现行文档，两条都应在 `P0-a` 启动前关闭。

若认为标注应细化为 **(P0-b)**，那是一次需求变更，须由对应领域评审后修改 §50 的标注，**不能以本文档的映射表代替**。

> 补充一处需要评审注意的风险：第一条决策问的是第二因素是否对组织所有者**强制**。按[§8](../03-details/01-identity-and-permission.md#8-第二验证因素)，未满足强制策略的成员「在完成登记前只能访问账号安全设置，不能读写组织内容」—— 这是身份与组织路径上的准入判定，而 `P0-a` 的骨架第 1、3 步会经过该路径。因此「只影响第 2 步」这一判断并不显然成立。

另需注意：无论决策何时关闭，[§44.1.1](../04-roadmap/03-iteration-plan.md#4411-两个验收关口) 都要求 `RecoveryKit` 记录、`ProtocolVersion` 协商字段、账户/设备同步状态与 `encryption_meta` 在 `P0-a` 即写入协议与数据库，不得为压缩 `P0-a` 而删除。

---

[← 上一篇：原文档映射表](./source-mapping.md) | [返回 Wiki 首页](../README.md)
