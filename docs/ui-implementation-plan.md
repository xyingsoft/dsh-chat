# dsh-chat UI 实施规划（AI 迭代版）

> 配套 [`ui-design.md`](./ui-design.md)（设计契约）与 [`ui-gap-analysis.md`](./ui-gap-analysis.md)（缺口清单）。
> 本文记录**已完成批 1（基础设施 + 视觉重设计）与批 2（P0 收尾）的真实状态**，以及下一步的优先级顺序，作为 AI 迭代工单来源。
> 截止：2026-09-02。批 1 已提交（docs 2h4f3f2 → feat b5abaed，分支 `feat/ui-batch1-foundations`）；批 2 在 `feat/p0-ui-followup`（见 §5）。

---

## 1. 状态总览

| 项 | 状态 |
|---|---|
| 目标 | 按 `ui-design.md` 批 1（基础设施 + 视觉重设计 + 同步真机）落地 |
| 桌面集成 | DSH Desktop v2.0.4 desktop profile；`@dsh-chat/kernel` 单一 loader 源（已修复双源空白）；`--dump-config` 仅一条 `chat-host` |
| 质量门槛 | 批 2 后复跑：`tsc -b` 0 错 · 全仓单测 **770/770**（53 文件）· 客户端 bundle **176.3 KB** 重建并通过 DSH 装载约定校验 |
| 产物 | `packages/chat/host/dist/client.js`（Desktop 经 junction 实时读取） |
| 待提交 | 批 1 已提交并推送；批 2（P0 收尾）在 `feat/p0-ui-followup` 待提交（见 §5） |

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

### 2.4 P0 收尾（批 2，2026-09-02）

| # | 工单 | 落地 |
|---|---|---|
| 1 | 双用户联调环境 | 新建 `examples/two-users/`：`start-relay.mjs`（起 relay + 播种账号「乙」，TCP 探活就绪）· `bob.mjs`（contact/send/log 三命令，直写 relay 库走领域函数）· `README.md`（接线步骤与设计说明）；`.gitignore` 增加 `examples/two-users/data/`。冒烟通过（Windows） |
| 2 | 消息编辑 | host `messaging/conversations.ts` 透传 `revision`（+spec）；客户端 `MessageView` 内联编辑（菜单入口 → textarea → 保存/取消），字素簇校验与 host 同口径，超窗由 host 拒绝 |
| 3 | 空态引导 | `ConversationList` 空态加「去通讯录发起对话」按钮 → 切到通讯录 Tab |
| 4 | 草稿保存 | `Composer` 受控化（`value`/`onChange`）；`ChatSection` 按 peerId 存 localStorage（发送清空、失败回滚）；会话列表「草稿」标记 |
| 5 | 时间细化 | 新建 `time.ts` + spec：`isSameCalendarDay`/`dayLabel`/`formatMessageTime`/`formatListTime`；`MessageView` 日历日分组头（今天/昨天/M月D日/跨年带年份），列表与消息统一相对时间口径 |
| — | 附带修复 | 上一批文档归档的遗漏：24 处源码注释与 spec 的 `docs/` → `docs/archive/` 断链（13 文件，含 5 个测试套件） |

---

## 3. 未完成 / 受限（诚实清单）

| 项 | 原因 / 依赖 |
|---|---|
| 聊天收发**实测** | 联调环境已就绪（`examples/two-users`，冒烟通过：relay 启动/播种/bob 命令）；**真机双端全流程待人工跑**（按 README 接线 Desktop → 开户 → `bob.mjs contact`） |
| PolicyBanner 策略条件 | 未登记 2FA / 配额等条件数据属 P0-b 后端，未到 |
| 账号安全分区（2FA/Recovery/设备管理） | 后端 P0-b 未开始；当前只在能力表标注「未装载」 |
| i18n | 全中文硬编码，尚未引入 message bundle |
| P1+ 大项 | 附件 / 群聊 / @提及 / 工作项 / 通知中心 / 服务端搜索 / 虚拟滚动 等 |
| 视觉定稿 | 已重设计但需真机逐屏确认微调 |
| dream-skin 壁纸 | 第三方插件启动不自动重绘，需「切一次壁纸」（临时）；治本要查它 boot 时序 |
| 编辑窗口默认值 | relay `DEFAULT_EDIT_WINDOW_MS` 取 15 分钟（文档未给默认值，已登记为缺口）；客户端未显示剩余可编辑时间 |

---

## 4. 下一步规划（建议顺序）

### 4.1 P0 收尾（✅ 已全部完成，见 §2.4）

| # | 工单 | 状态 |
|---|---|---|
| 1 | 会话测试环境（examples/two-users 双用户联调） | ✅ 批 2 |
| 2 | host 透传 `revision` + 客户端消息编辑 | ✅ 批 2 |
| 3 | 会话列表空态 → 通讯录引导 | ✅ 批 2 |
| 4 | 草稿保存 + 会话列表草稿标记 | ✅ 批 2 |
| 5 | 消息时间分组头 + 相对时间细化 | ✅ 批 2 |

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

## 5. 提交策略

> main 受保护（需 PR + 状态检查），走分支提交。

**批 1（已完成）**：分支 `feat/ui-batch1-foundations`
- 提交 `2h4f3f2` — docs：缺口分析、设计契约、实施规划
- 提交 `b5abaed` — feat(client)：UI 批 1 基础设施与视觉重设计
- 已推送 origin

**批 2（本次，P0 收尾）**：分支 `feat/p0-ui-followup`（基于批 1）

| 提交 | 内容 | 信息 |
|---|---|---|
| 1 — fix | 13 文件的 `docs/` → `docs/archive/` 断链修复（注释 + spec，无逻辑改动） | `fix: 修复文档归档后的注释与 spec 路径断链` |
| 2 — feat | client 五工单（编辑/草稿/空态/时间分组）+ host `revision` 透传 + `examples/two-users/` + `.gitignore` | `feat(client): P0 收尾——消息编辑、草稿、空态引导、时间分组与双用户联调环境` |
| 3 — docs | 回写本文与 `ui-gap-analysis.md` | `docs: 回写 UI 实施规划与缺口清单（P0 收尾完成）` |

**不纳入提交**：
- `.yarnrc.yml`（本机沙盒缓存路径，环境特定，保留为本地修改）
- `packages/chat/host/dist/client.js`（构建产物，dist 已在 .gitignore）

**推送**：`git push -u origin feat/p0-ui-followup` → 开 PR（基 `feat/ui-batch1-foundations`，两 PR 串行合入）

---

## 6. 验收对照（[ui-design.md §7.3](./ui-design.md#73-验收对照)）

批 1 + 批 2 已对照 U1–U7 与 a11y/i18n/暗色条目自检；以下项**未达标**，需后续工单跟进：

- [ ] U2（必须显式呈现异常态）：PolicyBanner 真实策略条件未接（依赖 P0-b 后端）
- [ ] U4（不可信内容）：附件预览未到位（依赖 P1）
- [ ] i18n：文案 key 化未做
- [ ] 虚拟滚动：消息/会话列表仍全量渲染

批 2 新达标：

- [x] 草稿：已做（Composer 受控化 + localStorage + 列表「草稿」标记）
- [x] 消息编辑：已做（host `revision` 透传 + 内联编辑）

其余 U1/U3/U5/U6/U7 + a11y 焦点陷阱 + 暗色 token + 骨架屏 + 三态分离已在批 1 落地。

---

*本文档基于 2026-09-02 工作区状态撰写（批 2 完成后回写）。下一步工单按 §4.2 起推进，每工单完成后回写本文与 `ui-gap-analysis.md`。*
