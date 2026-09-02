[← 返回 Wiki 首页](../README.md) | **元文档** · 原文档映射表 | [上一篇：文档维护规范](./documentation-workflow.md) | [下一篇：实现记录 →](./implementation-log.md)

---

# 原文档映射表

本表记录原 `DESIGN.md`（1688 行，九篇 50 节）到当前 Wiki 结构的**逐节映射**，用于核对内容完整性。

> **重构原则**：所有原始内容**完整保留、未做精简**。重构只改变组织方式——把线性长文按「需求先行」拆分为四层，并补充导航、交叉引用与文档维护规范。

---

## 1. 结构变化总览

原文档按「篇」线性排列（一至九篇）。新结构按**需求 → 架构 → 细节 → 排期**四层重组，原篇章被重新归位：

| 原篇 | 原主题 | 新层 | 去向 |
|---|---|---|---|
| 一 | 定位与边界 | **需求** | `01-requirements/01-positioning-and-boundaries.md` |
| 二 | 架构与插件模型 | **架构** | `02-architecture/01-overall-architecture.md`、`02-plugin-model.md` |
| 三 | 身份、组织与权限 | **细节** | `03-details/01-identity-and-permission.md` |
| 四 | 协作能力 | **需求** | `01-requirements/02-collaboration-requirements.md` |
| 五 | 服务端运行面 | **架构 + 细节** | 拆分：§26–27 → 架构；§28–30 → 细节 |
| 六 | 安全与合规 | **细节** | `03-details/04-security-compliance.md` |
| 七 | 可观测性与运维 | **细节** | `03-details/05-observability-and-ops.md` |
| 八 | 交付计划与验收 | **排期** | `04-roadmap/` 四份文档 |
| 九 | 契约与规范附录 | **细节** | `03-details/06-contracts-and-conventions.md` |

**两处关键调整**：

1. **原篇四（协作能力）上移到需求层**。它定义的是「用户能做什么」，属于需求而非实现细节，因此按需求先行原则前置到架构之前。
2. **原篇五（服务端运行面）拆为两处**。§26 服务端闭环与 §27 部署分层属于结构决策，归入架构层；§28 投递流程、§29 持久化、§30 限流属于实现机制，归入细节层。

---

## 2. 逐节映射（全 50 节）

### 原篇一：定位与边界 → 需求层

| 原节 | 标题 | 新位置 |
|---|---|---|
| §1 | 产品定位 | [01-requirements/01 §1](../01-requirements/01-positioning-and-boundaries.md#1-产品定位) |
| §2 | 目标用户 | [01-requirements/01 §2](../01-requirements/01-positioning-and-boundaries.md#2-目标用户) |
| §3 | 能力边界与不做清单（含八条边界声明） | [01-requirements/01 §3](../01-requirements/01-positioning-and-boundaries.md#3-能力边界与不做清单) |

### 原篇二：架构与插件模型 → 架构层

| 原节 | 标题 | 新位置 |
|---|---|---|
| §4 | 三层总体架构（含凭证归属表） | [02-architecture/01 §4](../02-architecture/01-overall-architecture.md#4-三层总体架构) |
| §5 | 客户端结构与呈现约定 | [02-architecture/01 §5](../02-architecture/01-overall-architecture.md#5-客户端结构与呈现约定) |
| §6 | 插件化架构 | [02-architecture/02 §6](../02-architecture/02-plugin-model.md#6-插件化架构) |
| §6.1 | 能力与提供者矩阵 | [02-architecture/02 §6.1](../02-architecture/02-plugin-model.md#61-能力与提供者矩阵) |

### 原篇三：身份、组织与权限 → 细节层

| 原节 | 标题 | 新位置 |
|---|---|---|
| §7 | 身份与设备注册 | [03-details/01 §7](../03-details/01-identity-and-permission.md#7-身份与设备注册) |
| §7.1 | 请求签名与时间偏移 | 同上 §7.1 |
| §7.2 | 恢复路径 | 同上 §7.2 |
| §8 | 第二验证因素 | [03-details/01 §8](../03-details/01-identity-and-permission.md#8-第二验证因素) |
| §9 | 账号设置与组织切换 | [03-details/01 §9](../03-details/01-identity-and-permission.md#9-账号设置与组织切换) |
| §9.1 | 在线状态 | 同上 §9.1 |
| §10 | 多设备同步 | [03-details/01 §10](../03-details/01-identity-and-permission.md#10-多设备同步) |
| §11 | 组织、工作区与角色 | [03-details/01 §11](../03-details/01-identity-and-permission.md#11-组织工作区与角色) |
| §11.1 | 角色表 | 同上 §11.1 |
| §11.2 | 组织状态与所有权 | 同上 §11.2 |
| §12 | 组织类型、容量与订阅 | [03-details/01 §12](../03-details/01-identity-and-permission.md#12-组织类型容量与订阅) |

### 原篇四：协作能力 → 需求层

| 原节 | 标题 | 新位置 |
|---|---|---|
| §13 | 联系人与群聊 | [01-requirements/02 §13](../01-requirements/02-collaboration-requirements.md#13-联系人与群聊) |
| §13.1 | 群与成员版本 | 同上 §13.1 |
| §13.2 | 群历史授权 | 同上 §13.2 |
| §13.3 | 仓库绑定 | 同上 §13.3 |
| §14 | 消息模型 | [01-requirements/02 §14](../01-requirements/02-collaboration-requirements.md#14-消息模型) |
| §14.1 | 消息编辑与撤回 | 同上 §14.1 |
| §15 | 消息交互功能范围 | [01-requirements/02 §15](../01-requirements/02-collaboration-requirements.md#15-消息交互功能范围) |
| §15.1 | 表情回应 | 同上 §15.1 |
| §15.2 | 转发、共享与引用的区别 | 同上 §15.2 |
| §15.3 | 线程 | 同上 §15.3 |
| §16 | 附件与内容授权 | [01-requirements/02 §16](../01-requirements/02-collaboration-requirements.md#16-附件与内容授权) |
| §17 | 工作项与通知 | [01-requirements/02 §17](../01-requirements/02-collaboration-requirements.md#17-工作项与通知) |
| §17.1 | 通知与收件箱 | 同上 §17.1 |
| §18 | 评审与评论 | [01-requirements/02 §18](../01-requirements/02-collaboration-requirements.md#18-评审与评论) |
| §19 | 共享存储与选择性共享 | [01-requirements/02 §19](../01-requirements/02-collaboration-requirements.md#19-共享存储与选择性共享) |
| §19.1 | 组织共享存储 | 同上 §19.1 |
| §19.2 | 选择性共享 | 同上 §19.2 |
| §20 | 协作会话与开发交接 | [01-requirements/02 §20](../01-requirements/02-collaboration-requirements.md#20-协作会话与开发交接) |
| §20.1 | 沙箱执行约束 | 同上 §20.1 |
| §20.2 | 候选产物与接受流程 | 同上 §20.2 |
| §21 | 搜索与索引 | [01-requirements/02 §21](../01-requirements/02-collaboration-requirements.md#21-搜索与索引) |
| §22 | 仓库与 AI 辅助开发记录 | [01-requirements/02 §22](../01-requirements/02-collaboration-requirements.md#22-仓库与-ai-辅助开发记录) |
| §23 | 群内公共 Bot | [01-requirements/02 §23](../01-requirements/02-collaboration-requirements.md#23-群内公共-bot) |
| §23.1 | 权限静态绑定 | 同上 §23.1 |
| §23.2 | 调用与上下文冻结 | 同上 §23.2 |
| §24 | 公共插件与工具目录 | [01-requirements/02 §24](../01-requirements/02-collaboration-requirements.md#24-公共插件与工具目录) |
| §25 | 仪表盘、报告与排行 | [01-requirements/02 §25](../01-requirements/02-collaboration-requirements.md#25-仪表盘报告与排行) |
| §25.1 | token 与成本大屏 | 同上 §25.1 |
| §25.2 | 个人工作台与个人排行 | 同上 §25.2 |
| §25.3 | AI 协作月报与周报 | 同上 §25.3 |
| §25.4 | 同层级效率排行 | 同上 §25.4 |

### 原篇五：服务端运行面 → 架构层 + 细节层

| 原节 | 标题 | 新位置 |
|---|---|---|
| §26 | 服务端闭环与写入协议 | **架构** [02-architecture/03 §26](../02-architecture/03-server-and-deployment.md#26-服务端闭环与写入协议) |
| §27 | L0 至 L3 渐进部署 | **架构** [02-architecture/03 §27](../02-architecture/03-server-and-deployment.md#27-l0-至-l3-渐进部署) |
| §28 | 可靠投递流程 | **细节** [03-details/02 §28](../03-details/02-delivery-and-persistence.md#28-可靠投递流程) |
| §28.1 | 流代次与分叉检测 | 同上 §28.1 |
| §29 | 本地与 relay 持久化 | **细节** [03-details/02 §29](../03-details/02-delivery-and-persistence.md#29-本地与-relay-持久化) |
| §29.1 | 迁移策略 | 同上 §29.1 |
| §30 | 性能、分片与限流 | **细节** [03-details/03 §30](../03-details/03-performance-and-limits.md#30-性能分片与限流) |
| §30.1 | 限流与配额基线 | 同上 §30.1 |

### 原篇六：安全与合规 → 细节层

| 原节 | 标题 | 新位置 |
|---|---|---|
| §31 | 标识、租户与会话隔离 | [03-details/04 §31](../03-details/04-security-compliance.md#31-标识租户与会话隔离) |
| §32 | 授权链、强制确认与黑名单 | [03-details/04 §32](../03-details/04-security-compliance.md#32-授权链强制确认与黑名单) |
| §33 | 连接、外部网络与 SSRF 防护 | [03-details/04 §33](../03-details/04-security-compliance.md#33-连接外部网络与-ssrf-防护) |
| §33.1 | 短连接与长连接 | 同上 §33.1 |
| §33.2 | 受控出站 | 同上 §33.2 |
| §34 | 风险管制与账号接管防御 | [03-details/04 §34](../03-details/04-security-compliance.md#34-风险管制与账号接管防御) |
| §35 | 加密与密钥 | [03-details/04 §35](../03-details/04-security-compliance.md#35-加密与密钥) |
| §35.1 | 加密模式功能矩阵 | 同上 §35.1 |
| §36 | 缓存、保留与恢复 | [03-details/04 §36](../03-details/04-security-compliance.md#36-缓存保留与恢复) |
| §36.1 | 保留策略基线 | 同上 §36.1 |
| §37 | 审计事件模型 | [03-details/04 §37](../03-details/04-security-compliance.md#37-审计事件模型) |
| §38 | 账号注销、导出与合规 | [03-details/04 §38](../03-details/04-security-compliance.md#38-账号注销导出与合规) |
| §38.1 | 数据导出 | 同上 §38.1 |
| §38.2 | 账号注销 | 同上 §38.2 |
| §38.3 | 组织删除与数据导入 | 同上 §38.3 |
| §39 | 安全规范清单 | [03-details/04 §39](../03-details/04-security-compliance.md#39-安全规范清单) |

### 原篇七：可观测性与运维 → 细节层

| 原节 | 标题 | 新位置 |
|---|---|---|
| §40 | 可观测性、SLO 与容量目标 | [03-details/05 §40](../03-details/05-observability-and-ops.md#40-可观测性slo-与容量目标) |
| §40.1 | 服务等级目标 | 同上 §40.1 |
| §41 | 协议版本协商与升级顺序 | [03-details/05 §41](../03-details/05-observability-and-ops.md#41-协议版本协商与升级顺序) |

### 原篇八：交付计划与验收 → 排期层

| 原节 | 标题 | 新位置 |
|---|---|---|
| §42 | 关键操作的成功与失败状态 | [04-roadmap/01](../04-roadmap/01-operation-states.md#42-关键操作的成功与失败状态) |
| §43 | 最小可运行骨架 | [04-roadmap/02](../04-roadmap/02-minimum-skeleton.md#43-最小可运行骨架) |
| §43.1 | 初始工程结构 | 同上 §43.1 |
| §44 | 迭代计划 P0–P4 | [04-roadmap/03](../04-roadmap/03-iteration-plan.md#44-迭代计划-p0p4) |
| §44.1–44.5 | P0 至 P4 各阶段 | 同上各小节 |
| §45 | 测试与验收策略 | [04-roadmap/04](../04-roadmap/04-test-strategy.md#45-测试与验收策略) |

### 原篇九：契约与规范附录 → 细节层

| 原节 | 标题 | 新位置 |
|---|---|---|
| §46 | 错误码目录（33 条） | [03-details/06 §46](../03-details/06-contracts-and-conventions.md#46-错误码目录) |
| §47 | 术语表（32 条） | [03-details/06 §47](../03-details/06-contracts-and-conventions.md#47-术语表) |
| §48 | 编码规范 | [03-details/06 §48](../03-details/06-contracts-and-conventions.md#48-编码规范) |
| §49 | 国际化、时区与无障碍 | [03-details/06 §49](../03-details/06-contracts-and-conventions.md#49-国际化时区与无障碍) |
| §50 | 开放决策 | [03-details/06 §50](../03-details/06-contracts-and-conventions.md#50-开放决策) |
| §50.1–50.4 | 产品/安全/集成/商业化四类 | 同上各小节 |

---

## 3. 关键表格清点

原文档的全部规范性表格均已完整迁移：

| 表格 | 原位置 | 新位置 |
|---|---|---|
| 八条边界声明 | §3 | [需求 01 §3.1](../01-requirements/01-positioning-and-boundaries.md#31-八条边界声明) |
| 三层凭证归属 | §4 | [架构 01 §4.1](../02-architecture/01-overall-architecture.md#41-凭证归属硬边界) |
| 能力与提供者矩阵（14 行） | §6.1 | [架构 02 §6.1](../02-architecture/02-plugin-model.md#61-能力与提供者矩阵) |
| 角色表（10 角色） | §11.1 | [细节 01 §11.1](../03-details/01-identity-and-permission.md#111-角色表) |
| 组织类型表 | §12 | [细节 01 §12](../03-details/01-identity-and-permission.md#12-组织类型容量与订阅) |
| 消息交互功能定级（12 项） | §15 | [需求 02 §15](../01-requirements/02-collaboration-requirements.md#15-消息交互功能范围) |
| 转发/共享/引用对比 | §15.2 | [需求 02 §15.2](../01-requirements/02-collaboration-requirements.md#152-转发共享与引用的区别) |
| 可搜索范围表（6 类对象） | §21 | [需求 02 §21](../01-requirements/02-collaboration-requirements.md#21-搜索与索引) |
| E2EE 搜索降级矩阵 | §21 | 同上 |
| 效率排行维度与权重 | §25.4 | [需求 02 §25.4](../01-requirements/02-collaboration-requirements.md#254-同层级效率排行) |
| L0–L3 部署分层 | §27 | [架构 03 §27](../02-architecture/03-server-and-deployment.md#27-l0-至-l3-渐进部署) |
| 限流与配额基线（14 维度） | §30.1 | [细节 03 §30.1](../03-details/03-performance-and-limits.md#301-限流与配额基线) |
| 加密模式功能矩阵 | §35.1 | [细节 04 §35.1](../03-details/04-security-compliance.md#351-加密模式功能矩阵) |
| 保留策略基线（6 类数据） | §36.1 | [细节 04 §36.1](../03-details/04-security-compliance.md#361-保留策略基线) |
| 审计不可变性分层 | §37 | [细节 04 §37](../03-details/04-security-compliance.md#37-审计事件模型) |
| 导出范围表（3 主体） | §38.1 | [细节 04 §38.1](../03-details/04-security-compliance.md#381-数据导出) |
| SLO 与容量目标（10 指标） | §40.1 | [细节 05 §40.1](../03-details/05-observability-and-ops.md#401-服务等级目标) |
| 关键操作状态矩阵（33 操作） | §42 | [排期 01](../04-roadmap/01-operation-states.md#42-关键操作的成功与失败状态) |
| 迭代计划总览（P0–P4） | §44 | [排期 03](../04-roadmap/03-iteration-plan.md#44-迭代计划-p0p4) |
| 测试分层（5 层） | §45 | [排期 04](../04-roadmap/04-test-strategy.md#45-测试与验收策略) |
| 错误码目录（33 条） | §46 | [细节 06 §46](../03-details/06-contracts-and-conventions.md#46-错误码目录) |
| 术语表（32 条） | §47 | [细节 06 §47](../03-details/06-contracts-and-conventions.md#47-术语表) |

---

## 4. 重构中新增的内容

以下内容为重构时**新增**，不属于原文档，用于提升可读性与实用性：

| 新增内容 | 位置 | 用途 |
|---|---|---|
| Wiki 首页与四层导航 | [`docs/README.md`](../README.md) | 全局索引与阅读顺序 |
| 各文档顶部/底部导航条 | 每份文档 | 顺序阅读与返回首页 |
| 各文档「本篇目录」 | 每份文档 | 文档内快速跳转 |
| 层级定位说明块 | 每份文档开头 | 声明该文档属于哪一层、受何约束 |
| 交叉引用链接 | 全部文档 | 替代原文的隐式关联 |
| 文档维护规范 | [`_meta/documentation-workflow.md`](./documentation-workflow.md) | **文档先行**流程、变更分类表、评审清单 |
| 本映射表 | `_meta/source-mapping.md` | 完整性核对 |
| 实现记录 | [`_meta/implementation-log.md`](./implementation-log.md) | 外部依赖版本、工程决策与文档缺口登记 |

**原文档中的「阅读指引」与「目录」两节**（原 6–54 行）已被 Wiki 首页与各文档的本篇目录取代，其导航意图完整保留。

---

## 5. 原文档归档说明

原 `DESIGN.md` 保留在仓库根目录作为**历史归档**，不再作为实现依据。

- 后续所有变更**只更新本 Wiki**，不再回写 `DESIGN.md`。
- 若需查阅重构前的原始表述，可对照本表定位。

---

[← 上一篇：文档维护规范](./documentation-workflow.md) | [返回 Wiki 首页](../README.md) | [下一篇：实现记录 →](./implementation-log.md)
