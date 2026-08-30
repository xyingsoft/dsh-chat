# dsh-chat

> 面向自建团队、受管团队与企业组织的 DSH Web 协作平台。

[English](./README.en.md) · [设计 Wiki](./docs/README.md) · [参与贡献](./CONTRIBUTING.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## 这是什么

dsh-chat 是一组 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，在 DSH Web 上提供组织化的团队协作：身份与设备、组织与权限、文本私聊、工作项与评审、通知收件箱与审计。

它遵循 DSH 的「一切皆插件」模型 —— **没有特权聊天内核**。除纯类型包 `@dsh-chat/contract` 外，所有能力都是可独立装载、可独立卸载的 Cordis 插件。

## 当前状态

**尚未发布。** `P0-a` 的骨架步骤与验收清单已全部覆盖，插件已在 **DSH Desktop v2.0.4 上装载并渲染**（[截图](./docs/_meta/dsh-integration-evidence.md)）。

| 阶段 | 范围 | 状态 |
|---|---|---|
| `P0-a` | 写入协议、投递语义、审计同事务三项架构承诺 | §43 骨架步骤与 §44.1.2 验收清单已全部覆盖 |
| `P0-b` | 第二因素、恢复、在线可见范围、本地搜索、协议协商的完整验收 | 未开始（协议协商的编解码已实现） |
| `P1`–`P4` | 群聊与资源、协作会话与 Bot、治理与分析、企业与 E2EE | 未开始 |

**逐阶段进度、已完成项与未完成项见 [TODO.md](./TODO.md)。** 阶段划分与验收条件见[迭代计划](./docs/04-roadmap/03-iteration-plan.md)。

### 当前可用的能力

以下命令**经真实 HTTP 走通**，共 506 个测试：

- **私聊** —— 发送、按设备租约拉取、确认投递、编辑、撤回
- **组织** —— 创建组织/工作区/项目、邀请成员、接受邀请
- **工作项** —— 创建、分派并发通知、添加依赖（含成环检测）、评审关口
- **通知** —— 收件箱游标补拉、5 分钟窗口聚合、SSE 事件流

所有写端点都有跨源防护、认证注入与审计同事务。身份侧另有设备注册与
Ed25519 请求签名（nonce 去重、时间偏移容忍窗口）。

集成验收起的是**三个真实 OS 进程**：一个 relay 加两个各有本地库的 host。

### 已知未完成项

| 项 | 影响 |
|---|---|
| 会话列表的数据源 | 组件与呈现规则已就绪并测过，但 host 缺按会话聚合的查询端点 |
| relay 客户端抽象 | 三进程验收里 host 直接调 relay 的 HTTP 接口。**插件仍直接调本地领域代码，尚未走 relay** |

第二因素、恢复、在线状态、群聊、附件属后续关口，其入口按文档要求**显式缺失，不伪装为可用**。

## 文档

**本仓库的 [`docs/`](./docs/README.md) 是实现、评审与验收的唯一依据。**

文档按「需求 → 架构 → 细节 → 排期」四层组织，约束只能自上而下传递：

| 层 | 目录 | 回答什么问题 |
|---|---|---|
| 需求说明 | [`01-requirements/`](./docs/01-requirements/) | 做什么、给谁做、明确不做什么 |
| 整体架构 | [`02-architecture/`](./docs/02-architecture/) | 用什么结构做、组件如何切分 |
| 技术细节 | [`03-details/`](./docs/03-details/) | 每个机制具体如何实现 |
| 项目排期 | [`04-roadmap/`](./docs/04-roadmap/) | 什么时候交付、如何验收 |

> **本项目强制「文档先行」**：任何涉及需求变更或架构调整的修改，必须先更新文档再写代码。详见[文档维护规范](./docs/_meta/documentation-workflow.md)。

根目录的 `DESIGN.md` 是重构前的单文件原稿，仅作历史归档，**不再作为实现依据**。

## 技术栈

| | |
|---|---|
| 插件框架 | [`@deepseek-ai/cordis`](https://www.npmjs.com/package/@deepseek-ai/cordis) 4.0.1 |
| DSH 运行时 | `0.1.2-alpha.1`，对应 DSH Desktop `v2.0.4` |
| 语言 | TypeScript，ESM-only |
| Node | `^22.19.0 \|\| >=24.0.0` |
| 客户端 | React 18 + CSS Modules |
| 配置校验 | [`@deepseek-ai/schemastery`](https://www.npmjs.com/package/@deepseek-ai/schemastery) |
| 持久化 | `P0` SQLite（L1），`P1` 起 PostgreSQL + Redis + 对象存储（L2） |

> DSH 运行时**不从 npm 安装** —— 上游自 `0.1.2-alpha.1` 起改为 vendored tarball 分发，npm 上的 `latest` 标签指向一个远早于当前的版本。
> 精确版本、来源 commit、校验方式与升级流程记录在[实现记录](https://github.com/xyingsoft/dsh-chat/blob/main/docs/_meta/implementation-log.md)，本表只作概览。

## 许可

[MIT](./LICENSE)
