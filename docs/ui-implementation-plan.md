# dsh-chat UI 实施规划（AI 迭代版）

> 配套 [`ui-design.md`](./ui-design.md)（设计契约）与 [`ui-gap-analysis.md`](./ui-gap-analysis.md)（缺口清单）。
> 本文记录**已完成批 1 的真实状态**与**下一步的优先级顺序**，作为 AI 迭代工单来源。
> 截止：2026-09-02。代码基线：commit 89d6274 之上的工作区改动（待提交）。

---

## 1. 状态总览

| 项 | 状态 |
|---|---|
| 目标 | 按 `ui-design.md` 批 1（基础设施 + 视觉重设计 + 同步真机）落地 |
| 桌面集成 | DSH Desktop v2.0.4 desktop profile；`@dsh-chat/kernel` 单一 loader 源（已修复双源空白）；`--dump-config` 仅一条 `chat-host` |
| 质量门槛 | `tsc -b` 0 错 · client 单测 **112/112** · 客户端 bundle **161.8 KB** 重建并通过 DSH 装载约定校验 |
| 产物 | `packages/chat/host/dist/client.js`（Desktop 经 junction 实时读取） |
| 待提交 | 工作区未 commit；规划分两批：docs → feat（见 §5） |

---

## 2. 已完成（批 1）

### 2.1 设计系统地基（新建）

| 路径 | 内容 |
|---|---|
| `packages/chat/client/src/styles/tokens.module.css` | 浅/暗两套 design tokens；组件全部 token 化；暗色随 DSH 主题 |
| `packages/chat/client/src/components/Avatar.{tsx,module.css}` | 生成式头像（首字 + hash→色） |
| `components/RelativeTime.{tsx,client.spec.ts}` | 相对时间工具 |
| `components/Skeleton.{tsx,module.css}` | 加载骨架 |
| `components/Dialog.{tsx,module.css}` | 焦点陷阱 + a11y + 滚动锁 |
| `components/Toast.{tsx,module.css}` | 去重 / FIFO / `role` 完备 |
| `components/DropdownMenu.{tsx,module.css}` | 右键 + 键盘导航 |
| `components/PolicyBanner.{tsx,module.css}` | 占布局的策略警告条 |
| `components/LocalSearch.{tsx,module.css}` | 本地搜索（输入即过滤 + `<mark>` 高亮） |
| `components/ProtocolUnsupportedPage.{tsx,module.css}` | 协议不兼容整页替换 |

### 2.2 真实功能接线

- **发送失败重试**：`ChatSection` 补 `onRetry`，复用幂等 `messageId`（落地 [ui-design.md §3.6](./ui-design.md#36-发送失败重试接通)）
- **消息右键菜单**：复制（剪贴板 + Toast）、本人消息撤回（Dialog 二次确认 → `/messages/revoke` → 刷新）
- **通讯录**：接受/拒绝、联系人发消息/移除（接 `/contacts/*`）
- **本地搜索**：输入即过滤 + `<mark>` 高亮（会话标题/预览）
- **协议不兼容**：整页替换；加载骨架；本地单机模式占布局提示条
- **设置面板新块**：`BasicSettings.tsx` —— 模式徽标 / 账号 ID（复制）/ 设备 ID / 版本胶囊 / **退出登录**（确认 → `/identity/sign-out` → 刷新）

### 2.3 视觉与体验

- 会话行头像 + 在线点；消息行头像；相对时间工具；输入框自适应高度；焦点环；能力表状态胶囊；浅色/暗色全适配

---

## 3. 未完成 / 受限（诚实清单）

| 项 | 原因 / 依赖 |
|---|---|
| 聊天收发**实测** | 单机 `local` 模式无会话。需 relay + 第二 host/账号（或先跑仓库三进程验收环境） |
| 消息**编辑** UI | `/messages/edit` 需 `targetRevision`，但 history 接口不返回 `revision` → 需 host 补字段 |
| PolicyBanner 策略条件 | 未登记 2FA / 配额等条件数据属 P0-b 后端，未到 |
| 账号安全分区（2FA/Recovery/设备管理） | 后端 P0-b 未开始；当前只在能力表标注「未装载」 |
| i18n | 全中文硬编码，尚未引入 message bundle |
| P1+ 大项 | 附件 / 群聊 / @提及 / 工作项 / 通知中心 / 服务端搜索 / 虚拟滚动 等 |
| 视觉定稿 | 已重设计但需真机逐屏确认微调 |
| dream-skin 壁纸 | 第三方插件启动不自动重绘，需「切一次壁纸」（临时）；治本要查它 boot 时序 |
| host 侧 2 个 spec | 引用已归档 docs 路径（既有问题，非本次引入） |

---

## 4. 下一步规划（建议顺序）

### 4.1 P0 收尾（优先级高）

| # | 工单 | 依赖 |
|---|---|---|
| 1 | 会话**新建/测试环境**：跑 relay+双 host 或提供第二账号，让列表有数据可测 | 环境 |
| 2 | host `messageView/history` 返回 `revision` → 客户端**编辑**（内联编辑 + 超窗不显示） | host 字段补齐 |
| 3 | 会话列表**空态 → 开户 → 邀请**闭环引导（让单机用户知道怎么造出会话） | 无 |
| 4 | 草稿保存（每会话 localStorage）+ 会话列表草稿标记 | 无 |
| 5 | 消息时间**分组头**（今天/昨天）+ 更细的相对时间 | 无 |

### 4.2 P0-b 壳（等后端或先静态壳）

| # | 工单 | 依赖 |
|---|---|---|
| 6 | 账号安全分区（2FA 登记流程、RecoveryKit、设备列表/撤销） | P0-b 后端 |
| 7 | PolicyBanner 接真实策略条件；VisibilityPicker 接 presence 可见范围接口 | P0-b 后端 |
| 8 | 本地搜索扩展到已加载消息正文（撤回不出现、命中跳转高亮） | 无 |

### 4.3 基础设施补强

| # | 工单 | 依赖 |
|---|---|---|
| 9 | i18n message bundle（把 `presentation.ts` 文案 key 化） | 无 |
| 10 | Dialog/Toast/DropdownMenu 行为级测试（需 DOM 渲染层） | 无 |
| 11 | 通用 `ConfirmDialog`、`EmptyState`、`ErrorBoundary`、虚拟列表 | 无 |

### 4.4 P1+（大项，需先定需求优先级）

| # | 工单 | 依赖 |
|---|---|---|
| 12 | 附件（选择/拖拽/粘贴、进度、预览、撤回连带） | P1 后端 |
| 13 | 工作项 UI、通知中心 UI | P1 后端 |
| 14 | 群聊类型会话 + @提及补全 | P1 后端 |
| 15 | 服务端搜索入口（与本地搜索区分） | P1 后端 |
| 16 | 设置页重构（账号安全/通知/隐私/外观分栏） | 无 |

---

## 5. 提交策略（本次执行）

> main 受保护（需 PR + 状态检查），按内存教训走分支 + 两批提交。

**分支**：`feat/ui-batch1-foundations`

**提交 1 — docs**：
- `docs/ui-gap-analysis.md`
- `docs/ui-design.md`
- `docs/ui-implementation-plan.md`

提交信息：`docs: UI 缺口分析、设计契约与批 1 实施规划`

**提交 2 — feat**：
- `packages/chat/client/src/styles/` 新增
- `packages/chat/client/src/components/` 12 个新组件
- `packages/chat/client/src/client/BasicSettings.{tsx,module.css}`
- `packages/chat/client/src/client/index.ts` 与既有 9 个面板/组件的修改（tokens 化、视觉重设计、`onRetry` 接通、右键菜单、通讯录补按钮、骨架屏等）

提交信息：`feat(client): UI 批 1 基础设施与视觉重设计`

**不纳入本次提交**：
- `.yarnrc.yml`（本机沙盒缓存路径，环境特定，保留为本地修改）

**推送**：`git push -u origin feat/ui-batch1-foundations` → 开 PR

---

## 6. 验收对照（[ui-design.md §7.3](./ui-design.md#73-验收对照)）

批 1 已对照 U1–U7 与 a11y/i18n/暗色条目自检；以下项**未达标**，需后续工单跟进：

- [ ] U2（必须显式呈现异常态）：PolicyBanner 真实策略条件未接（依赖 P0-b 后端）
- [ ] U4（不可信内容）：附件预览未到位（依赖 P1）
- [ ] i18n：文案 key 化未做
- [ ] 虚拟滚动：消息/会话列表仍全量渲染
- [ ] 草稿：未做
- [ ] 消息编辑：未做（依赖 host `revision` 字段）

其余 U1/U3/U5/U6/U7 + a11y 焦点陷阱 + 暗色 token + 骨架屏 + 三态分离已在批 1 落地。

---

*本文档基于 2026-09-02 工作区状态撰写。下一步工单按 §4 顺序推进，每工单完成后回写本文与 `ui-gap-analysis.md`。*
