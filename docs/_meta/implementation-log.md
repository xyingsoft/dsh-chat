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
- [3.1 已知的工程问题](#31-已知的工程问题)
- [4. 开放决策的阶段归属](#4-开放决策的阶段归属)

---

## 1. 外部依赖现状

**核对日期：2026-08-29**

dsh-chat 是一组 DSH 插件，运行在 DeepSeek Harness 之上。运行时依赖的获取方式见 1.1 —— 它不是普通的 npm 安装。

### 1.1 运行时通过 vendored tarball 消费，不走 npm

DSH 运行时在 `0.1.2-alpha.1` 起改为**全量 vendor 化**：上游 DSH Desktop 的根 `package.json` 把每一个 `@deepseek-ai/dsh-*` 的 `resolutions` 都指向本地 tarball，并提供同步脚本从 harness 源码仓库的构建产物中取包、把 sha256 写入 manifest。

这不是「尚未发布」，而是上游当前的消费方式。因此本项目采用相同机制对齐最新版：

| | |
|---|---|
| 运行时版本 | `0.1.2-alpha.1`（2026-08-28 发布，upstream master 即此 tag） |
| 对应 DSH Desktop | `v2.0.4` |
| 来源仓库 | `https://github.com/deepseek-ai/deepseek-harness.git` |
| 来源 commit | `cd5ef8148158c3a752a658978873241fdf8e2bbc` |
| 完整性校验 | manifest 中逐包记录 sha256 |

上游完整 vendor 目录为 241 个包 / 8.2 MB；本项目只需其中被实际依赖的子集。

> **npm 上的版本不能作为依据。** `@deepseek-ai/dsh-*` 在 npm 的 `latest` dist-tag 指向 `0.0.1-rc.1`（远早于当前），`next` 指向 `0.1.1-rc.2`，而 `0.1.2-alpha.1` 未上传。任何 `npm i @deepseek-ai/dsh-...` 不带精确版本的写法都会装到错误的版本。

> 注：本地检出目录 `DSH-desktop/deepseek-harness-desktop-latest/` 的名称有误导性 —— 它是 `v2.0.2`（运行时 `0.1.1-rc.1`），不是最新版。最新版在 `DSH-desktop-master-fast/`（`v2.0.4`）。

### 1.2 版本

| 依赖 | 采用版本 | 来源 | 说明 |
|---|---|---|---|
| `@deepseek-ai/cordis` | `4.0.1` | npm | 插件框架。**不是**社区版 `cordis` / `@cordisjs/*`。npm `latest` 即 `4.0.1`，与上游锁定一致 |
| `@deepseek-ai/dsh-host-webserver` | `0.1.2-alpha.1` | vendor tarball | host 路由注册 |
| `@deepseek-ai/dsh-invariants` | `0.1.2-alpha.1` | vendor tarball | 前者的 peer 依赖 |
| `@deepseek-ai/schemastery` | `^3.18.1` | npm | 配置 schema 校验 |
| Node | `^22.19.0 \|\| >=24.0.0` | — | 与 harness 的 `engines` 一致 |

以上是 **host 入口点的完整闭包**，共 2 个 vendored 包，随工程骨架落地。

具体包名按实际依赖逐个列出，不用 `@deepseek-ai/dsh-*` 通配 —— **不同版本之间包的集合本身就不同**。

### 1.2.1 客户端闭包尚未确定，且不能只看 dependencies

客户端所需的 `dsh-client-ui-slots` 与 `dsh-client-ui-renderer` **暂不收录**，随 `packages/chat/client` 一并加入。原因是它们的闭包比声明的更大，且用常规方式求不出来：

这两个包**发布出来的 `.d.ts` 里直接 import 了 `react` 与 `@deepseek-ai/dsh-client-store`**，而上游把这两者放在 `devDependencies` —— 遍历 `dependencies` 与 `peerDependencies` 是发现不了的。运行时确实不需要它们（`lib/client.js` 走 DSH 的模块加载器，由宿主提供 react），但**类型检查需要**。

其中 `@deepseek-ai/dsh-client-store` 在 npm 上返回 404，只存在于 `0.1.2-alpha.1`，因此必须一并 vendor。

> **`skipLibCheck: true` 会让这个问题静默发生。** 关闭该选项时上述缺失会报 5 个 `TS2307`；开启时编译通过，但 `SlotComponent`、`PropsStore` 等类型会退化为 `any`，客户端类型安全归零而无任何提示。引入客户端包时须一并重新评估该选项。

### 1.3 React 版本的两个口径

`docs/` 全文没有提到 React —— [客户端结构约定](../02-architecture/01-overall-architecture.md#5-客户端结构与呈现约定)只规定了 DSH store、主题 token 与 CSS Modules。React 来自 DSH 运行时的既有事实，两个口径不同：

- harness 核心包普遍声明 `"react": "^18.2.0"`
- 参考插件 `dsh-plugin-desktop` 锁定 `react` 精确版本 `18.3.1`

本项目跟随后者（精确版本），因为它是「插件」这一角色的实际先例。

## 2. 实现选型与待提交的文档变更

### 2.1 单仓库（无需文档变更）

客户端与服务端同仓，不拆分。这不是新决定 —— [初始工程结构](../04-roadmap/02-minimum-skeleton.md#433-初始工程结构)已经规定 `packages/chat/` 下 `contract`、`host`、`client` 与各领域插件平级并列，且 `@dsh-chat/contract` 是唯一的共享协议包。拆成两个仓库会使 contract 需要发版才能被双方消费，并使跨仓 PR 无法作为一个原子变更评审。

### 2.2 待提交的文档变更

以下三项是实现需要、但**当前文档未覆盖**的内容，须按 §3.1 流程写入对应层级的文档：

| 提案 | 应写入 | 变更类型 | 当前状态 |
|---|---|---|---|
| ~~增加一个被 DSH 装载的插件入口包~~ **改为澄清既有的 `kernel` 即安装入口** | [§6.2 bundle 的装载形态](../02-architecture/02-plugin-model.md#62-bundle-的装载形态) + [§43.3 初始工程结构](../04-roadmap/02-minimum-skeleton.md#433-初始工程结构) | 补充架构说明 | **已完成** |
| 明确包管理器与版本（DSH 生态的桌面产品仓库使用 `yarn@4.18.0`，harness 核心仓库使用 pnpm） | [§48 编码规范](../03-details/06-contracts-and-conventions.md#48-编码规范) | 工程约定 | **已在工程骨架中实现，文档待补** |
| 明确 DSH 运行时依赖的精确版本与升级流程 | [§48 编码规范](../03-details/06-contracts-and-conventions.md#48-编码规范) 或 [§41 协议版本协商](../03-details/05-observability-and-ops.md#41-协议版本协商与升级顺序) | 工程约定 | **已在工程骨架中实现，文档待补** |

> **本节此前写有「在那之前本项目不据此实现」，而工程骨架 PR 先实现了后两项，违反了这条自我约束。**
> 这里如实记录而不是抹去：两项已落地的工程约定需要尽快补进 §48，在补完之前它们只是既成事实，不构成对其他实现的约束。第一项（插件入口包）仍未实现，保持原状。

> 原方案是新增一个 `dsh-plugin-chat` 入口包，会把 §43.3 的包数从 19 改为 20，属于「新增插件能力 + 新增品牌化 ID」。
> **实际不需要。** §43.3 早已把 `kernel` 定义为「L1 插件 bundle」，它本就是这个角色；DSH 对 bundle 的包名也没有强制约定（宿主 profile 中同时存在 `@deepseek-ai/dsh-base`、`dshmarket`、`@local/dsh-weixin` 等多种命名）。因此改为补充说明 `kernel` 的装载形态，包数不变，也不新增品牌化 ID。

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
| 消息编辑窗口的默认值 | [§14.1](../01-requirements/02-collaboration-requirements.md#141-消息编辑与撤回)说「原发送者在**组织配置的**编辑窗口内」可以编辑，但没有给出默认值，也没说窗口从消息创建时间还是最后一次编辑时间起算。实现取 15 分钟、从创建时间起算，**这两个取值都无依据**，仅因端点必须有一个值才能工作 | 需求层或契约附录 |
| 合规撤回权限对应的能力名 | §14.1 说撤回可由「具备**合规权限**的管理员」发起，但 [§11.1 能力表](../03-details/01-identity-and-permission.md#111-角色表)中没有对应条目。实现把它做成注入的判定函数，缺省返回「无权限」，不擅自映射到某个既有能力 | 契约附录 |

**已核对、确认不是缺口的项：**

- `AuditEvent` 字段清单 —— [§37 审计事件模型](../03-details/04-security-compliance.md#37-审计事件模型)已完整列出 15 个字段（`AuditEventId`、`OrganizationId`、事件类型、发生时间、服务端序列号、操作者身份、`DeviceId`、来源 IP 前缀与粗粒度区域、目标对象引用、操作结果、错误码、策略版本、关联操作 ID/幂等键、关联领域事件 ID、调用链 ID），并规定了排除项与同事务语义。仅类型标注缺失，归入本表第一行。
- `roleFamily` 的取值 —— [§48 编码规范](../03-details/06-contracts-and-conventions.md#48-编码规范)明确「角色比较组…都是经 schema 校验的组织配置，实现不得把部署可变值写成代码常量」。在文档中固定一份枚举反而违反该条。且排行相关能力定级为 P3。

## 3.1 已知的工程问题

### 测试运行偶发 worker 崩溃

全量 `vitest run` 约每 12 次出现一次 `Worker exited unexpectedly`。特征：

- **20 个测试文件全部报告通过**，225 个用例无一失败，崩溃发生在某个 fork 退出时
- 单独运行任一包均不复现（各包分别跑，累计 225 个用例全通过）
- 与本仓库近期改动无关 —— 在改动前的树上以同样方式复现（8 次中 1 次）

试过 `poolOptions.forks.singleFork`，10 次未复现；但同期不带该选项也连续 12 次未复现，**因此这不构成证据**，没有采纳。基线故障率约 8%，10 次全过本就有约 20% 的概率纯属偶然。

暂不改配置。`singleFork` 会去掉逐文件的进程隔离，而这些测试要注册 HTTP 路由、开数据库句柄，隔离丢失可能掩盖真实的跨文件状态泄漏 —— 用一个未经证实的修复换掉一层真实的保护不划算。

后果：CI 有约 8% 的概率误报失败，重跑即过。若频率上升再查。

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
