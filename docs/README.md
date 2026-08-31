# dsh-chat 设计 Wiki

> 面向自建团队、受管团队与企业组织的 DSH Web 协作平台。
> 本 Wiki 是实现、评审与验收的唯一依据；所有边界声明与拒绝语义均为强约束，不是建议。

---

## 三十秒了解

- **是什么**：一组 DSH 插件，在 DSH Web 上提供组织化团队协作（身份与设备、组织与权限、文本私聊、工作项与评审、通知与审计）。
- **核心约束**：遵循 DSH「一切皆插件」模型，**没有特权聊天内核**；除纯类型包 `@dsh-chat/contract` 外，所有能力都可独立装载与卸载。
- **当前状态**：`P0-a` 关口已通过，`P0-b` 及之后未开始。进度与未完成项以 [TODO.md](../TODO.md) 和[功能全量清单](./_meta/feature-inventory.md)为准，**不在本页维护**。

> **本页不记录进度数字。** 测试数、完成度百分比等易漂移的口径只保留一处出处，避免多处抄写后互相矛盾。

---

## 我该从哪里开始

按你要做的事选一条路径，不必通读四层。

| 你要做的事 | 建议路径 |
|---|---|
| 了解产品是什么、边界在哪 | [产品定位与边界](./01-requirements/01-positioning-and-boundaries.md) → [协作能力需求](./01-requirements/02-collaboration-requirements.md) |
| 准备动手实现一个功能 | [三层总体架构](./02-architecture/01-overall-architecture.md) → [插件化架构](./02-architecture/02-plugin-model.md) → 对应的细节篇 |
| 做安全评审 | [安全与合规](./03-details/04-security-compliance.md) → [身份、组织与权限](./03-details/01-identity-and-permission.md) → [性能、分片与限流](./03-details/03-performance-and-limits.md) |
| 判断某功能算不算做完 | [迭代计划 P0–P4](./04-roadmap/03-iteration-plan.md) → [最小可运行骨架](./04-roadmap/02-minimum-skeleton.md) → [测试与验收策略](./04-roadmap/04-test-strategy.md) |
| 查一个错误码 / 状态 / 术语 | [契约与规范附录](./03-details/06-contracts-and-conventions.md) |
| 排查「文档与实现对不上」 | [实现记录](./_meta/implementation-log.md) → [功能全量清单](./_meta/feature-inventory.md) |
| 修改文档本身 | [文档维护规范](./_meta/documentation-workflow.md)（**先读，有强制流程**） |

---

## ⚠️ 契约区：改动会触发测试失败

`docs/` 不只是给人读的。**部分章节被测试在运行时反向解析**，与代码双向锁定——改动这些区域而不同步代码（或反之），`yarn check:test` 会失败。

这是刻意的防漂移机制，**不是脆弱性**。但修改前必须知道自己动的是哪一类内容。

| 契约区 | 所在文档 | 锁定它的测试 | 被解析的具体内容 |
|---|---|---|---|
| **§46 错误码目录** | [契约与规范附录](./03-details/06-contracts-and-conventions.md) | `contract/src/errors.host.spec.ts` | `## 46. 错误码目录` 到 `## 47.` 之间的表格，逐行正则匹配，行数须与代码一致 |
| **§37 审计事件字段** | [安全与合规](./03-details/04-security-compliance.md) | `contract/src/audit.host.spec.ts` | 以 `每条审计事件包含` 开头的**那一整句**，短语逐字双向比对 |
| **§6.1 能力矩阵事件名** | [插件化架构](./02-architecture/02-plugin-model.md) | `contract/src/commands.host.spec.ts` | 全部领域事件名须以 `` `事件名` `` 形式出现在本篇 |
| **§41 协议协商** | [可观测性与运维](./03-details/05-observability-and-ops.md) | `contract/src/protocol.host.spec.ts` | 三个整句：``​`ProtocolVersion`（单调递增整数）``、``协商失败返回 `PROTOCOL_VERSION_UNSUPPORTED` ``、`relay 返回协商结果、服务端当前版本、最低支持版本和弃用截止时间` |
| **各组状态枚举** | **全部 `docs/`**（合并为一个语料） | `contract/src/states.host.spec.ts` | 形如「``​`a`、`b` 或 `c` ``」的连续枚举，须与代码**逐字一致且顺序相同** |

> **最后一行需特别注意**：状态枚举测试把 `docs/` 下**所有** Markdown 拼成单一语料后做正则匹配，因此它不局限于某一篇。在任何文档里书写反引号包裹的连续枚举时，都要确认没有意外改变既有枚举的字面或顺序。

修改契约区的正确顺序：**先改文档 → 再改代码 → 跑 `yarn check:test` 验证双向锁定仍成立**。反过来做会被测试拦下。

---

## 阅读顺序：需求先行

文档按**需求 → 架构 → 细节 → 排期**四层组织。这个顺序不是分类习惯，而是约束传递方向：**下层文档不得引入上层未声明的需求或边界**。

| 层 | 目录 | 回答什么问题 | 谁必读 |
|---|---|---|---|
| **一、需求说明** | [`01-requirements/`](./01-requirements/) | 做什么、给谁做、明确不做什么 | 所有人 |
| **二、整体架构** | [`02-architecture/`](./02-architecture/) | 用什么结构做、组件如何切分 | 架构、后端、前端、运维 |
| **三、技术细节** | [`03-details/`](./03-details/) | 每个机制具体如何实现 | 对应领域工程师 |
| **四、项目排期** | [`04-roadmap/`](./04-roadmap/) | 什么时候交付、如何验收 | 项目管理、QA |

每篇文档开头都有一个**摘要头**，说明该篇回答什么问题、谁该读、以及三条最容易被违反的关键约束。先读摘要头再决定是否通读全文。

---

## 完整目录

### 一、需求说明（Requirements）

先回答「做什么」。任何技术决策都以本层的边界声明为准绳。

| 文档 | 内容 | 原文对应 |
|---|---|---|
| [01. 产品定位与边界](./01-requirements/01-positioning-and-boundaries.md) | 产品定位、目标用户、能力边界与不做清单、**八条边界声明** | 篇一 §1–3 |
| [02. 协作能力需求](./01-requirements/02-collaboration-requirements.md) | 联系人与群聊、消息模型、附件授权、工作项、评审、共享存储、协作会话、搜索、仓库记录、Bot、插件目录、仪表盘与排行 | 篇四 §13–25 |

### 二、整体架构（Architecture）

回答「用什么结构做」。定义组件边界、扩展模型与部署演进。

| 文档 | 内容 | 原文对应 |
|---|---|---|
| [01. 三层总体架构](./02-architecture/01-overall-architecture.md) | 浏览器 / host / relay 三层职责与凭证硬边界、客户端结构与呈现约定 | 篇二 §4–5 |
| [02. 插件化架构](./02-architecture/02-plugin-model.md) ⚠️ | 一切皆插件、服务定义/提供者/消费者三角色、**能力与提供者矩阵** | 篇二 §6 |
| [03. 服务端结构与部署分层](./02-architecture/03-server-and-deployment.md) | 服务端闭环与写入协议、L0–L3 渐进部署 | 篇五 §26–27 |

### 三、技术细节（Technical Details）

回答「具体怎么做」。每份文档可独立评审。

| 文档 | 内容 | 原文对应 |
|---|---|---|
| [01. 身份、组织与权限](./03-details/01-identity-and-permission.md) | 身份与设备注册、第二验证因素、账号设置与组织切换、多设备同步、组织/工作区/角色、组织类型与订阅 | 篇三 §7–12 |
| [02. 消息投递与持久化](./03-details/02-delivery-and-persistence.md) | 可靠投递流程、流代次与分叉检测、本地与 relay 持久化、迁移策略 | 篇五 §28–29 |
| [03. 性能、分片与限流](./03-details/03-performance-and-limits.md) | 分片策略、**限流与配额基线表**、不可信输入处理 | 篇五 §30 |
| [04. 安全与合规](./03-details/04-security-compliance.md) ⚠️ | 租户隔离、授权链与强制确认、SSRF 防护、风险管制、加密与密钥、缓存保留恢复、审计模型、注销导出、**安全规范清单** | 篇六 §31–39 |
| [05. 可观测性与运维](./03-details/05-observability-and-ops.md) ⚠️ | 必须暴露的指标面、**SLO 与容量目标**、协议版本协商与升级顺序 | 篇七 §40–41 |
| [06. 契约与规范附录](./03-details/06-contracts-and-conventions.md) ⚠️ | **错误码目录**、术语表、编码规范、国际化与无障碍、开放决策 | 篇九 §46–50 |

### 四、项目排期（Roadmap）

回答「什么时候交付、怎样算完成」。

| 文档 | 内容 | 原文对应 |
|---|---|---|
| [01. 关键操作状态矩阵](./04-roadmap/01-operation-states.md) | 每个关键操作的成功条件、可重试情况与终态失败 | 篇八 §42 |
| [02. 最小可运行骨架](./04-roadmap/02-minimum-skeleton.md) | P0 完成判定的 14 步闭环、初始工程结构 | 篇八 §43 |
| [03. 迭代计划 P0–P4](./04-roadmap/03-iteration-plan.md) | 五个阶段的交付范围、用户闭环与验收要求 | 篇八 §44 |
| [04. 测试与验收策略](./04-roadmap/04-test-strategy.md) | 五层测试分工、**安全回归用例库**、性能与迁移测试 | 篇八 §45 |

> ⚠️ 标记表示该篇含契约区，详见上文「契约区：改动会触发测试失败」一节。

### 元文档（Meta）

| 文档 | 内容 |
|---|---|
| [文档维护规范](./_meta/documentation-workflow.md) | **文档先行**开发流程、变更类型与所需更新、评审检查清单 |
| [原文档映射表](./_meta/source-mapping.md) | 原 `DESIGN.md` 全部 50 节到新结构的逐节映射，用于核对完整性 |
| [实现记录](./_meta/implementation-log.md) | 外部依赖锁定、工程决策、文档缺口登记与开放决策的阶段影响 |
| [骨架走查记录](./_meta/skeleton-walkthrough.md) | `P0-a` 九个骨架步骤的实际执行结果，由测试自动生成 |
| [`P0-a` 失败路径覆盖](./_meta/acceptance-coverage.md) | §44.1.2 失败路径清单与验证方式，由测试自动生成 |
| [功能全量清单](./_meta/feature-inventory.md) | 文档要求的全部功能条目与实现状态逐条对账 |
| [DSH 装载验证](./_meta/dsh-integration-evidence.md) | 在真实 DSH Desktop v2.0.4 上的装载验证与未验证部分 |

---

## 阅读约定

- 文中「**必须**」「**不得**」「**绝不**」表示强约束，违反即为缺陷。
- 「默认」表示可由**版本化配置**覆盖的起始值，实现不得写成代码常量。
- 所有以反引号标注的标识符、状态与错误码均在 [契约与规范附录](./03-details/06-contracts-and-conventions.md) 有唯一定义。
- 引用块（`>`）标注的是最易被实现者误解、评审时需逐条核对的条款。
- 摘要头中的「关键约束」是该篇最易被违反的三条，**不能替代正文**——通过评审仍需读全文。

---

## 强制流程：文档先行

> **任何涉及需求变更或架构调整的修改，必须先更新相关文档，再进行代码编写。**

这条流程对大型项目至关重要：高质量的文档约束是高效协作与 vibe coding 的基础，能减少无效返工与 token 浪费，保障后期优化迭代的可行性。**必须避免代码与文档大面积不一致**，否则项目将迅速进入不可控状态。

完整流程、变更分类与评审清单见 [文档维护规范](./_meta/documentation-workflow.md)。

---

## 关于原 DESIGN.md

原文件保留在仓库根目录，作为**历史归档**，不再作为实现依据。后续所有变更只更新本 Wiki。逐节映射关系见 [原文档映射表](./_meta/source-mapping.md)。

> **注意**：`DESIGN.md` 为 UTF-16 编码，且早于本 Wiki 冻结，**不含** `P0-a` / `P0-b` 关口划分等后续概念。它与 `docs/` 已实质分叉，遇到冲突一律以本 Wiki 为准。
