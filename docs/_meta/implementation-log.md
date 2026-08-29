[← 返回 Wiki 首页](../README.md) | **元文档** · 实现记录 | [上一篇：原文档映射表](./source-mapping.md)

---

# 实现记录

> **本文档记录实现过程中的工程决策、外部依赖锁定与文档缺口，不定义任何需求或架构约束。**
> 它属于元文档层，**不参与约束传递** —— 这里的任何内容都不能反过来放宽[需求](../01-requirements/)、[架构](../02-architecture/)或[细节](../03-details/)层的声明。
> 若实现中发现必须突破上层约束，走[文档维护规范](./documentation-workflow.md)第 3.2 节的流程，而不是在本文档里记一笔了事。

## 本篇目录

- [1. 外部依赖锁定](#1-外部依赖锁定)
- [2. 工程决策](#2-工程决策)
- [3. 文档缺口](#3-文档缺口)
- [4. 开放决策的阶段影响](#4-开放决策的阶段影响)

---

## 1. 外部依赖锁定

**记录日期：2026-08-29**

dsh-chat 是一组 DSH 插件，运行在 DeepSeek Harness 之上。相关包已发布至公共 npm，可在本仓库外独立开发（`dsh-plugin-desktop` 即为「仓库外、依赖全部来自 registry」的先例）。

| 依赖 | 锁定版本 | 说明 |
|---|---|---|
| `@deepseek-ai/cordis` | `4.0.1` | 插件框架。**不是**社区版 `cordis` / `@cordisjs/*`，是 `@deepseek-ai` scope 下的独立发布版本 |
| `@deepseek-ai/dsh-*` | `0.1.1-rc.1` | DSH 运行时（`dsh-host-webserver`、`dsh-client-ui-slots` 等） |
| `@deepseek-ai/schemastery` | `^3.18.1` | 配置 schema 校验，对应[编码规范](../03-details/06-contracts-and-conventions.md#48-编码规范)要求的「插件配置必须通过 schema 验证」 |
| Node | `^22.19.0 \|\| >=24.0.0` | 与 DSH 运行时一致 |
| React | `^18.2.0` | 客户端插件；与[客户端结构约定](../02-architecture/01-overall-architecture.md)的 CSS Modules 要求配套 |

> **必须按 `0.1.1-rc.1` 开发，不得按本地 vendor 目录中的 `0.1.2-alpha.1`。**
> 后者尚未发布到 registry，仅存在于 DSH Desktop 检出的本地 tarball 中，两者存在差异。等 `0.1.2` 正式发布后再评估升级，升级属于依赖变更，需单独提交。

**兼容基准**：DSH Desktop `v2.0.4`（2026-08-28 发布）。

## 2. 工程决策

### 2.1 单仓库

**决策：客户端与服务端同仓，不拆分。**

依据：[初始工程结构](../04-roadmap/02-minimum-skeleton.md#433-初始工程结构)已规定 `packages/chat/` 下 `contract`、`host`、`client`、各领域插件平级并列，且「`@dsh-chat/contract` 是唯一的共享协议包」。拆成两个仓库会使 contract 需要发版才能被双方消费，制造版本漂移，并使跨仓 PR 无法作为一个原子变更评审 —— 这与[编码规范](../03-details/06-contracts-and-conventions.md#48-编码规范)中「协议 schema 只放在 `@dsh-chat/contract`」的意图冲突。

### 2.2 包命名

DSH 生态中，能被 DSH 发现并装载的插件包遵循 `dsh-plugin-<name>` 命名（如 `dsh-plugin-desktop`）。本仓库的文档规定的是 `@dsh-chat/*` scoped 名。

**两者服务于不同目的，同时保留：**

| 用途 | 命名 | 例 |
|---|---|---|
| 被 DSH 装载的插件入口包 | `dsh-plugin-chat` | 声明 `dsh.client` / `dsh.bundle` 字段，承载 `cordis.patch.yml` |
| 协议包与领域插件包 | `@dsh-chat/*` | `@dsh-chat/contract`、`@dsh-chat/kernel` 等，按文档原样 |

### 2.3 包管理器

**决策：Yarn（通过 corepack 启用）。**

依据：DSH 生态中，harness 核心仓库用 pnpm，而**仓库外的插件项目**（`dsh-plugin-desktop`）用 Yarn。本仓库属于后者，与其对齐可复用同一套 CI 与依赖解析约定。

### 2.4 Wiki 生成

wiki 由 `scripts/build-wiki.ps1` 从 `docs/` 生成，**不手工编辑 wiki 页面**。新增 `docs/` 文档时必须同步三处：本目录树、[首页目录](../README.md)、以及该脚本中硬编码的 `_Sidebar` 内容。

## 3. 文档缺口

本 Wiki 是散文式规格。除少数代码块外，多数字段以中文描述给出，没有英文标识符与类型标注。实现前需要逐条补齐，**补齐动作走[文档变更流程](./documentation-workflow.md#31-需求架构变更)，不在实现中就地定义**。

已识别的缺口如下，每条标注是否阻塞 `P0-a`：

| 缺口 | 现状 | 阻塞 `P0-a` |
|---|---|---|
| 字段英文名与类型标注 | 除 `text { body }` 与 P1 消息类型外，实体字段均为中文散文列举 | 是 |
| 设备状态枚举 | 仅能从 `DEVICE_RESTRICTED` / `DEVICE_REVOKED` 与 `restricted` 反推，无完整枚举 | 是 |
| `AuditEvent` 字段清单 | [术语表](../03-details/06-contracts-and-conventions.md#47-术语表)定义为「记录事实与引用、不含内容」，未给出字段 | 是 |
| 工作项状态转换边 | [§17](../01-requirements/02-collaboration-requirements.md#17-工作项与通知) 给出 9 个状态与 `in_review → done` 关口，其余转换合法性未定义 | 是 |
| 角色的英文标识符 | 角色表为中文，需确定 `roleFamily` 取值 | 是 |
| 签收状态与工作项状态的耦合 | 两个状态机并列给出，未说明 `acknowledged` 是否必然对应 `assigned` | 是 |
| 幂等键字段名与生成规则 | 消息侧已明确为 `(senderAccountId, MessageId)`，其余命令的「操作 ID」未给出字段名 | 是 |

> 上表**不是**这些缺口的答案，只是登记。答案通过文档变更 PR 写入对应的[契约与规范附录](../03-details/06-contracts-and-conventions.md)或细节层文档后，本表对应行改为指向该文档的链接。

## 4. 开放决策的阶段影响

[§50 开放决策](../03-details/06-contracts-and-conventions.md#50-开放决策)中标注为 P0 的两条，其对应的骨架步骤均落在 `P0-b`：

| 开放决策 | 对应骨架步骤 | 落在哪个关口 | 阻塞 `P0-a` |
|---|---|---|---|
| 第二验证因素是否在 P0 即对组织所有者强制，`webauthn` 能否提前到 P3 | 第 2 步（登记 `totp` 与备用码） | `P0-b` | 否 |
| 在线/空闲/离线阈值是多少，组织是否允许按项目订阅成员状态变化 | 第 4 步（在线可见范围） | `P0-b` | 否 |

因此 `P0-a` 可在这两条决策关闭前动工。但[文档维护规范](./documentation-workflow.md#33-开放决策的关闭)要求「阶段启动前必须关闭标注为该阶段的全部开放决策」，**两条决策必须在 `P0-b` 启动前关闭**。

> 注意：不阻塞 `P0-a` 编码，**不等于**可以从 `P0-a` 的 schema 中省略相关字段。[迭代计划 §44.1.1](../04-roadmap/03-iteration-plan.md#4411-两个验收关口) 明确要求 `RecoveryKit` 记录、`ProtocolVersion` 协商字段、账户/设备同步状态与 `encryption_meta` 在 `P0-a` 即写入协议与数据库。

---

[← 上一篇：原文档映射表](./source-mapping.md) | [返回 Wiki 首页](../README.md)
