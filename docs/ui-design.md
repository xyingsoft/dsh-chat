# dsh-chat UI 设计（AI 迭代版）

> 配套 [`ui-gap-analysis.md`](./ui-gap-analysis.md)：那里讲「现状有什么、缺什么、属哪一阶段」，本文讲「**该怎么设计、约束是什么、怎么落**」。
> 本文件是 UI 层的**唯一实现依据**：信息架构、组件契约、状态与交互、横切关注点。逐组件实现时按本文件契约 + 归档规格的边界条款执行。
> 阶段标注与 gap 分析一致：🔴 P0-b / 🟠 P1 / 🟡 P2 / 🟢 P3 / 🔵 P4。

---

## 1. 设计原则与信息架构

### 1.1 七条 UI 硬约束

> 这些是评审与验收的硬约束，违反即为缺陷。理由与归档边界同源（[README §3](./README.md#3-不可违背的设计原则)）。

| # | 约束 | 含义 |
|---|---|---|
| **U1** | **绝不把未确认内容显示为已送达** | 待发/失败/已接收三态**视觉可分**；pending 不混进 accepted 列表（§5） |
| **U2** | **必须显式呈现异常态，不得静默停止刷新** | SSE 断开、`sync_diverged`、协议不兼容、组织切换、权限修订都要占布局条而非浮层（§5、§8.1-6） |
| **U3** | **撤回 ≠ 抹除，UI 不暗示抹除** | 撤回后正文替换为占位 `[已撤回]`；引用要标「原消息已撤回/已编辑」，不静默篡改上下文（§14.1） |
| **U4** | **正文为不可信内容** | 不做 Markdown/HTML 渲染；经 React 文本节点输出；换行靠 `white-space: pre-wrap`（§18） |
| **U5** | **颜色不作为唯一状态信号** | 投递态、风险态、在线状态必须有文本/图标/形状冗余（§49） |
| **U6** | **错误码不泄露存在性** | `NOT_FOUND_OR_FORBIDDEN` 一律合并文案；不区分「不存在/无权」；不暴露其他组织/成员/文件/群（错误码目录） |
| **U7** | **界面可用操作来自 host 返回的能力描述** | 客户端不重算权限；按钮可见性跟 host 字段走，每次调用仍由服务端完整鉴权（§5） |

辅助原则（非硬约束但默认遵守）：

- **本地无权威缓存**：会话/消息/在线状态字段全部由 host 注入，组件不自己拼两份列表、不自己算权限（见 [ConversationList](../packages/chat/client/src/client/ConversationList.tsx) 注释）。
- **占布局的警告优先于 toast**：影响继续操作的策略前置条件（未登记 2FA、版本不兼容、配额超额）必须**占据布局**，不用 toast——浮层会被忽略、被盖住。
- **失败回滚而非静默**：乐观更新失败要回滚并显式提示（[VisibilityPicker](../packages/chat/client/src/client/VisibilityPicker.tsx) 已示范）。
- **空态要区分原因**：「没有会话」与「还没加载」、「搜不到」与「组织里就你一个」是不同状态，文案不能合并。
- **措辞从对方视角写**：可见性等设置项要说「别人会看到什么」，不说「隐藏」这种会被误解为「替你撒谎」的词。

### 1.2 信息架构（现状 + P0-b 后的形态）

```text
DSH Web 主壳
├── 设置面板（dsh-chat 分区）
│   ├── 能力状态表（StatusSection）          [已就绪]
│   └── 账号安全分区                          [P0-b 新增，见 §3.1]
│       ├── 第二因素（2FA）
│       ├── 恢复（RecoveryKit）
│       ├── 已登记设备列表
│       └── 我的资料 / 退出登录
│
└── 会话抽屉（ChatDrawer，右侧滑出 300–900px）
    ├── 头部
    │   ├── 标题 / 未读角标
    │   ├── 可见范围选择器（VisibilityPicker）  [壳已就绪，P0-b 接通 + 策略前置条]
    │   ├── 恢复默认宽度 / 关闭
    │   └── 强制策略警告条（占布局，非 toast）    [P0-b 新增]
    │
    ├── Tab：会话 / 通讯录
    │
    ├── 会话 Tab
    │   ├── 本地搜索框                          [P0-b 新增，§3.4]
    │   ├── 会话列表（ConversationList）
    │   └── （宽 ≥640px）右侧：消息视图 + 输入框
    │
    ├── 通讯录 Tab（DirectoryPanel）
    │   ├── 待处理请求置顶
    │   ├── 搜索框（按名字过滤，与本地搜索不同源）
    │   └── 成员列表（四种状态按钮）
    │
    └── （单栏钻取 <640px）返回条 + 消息视图
```

**布局切换阈值 640px** 来自 [ChatSection](../packages/chat/client/src/client/ChatSection.tsx#L47) 的 `SPLIT_THRESHOLD`。改这个数要同时复核抽屉最小宽度（300）与 Composer 单行高度。

### 1.3 阶段范围对照

| 阶段 | UI 范围 |
|---|---|
| 🔴 **P0-b** | 账号安全（2FA/Recovery/设备/我的资料）、VisibilityPicker 接通+策略前置条、本地搜索、协议协商失败态页、发送失败重试接通 |
| 🟠 **P1** | 群聊类型会话、附件上传/预览、消息上下文菜单（复制/编辑/撤回/引用/转发/回复/删除/多选）、工作项 UI、通知中心 UI、资源库 Tab、服务端搜索、头像、相对时间、设备列表、会话聚合字段对齐 |
| 🟡 **P2** | 协作会话入口、沙箱执行输出流、群 Bot、线程、转发选择器、表情反应、草稿、SSE 实时订阅接通、输入中状态 |
| 🟢 **P3** | 团队版配额提示、组织治理后台、插件目录、成本大屏/排行、唯一所有者转让、设置页重构 |
| 🔵 **P4** | E2EE 锁标识与密钥指纹、多组织切换器、企业目录同步状态、审计归档查询页、KMS 管理页、降级矩阵呈现 |

---

## 2. 组件库与基础设施

### 2.1 现有组件清单（基线，勿重复造）

| 组件 | 路径 | 契约要点 |
|---|---|---|
| `StatusSection` | [StatusSection.tsx](../packages/chat/client/src/client/StatusSection.tsx) | 能力状态表：绿/橙/灰三态，**不可作为功能就绪凭据**（只是诊断） |
| `ChatDrawer` | [ChatDrawer.tsx](../packages/chat/client/src/client/ChatDrawer.tsx) | Portal 渲染、宽度持久化（300–900）、Esc 关闭 |
| `ChatSection` | [ChatSection.tsx](../packages/chat/client/src/client/ChatSection.tsx) | 会话+消息+输入组合；640px 切并排/钻取；持有 pending 消息 |
| `ConversationList` | [ConversationList.tsx](../packages/chat/client/src/client/ConversationList.tsx) | 纯呈现：数据/未读/预览全由 host 注入；唯一本地状态是「选中」 |
| `MessageView` | [MessageView.tsx](../packages/chat/client/src/client/MessageView.tsx) | 左右气泡、撤回占位、已编辑、投递三态、SSE 状态条 |
| `Composer` | [Composer.tsx](../packages/chat/client/src/client/Composer.tsx) | 字素簇计数（8000）、Enter 发送、`isComposing` 防 IME 误发 |
| `DirectoryPanel` | [DirectoryPanel.tsx](../packages/chat/client/src/client/DirectoryPanel.tsx) | 通讯录四态按钮、待处理请求置顶、搜索过滤 |
| `EnrollmentPanel` | [EnrollmentPanel.tsx](../packages/chat/client/src/client/EnrollmentPanel.tsx) | 邀请码开户；失败统一文案不区分原因（U6） |
| `VisibilityPicker` | [VisibilityPicker.tsx](../packages/chat/client/src/client/VisibilityPicker.tsx) | 三档（everyone/shared_scopes/hidden）；原生 select 保键盘可达 |
| `useEventStream` | [useEventStream.ts](../packages/chat/client/src/client/useEventStream.ts) | SSE 钩子；事件只触发刷新，不直接渲染推送内容 |
| `presentation` | [presentation.ts](../packages/chat/client/src/presentation.ts) | 错误码→文案、投递态、流态的纯函数；UI 不二次判断 |

### 2.2 必须先补的通用组件（P0-b 第一批）

> 这些是后续所有功能的依赖，**不先补就会反复在各地手搓**。建议放在 `packages/chat/client/src/components/`。

#### 2.2.1 `Dialog`（模态对话框）

```ts
interface DialogProps {
  readonly open: boolean
  readonly title: string
  readonly onClose: () => void
  readonly role?: 'dialog' | 'alertdialog'        // 默认 dialog；确认破坏性操作用 alertdialog
  readonly size?: 'sm' | 'md' | 'lg'
  readonly closeOnOverlayClick?: boolean           // 默认 false：破坏性操作不能误关
  readonly closeOnEsc?: boolean                     // 默认 true
  readonly initialFocus?: 'first' | 'none'
  readonly children: ReactElement | readonly ReactElement[]
}
```

**硬约束**：
- Portal 渲染到 `document.body`，避开父级 `transform`/`overflow` 干扰。
- **焦点陷阱**：Tab 到末尾回到首个可聚焦元素；关闭后焦点回触发器（恢复焦点是 a11y 硬要求）。
- `aria-modal="true"`、`aria-labelledby` 指向标题、`aria-describedby` 指向正文。
- overlay 点击默认**不关闭**——撤回/删除/2FA 登记等误关会丢失上下文。
- 滚动锁定：打开时 body `overflow: hidden`，关闭恢复。

**使用场景**：撤回确认、删除确认、2FA 登记引导、RecoveryKit 展示、转发目标选择、设备撤销确认。

#### 2.2.2 `Toast`（轻量通知）

```ts
type ToastVariant = 'info' | 'success' | 'warning' | 'error'

interface ToastInput {
  readonly id: string                              // 调用方生成，便于去重/更新
  readonly variant: ToastVariant
  readonly message: string                         // 已本地化，UI 不再编文案
  readonly durationMs?: number                     // 默认 4000；error 默认 0（需手动关）
  readonly action?: { label: string; onClick: () => void }
}
```

**硬约束**：
- 容器 `role="region" aria-label="通知"`；单条 `role="status"`，error 用 `role="alert"`。
- 不得承载**影响继续操作**的信息——那些走占布局的条（U2）。Toast 只用于「操作反馈」。
- 最多同时显示 3 条，超出 FIFO 淘汰；同一 `id` 重复触发是更新而非新增。
- 自动消失的 Toast 不得包含破坏性操作的撤销入口（来不及点）；撤销走 Dialog 或独立条。

**使用场景**：「加联系人请求已发送」「已复制到剪贴板」「设备已下线」「草稿已保存」。

#### 2.2.3 `DropdownMenu`（右键/长按菜单）

```ts
interface DropdownMenuItem {
  readonly id: string
  readonly label: string
  readonly onSelect?: () => void
  readonly disabled?: boolean
  readonly danger?: boolean                        // 红字：撤回、删除
  readonly separator?: boolean                     // 仅渲染分隔线
  readonly icon?: ReactElement                     // 可选前置图标
}

interface DropdownMenuProps {
  readonly trigger: 'contextmenu' | 'click' | 'manual'
  readonly items: readonly DropdownMenuItem[]
  readonly ariaLabel?: string
  readonly onClose?: () => void
}
```

**硬约束**：
- trigger=contextmenu 时阻止默认菜单；触发点为鼠标坐标/长按坐标。
- 键盘可达：`Arrow Down/Up` 移动、`Enter` 选择、`Esc` 关闭；关闭后焦点回触发器。
- `aria-menu="menu"`、items 为 `role="menuitem"`、separator 为 `role="separator"`。
- 滚动/resize 时重新夹紧到视口；溢出时优先保留下半部分可见。

**使用场景**：消息操作（P1）、会话列表项操作（pin/mute/删除）、群成员菜单、设备列表撤销。

#### 2.2.4 其他基础设施

| 组件 | 何时需要 | 备注 |
|---|---|---|
| `Skeleton` | 所有 loading 态 | 替换现有「正在加载…」文案；按目标布局占位 |
| `EmptyState` | 所有空态 | 现有散落文案统一为组件：图标 + 标题 + 副文案 + 可选 CTA |
| `ErrorBoundary` | 路由级/抽屉级 | React 错误兜底；不暴露 stack 给用户 |
| `Avatar` | P1 头像 | 生成式（首字 + hash→色）；P1 前为 `null` 占位，不画空圆 |
| `RelativeTime` | P1 时间 | `今天 HH:MM / 昨天 / MM-DD / YYYY-MM-DD`；跨时区显时区标识（§48） |
| `VirtualList` | P1 前 | 消息列表/会话列表全量渲染，群聊/长历史会卡；用 `react-window` 或同等 |
| `FilePreview` | P1 附件 | 图片 lightbox、视频 player、文件下载卡；不可信内容同样不执行 |
| `ConfirmDialog` | P1 消息操作 | Dialog 的预设变体：title + body + confirm/cancel，danger 选项显式标 |

### 2.3 CSS 与主题

- 现状：CSS Modules，颜色硬编码，无暗色适配。
- 目标：引入 design tokens（CSS 自定义属性），在 `:root` 与 `[data-theme="dark"]` 下分别赋值；组件只引用 token，不引用具体色值。
- 优先 token：`--color-bg`、`--color-fg`、`--color-muted`、`--color-accent`、`--color-danger`、`--color-warning`、`--color-success`、`--space-*`、`--radius-*`、`--shadow-*`、`--z-*`（z-index 按文档化刻度，不写魔法值）。
- DSH 已支持暗色主题，可在 `document.documentElement.dataset.theme` 上联动。

---

## 3. 🔴 P0-b 关键 UI 规格

> P0-b 后端尚未开始，前端可先做**静态壳 + 已有 API 接通**。文档要求详见 [README §8.1](./README.md#81-当前关口p0-b下一步)。

### 3.1 账号安全分区（设置面板新分区）

**入口**：`StatusSection` 同级新增 `AccountSecuritySection`。**未登记 2FA 时只有此分区可访问**，其他设置入口锁定（§8.1-2）。

**布局**：

```text
账号安全
├── 第二因素 (2FA)
│   ├── 未登记：[登记 2FA] → Dialog
│   │   ├── 步骤 1：TOTP 二维码 + 密钥（base32）+ [我用 Authenticator 扫码] / [手动输入]
│   │   ├── 步骤 2：6 位验证码输入（自动聚焦、6 位即校验、错误清空重输）
│   │   └── 步骤 3：备用码展示（一次性、网格表格、[复制全部] + 「已妥善保存」勾选必填才能完成）
│   └── 已登记：上次使用时间 + [更换] + [撤销]（撤销需 Dialog 二次确认）
│
├── 恢复 (RecoveryKit)
│   ├── 未生成：[生成恢复包] → Dialog（守护人拆分方案展示 → 下载引导 → 「我已保存」确认）
│   ├── 已生成：生成时间 + 守护人数量 + [重新生成]（旧的失效）
│   └── 恢复入口（从其他设备登录时触发，独立流程页）
│
├── 已登记设备
│   ├── 设备列表（设备名 + 最后活跃 + 当前设备标记）
│   └── [撤销]（非当前设备可撤销；当前设备撤销需 RecoveryKit 二次确认）
│
└── 我的资料
    ├── 账号 ID（可复制，不显示内部 UUID 之外的标识）
    ├── 显示名（[编辑] → Dialog）
    └── [退出登录]（需 2FA + Dialog 二次确认；唯一所有者需先转让，见 §5.3）
```

**硬约束**：
- 备用码展示**只在登记完成时显示一次**；不提供「重新查看」入口——重新生成会使旧备用码失效。
- 备用码复制后给警告条：「已复制到剪贴板，请离线保存，关闭后无法再查看」。
- 设备列表中「当前设备」标记用图标 + 文本双信号（U5）。
- 2FA 撤销、设备撤销、RecoveryKit 重新生成均需二次确认 Dialog（破坏性操作）。

### 3.2 强制策略警告条（抽屉顶部）

**位置**：`ChatDrawer` 头部下方、Tab 上方，**占据整行布局**，不可被 toast 替代。

**触发条件**（任一即显示）：

| 条件 | 文案 | 跳转目标 |
|---|---|---|
| 未登记 2FA | 「账号未启用第二因素，需登记后才能使用全部功能」 | 账号安全 → 2FA |
| 密码强度不足 | 「账号密码强度不满足当前组织策略」 | 账号安全 → 改密 |
| 客户端版本不兼容 | 「客户端版本不被组织接受，部分功能受限」 | 升级指引页 |
| 配额接近上限（P3） | 「本月用量已达 X%，接近上限」 | 用量详情页 |

**硬约束**：
- 多条件同时存在时**叠加显示**，不合并为一句模糊话。
- `role="alert"`，`aria-live="assertive"`，进入时读屏即播报。
- 关闭按钮**可选**：策略警告默认不可关，组织治理可配置「可关闭 N 小时」。
- 未登记 2FA 时此条不可关，且抽屉内除「账号安全」外其他入口禁用（U7 + §8.1-2）。

### 3.3 `VisibilityPicker` 接通与对齐

**现状**：组件已实现并已调 `/api/chat/presence/visibility/set`（见 [VisibilityPicker.tsx#L100-L102](../packages/chat/client/src/client/VisibilityPicker.tsx#L100-L102)）。gap 分析标记的「未接通」已不成立，**改为接通策略前置条**。

**P0-b 待办**：
- 与 §3.2 警告条联动：未登记 2FA 时 VisibilityPicker 仍可读不可写（置 `disabled` + tooltip 说明）。
- 切换失败回滚逻辑已就绪（[L105-L110](../packages/chat/client/src/client/VisibilityPicker.tsx#L105-L110)），不重复实现。
- 「隐藏」档位的 hint 文案需在 P1 引入「输入中状态」后补充：「隐藏时不向对方发送输入中提示」。

### 3.4 本地搜索（会话列表上方）

**位置**：`ConversationList` 上方、Tab 下方。**与通讯录搜索是两个独立搜索**，不得共用输入框。

```text
[搜索框：搜消息或联系人名]  ← 本地搜索
─────────────────────
会话列表
```

**契约**：

```ts
interface LocalSearchProps {
  readonly query: string
  readonly onQueryChange: (next: string) => void
  readonly scope: 'messages' | 'contacts' | 'all'
  readonly placeholder?: string
}
```

**硬约束**：
- 搜索范围**仅本地缓存**：消息正文 + 联系人名；服务端搜索是 P1 独立入口。
- **撤回的消息不出现在结果中**（§14.1 + gap 分析 P0-b 行）；命中后跳转该会话并高亮该消息。
- 关键字高亮用 `<mark>`，不破坏正文文本节点结构（U4 不可信内容）。
- 输入即过滤（debounce 200ms），不要求回车；清空按钮显式可点。
- 空查询时不显示「无结果」，回到原列表；非空无结果显式「没有匹配的消息/联系人」。
- `aria-label="搜索本地消息与联系人"`，结果区 `role="listbox"`。

### 3.5 协议协商失败态页

**触发**：`PROTOCOL_VERSION_UNSUPPORTED`（§8.1-6）。

**呈现**：抽屉内容整体替换为升级提示页（**不是小 banner**）。

```text
┌──────────────────────────────────────┐
│                                      │
│        ⚠ 版本不兼容                  │
│                                      │
│  你的客户端版本（v1.x）不被          │
│  当前组织接受。                      │
│                                      │
│  需要的最低版本：v1.y                │
│  当前安装版本：v1.x                  │
│                                      │
│  [如何升级]    [稍后再说]            │
│                                      │
└──────────────────────────────────────┘
```

**硬约束**：
- 此态下**抽屉内除升级入口外全部禁用**——不可发消息、不可看历史、不可改设置。
- 版本号来源：错误响应体里的 `minRequired` / `current`（错误码目录声明）。
- 「稍后再说」关闭抽屉，但不解除禁用；下次打开仍是此态。
- 此页**不可被关闭/绕过**——协议不兼容时静默降级是 U2 违反。

### 3.6 发送失败重试接通

**现状**：[MessageView.tsx#L162](../packages/chat/client/src/client/MessageView.tsx#L162) 已渲染重试按钮，但 [ChatSection.tsx#L518-L523](../packages/chat/client/src/client/ChatSection.tsx#L518-L523) 渲染 MessageView 时**未传 `onRetry`**，按钮永不出现。

**P0-b 待办**：

```ts
// ChatSection.tsx 渲染 MessageView 处
createElement(MessageView, {
  messages: displayed,
  streamState: props.streamState ?? stream.state,
  onRetry: (messageId: string) => void retryMessage(messageId),  // ← 补这行
})
```

`retryMessage` 行为：
- 仅对 `pending` / `failed`（retryable）消息生效；`accepted` 不可重试（§5）。
- 重试复用原 `messageId` 作为幂等键（[ChatSection.tsx#L334](../packages/chat/client/src/client/ChatSection.tsx#L334) 已用 `send-${messageId}`），relay 自然去重。
- 重试中把该条状态切回 `pending`，按钮变「…」禁用。
- 终态失败（`VERSION_CONFLICT` 等）不出现重试按钮——`presentDeliveryState().offersRetry` 已判定，组件不再二次判断。

---

## 4. 🟠 P1 UI 规格

> P1 后端尚未开始；本节给出 UI 形态契约，便于前端先做壳。

### 4.1 群聊类型会话

- 会话条目新增 `kind: 'direct' | 'group'` 字段（host 聚合端点返回）。
- 视觉差异：群头像（生成式多色拼接）、群名、成员数（`N 人`）。
- 群设置入口：抽屉头部 → 群名旁齿轮 → Dialog/子页（群名编辑、成员列表、入群验证开关、退出群）。
- @提及补全：输入 `@` 弹出成员浮层（DropdownMenu 复用），↑↓ 选择、Enter/TAB 确认；输入法组字期间不弹出。
- 群事件系统消息：加入/离开/改名等用居中灰条气泡（区别于普通气泡），`role="status"`。
- 入群验证流程：被邀请人看到邀请卡片（Dialog），含邀请人、群名、成员数，[接受]/[拒绝]。

### 4.2 附件上传与预览

- Composer 旁新增附件按钮（📎）；支持文件选择器 + 拖拽 + 粘贴。
- 上传中：消息气泡内显示进度条（按字节，不按时间估算）；可取消。
- 缩略图：图片直显（带 lightbox 入口），其他类型给文件图标 + 文件名 + 大小。
- 下载入口：每个附件气泡底部 [下载] + 大小 + 过期时间（如 `2.4 MB · 7 天后过期`）。
- 撤回连带：撤回含附件的消息，附件也撤回（占位替换整个气泡）。
- 拖拽防误：拖到非 Composer 区域不触发上传；拖到 Composer 边框高亮。
- 大小/类型限制：超限在**选择时**拒绝并 toast 提示，不让用户传完再失败。

### 4.3 消息操作菜单（右键/长按）

| 项 | 可见条件 | 危险 | 备注 |
|---|---|---|---|
| 复制 | 全部 | 否 | 复制纯文本到剪贴板，toast「已复制」 |
| 编辑 | 本人 + 10 分钟内 | 否 | 改为内联编辑，Esc 取消、Enter 保存 |
| 撤回 | 本人 + 撤回窗口内 | 是（红字） | Dialog 二次确认；超窗口禁用并 tooltip |
| 引用 | 全部（非撤回） | 否 | 引用卡片插入 Composer |
| 转发 | 全部（非撤回） | 否 | 转发目标选择器（P2 才接通，P1 仅壳） |
| 回复 | 全部（非撤回） | 否 | 缩进引用 + Composer 聚焦 |
| 删除（本地） | 本人 | 是 | 仅本地不可见，不影响他人；与撤回明确区分 |
| 多选 | 全部 | 否 | 进入多选态，可批量删除/转发 |

**硬约束**：
- 菜单可见性由 host 返回的能力描述驱动（U7）；客户端不自己判「能不能撤回」。
- 撤回超窗口时**不显示该项**而非禁用——禁用会诱导用户找绕过方法。
- 删除（本地）与撤回**永远分两项**，措辞明确：「仅从我的视图移除」vs「对所有参与者撤回」。
- 编辑/撤回后引用该消息的其他消息要标「原消息已编辑/已撤回」（U3 + §14.1）。

### 4.4 工作项 UI（目前仅 API）

- 入口：抽屉 Tab 新增「工作项」，或主壳独立页（P3 设置页重构时迁移）。
- 列表：三档筛选（指派给我 / 我创建 / 全部），按状态分组或按截止时间排序。
- 详情：状态、标题、描述、指派人、截止时间（相对时间 + 跨时区显时区）、依赖关系、评审关口、评论流。
- 状态流转按钮：按钮可见性跟当前状态机可转移集合走；不可转移的状态不显示按钮（避免诱导）。
- 评审关口：到达关口时显示「待评审」标记，关口未通过时禁止推进到下一状态。
- 评论：与消息正文同渲染规则（U4 不可信内容）。

### 4.5 通知中心 UI（目前仅 API）

- 入口：抽屉头部新增铃铛图标 + 未读角标。
- 抽屉：通知收件箱独立 Tab 或独立抽屉；按类型分组（工作项 / 邀请 / 审核 / 系统）。
- 聚合显示：同一上下文的多条通知聚合为一条（如「3 条工作项评论」），点开展开。
- 全部已读：顶部按钮；不提供「全部撤销」——已读 ≠ 签收（§3.1 边界声明）。
- 跳转：点击通知跳转到对应上下文（工作项详情 / 会话 / 审核页）。
- 通知正文不包含敏感数据（§安全合规）。

### 4.6 资源库

- 新增 Tab「资源」或抽屉独立分区。
- 文件/文档列表，按项目/会话聚合；上传入口、预览（图片直显、其他图标）。
- 权限继承显示：每个文件标注「继承自：项目 X / 会话 Y」；无权限不显示该文件（不暴露存在性，U6）。
- 撤销共享 ≠ 删除（§3.1）：撤销后该文件从列表消失，但已下载的本地副本不受影响（文案明示）。

### 4.7 服务端搜索

- 独立于本地搜索（§3.4）的入口：顶部 Cmd/Ctrl+K 触发，或 Tab「搜索」。
- 结果分页、分类（消息 / 文件 / 工作项 / 成员），按相关性排序。
- 撤回的消息不出现（同本地搜索约束）。
- 结果点击跳转对应上下文。

### 4.8 其他 P1 补齐项

| 项 | 契约要点 |
|---|---|
| **头像** | 生成式（首字 + hash→色）；P1 前为占位不画空圆；上传入口在「我的资料」 |
| **相对时间** | `刚刚 / X 分钟前 / 今天 HH:MM / 昨天 / MM-DD / YYYY-MM-DD`；跨时区显时区标识（§48） |
| **会话列表聚合端点对齐** | host 补 `/conversations` 聚合后，列表新增字段：`lastMessage` 类型、`draft`、`pin`、`mute`；pin 置顶、mute 灰化 |
| **设备列表** | 「我的设备」「活跃设备」两组；远程下线按钮；新设备登录告警条（占布局） |
| **仓库绑定** | 项目设置 → 绑定 GitHub/GitLab；绑定后工作项显示关联 PR/commit |
| **历史授权** | 首次进入会话/群需授权时弹**授权卡**（非空列表），明示授权后能看什么 |

---

## 5. P2–P4 演进概览

> 此三阶段后端未启动，UI 仅给形态指引，具体契约待后端 P 准入时再补。

### 5.1 🟡 P2

| 模块 | UI 形态 |
|---|---|
| **协作会话** | 会话内选中上下文 → 发起协作 → 候选产物卡片（采纳/拒绝/编辑）→ 采纳后插入消息流；候选产物在采纳前**不进入持久消息**（§3.1 执行成功 ≠ 产物被接受） |
| **沙箱执行** | 命令执行输出流（流式追加，非静态块）+ 终止按钮 + 产物区 + 权限提示卡 |
| **群 Bot** | 群设置 → 添加/移除 Bot；Bot 消息带头像 + 「Bot」标识；Bot 权限提示占布局条 |
| **线程** | 消息下「回复 X 条」入口 → 侧滑或展开线程视图；线程独立未读计数；线程内不再开线程（防递归） |
| **转发** | 转发目标选择器（搜索联系人/群）+ 转发附言 + 转发引用样式（原消息卡片 + 转发者） |
| **表情反应** | 消息下反应条；常用表情快捷入口；hover 显示谁点了什么；不暴露未读反应（U6） |
| **草稿** | 每会话独立草稿（localStorage 或 host 存）；切换会话不丢；草稿在会话列表预览显示（带「草稿」标） |
| **SSE 实时订阅接通** | 新消息即时入列、已读回执即时更新、对方输入中状态 |
| **输入中状态** | 会话列表 + 消息区显示「XX 正在输入…」；可见性 hidden 时不发送此状态（§3.3） |

### 5.2 🟢 P3

| 模块 | UI 形态 |
|---|---|
| **团队版配额提示** | 配额接近上限时占布局预警条；超额在提交点（输入/上传）给明确拒绝文案（非报错弹窗） |
| **组织治理后台** | 成员管理（角色调整、禁用、移除）、工作区/项目 CRUD、邀请码生成与管理、审计日志浏览页 |
| **插件目录** | 独立页浏览/安装/卸载组织插件；权限申请流程（Dialog 引导） |
| **成本大屏** | 用量统计（不读私聊，硬约束）、成员/项目维度排行、时间范围选择、导出 |
| **唯一所有者转让** | 注销/离开前强制转让流程 UI；无可绕过的「跳过」 |
| **设置页重构** | 从 dsh-chat 分区独立：账号安全、通知、隐私、外观、关于 |

### 5.3 🔵 P4

| 模块 | UI 形态 |
|---|---|
| **E2EE 标识** | 会话/消息级锁图标；密钥指纹核对（扫码/数字比对）；密钥轮换提示 |
| **多组织切换** | 组织切换器（多组织身份）；跨组织会话分组 |
| **企业目录同步** | 管理员页：同步进度、冲突列表、手动触发 |
| **审计归档** | 审计查询（按人/时间/事件类型）、导出、哈希链校验状态 |
| **KMS 管理** | 密钥列表、轮换计划、HSM 状态 |
| **降级矩阵呈现** | E2EE 不支持的客户端/功能显式灰化 + 原因说明（U5：不只用灰化，配文案） |

---

## 6. 横切关注点（不绑阶段，越早补越好）

### 6.1 可达性（a11y）

> 现有组件已带 `role`/`aria-*`，但缺以下项，需在 P0-b 第一批补齐：

- **焦点环样式**：所有可聚焦元素显式 `:focus-visible` 样式，不依赖浏览器默认。
- **键盘导航**：↑↓ 选会话/消息、Enter 打开、Esc 关抽屉（已有）、Tab 顺序走查、抽屉内**焦点陷阱**。
- **抽屉焦点陷阱**：打开后焦点进抽屉首个可聚焦元素，关闭后回触发器；Tab 不逃逸到背景。
- **屏幕阅读器实测**：每批新组件用 NVDA/VoiceOver 走查，不只看 `aria-*` 是否存在。
- **颜色对比度**：按 WCAG AA 校验；状态色（绿/橙/红）在暗色下重新校准。
- **不靠颜色单独表达状态**：U5 已是硬约束，新增状态都要配文本/图标/形状冗余。

### 6.2 国际化（i18n）

- 现状：全中文硬编码，无 i18n 框架。
- 引入时机：**P0-b 第一批基础设施**。建议用轻量方案（如 `react-i18next` 或自研 message bundle），不绑定大型框架。
- 文案 key 命名：`scope.context.detail`，如 `composer.placeholder`、`dialog.confirmRevoke.title`。
- 错误文案仍走 `presentation.ts` 的 `presentError`，但改为查 i18n bundle 而非硬编码字符串。
- 时区/日期格式：`RelativeTime` 组件统一处理，跨时区显时区标识（§48）。
- 数字格式：未读数 `99+` 折叠策略保留，本地化时按目标语言数字宽度复核。

### 6.3 暗色模式

- 与 §2.3 design tokens 同步推进；不单独做「暗色适配」工单。
- 优先级：抽屉、设置面板、Dialog/Toast/DropdownMenu（基础设施先就绪）。
- 状态色（绿/橙/红）在暗色下需重新选色，保对比度 + 不刺眼。

### 6.4 加载态与骨架屏

- 现状：「正在加载…」一行文案，慢网下跳变明显。
- 目标：每个有列表/详情的面板用 `Skeleton` 占位，按目标布局占形。
- 优先级：会话列表、消息列表、通讯录、工作项列表、通知列表。
- 骨架不得显示假数据（如假名字），只显示空块。

### 6.5 Toast 通知系统

- 见 §2.2.2，作为 P0-b 第一批基础设施。
- 现有「加联系人请求已发送」「已复制」等操作无反馈，统一走 Toast。
- 发送失败仍走 Composer 内联提示（不升 toast），因为它要在失败位置给重试入口。

### 6.6 快捷键

- 现状：仅 Esc 关抽屉、Enter 发送。
- 第一批补：`Ctrl/Cmd+K` 全局搜索、`Ctrl/Cmd+N` 新会话、`↑` 编辑上一条本人消息（10 分钟内）。
- 快捷键文档：设置 → 关于 → 快捷键；不能成为隐藏功能。
- 与 IME 冲突：所有涉及 IME 的快捷键都判 `isComposing`（[Composer.tsx#L86](../packages/chat/client/src/client/Composer.tsx#L86) 已示范）。

### 6.7 虚拟滚动

- 现状：消息列表/会话列表全量渲染。
- 阈值：消息 >200 条、会话 >100 条时启用虚拟滚动。
- 实现：`react-window` 或同等；不动现有组件对外契约，只在内部替换渲染层。
- 验收：滚动不丢消息、不重复 key、SSE 推送新消息时正确插入。

### 6.8 通用预览组件

- 见 §2.2.4 `FilePreview`：图片 lightbox、视频 player、文件下载卡。
- 不可信内容同样不执行：预览组件**不渲染 HTML/脚本**，只渲染二进制解码后的图像/视频帧。
- P1 附件到位前先做图片 lightbox，其他类型 P1 一并补。

---

## 7. 落地顺序与文件落点

### 7.1 落地顺序（与 [gap 分析 §八](./ui-gap-analysis.md) 一致）

> 后端 P0-b 未开始，前端先做静态壳 + 已有 API 接通。每批内顺序可调，批之间尽量守。

**第一批（P0-b UI 壳 + 基础设施）**：

1. `components/Dialog.tsx` + `components/Toast.tsx` + `components/DropdownMenu.tsx`
2. `client/AccountSecuritySection.tsx`（2FA / Recovery / 设备 / 我的资料骨架）
3. `ChatDrawer` 顶部加强制策略警告条（`PolicyBanner.tsx`）
4. VisibilityPicker 接通策略前置条（联动 §3.2）
5. `client/LocalSearch.tsx`（本地搜索框 + 过滤逻辑）
6. ChatSection 补 `onRetry` 接通（§3.6）
7. `client/ProtocolUnsupportedPage.tsx`（协议协商失败态页）
8. design tokens 引入 + 暗色 token 定义

**第二批（体验缺陷补齐）**：

9. `components/Avatar.tsx`（生成式头像）
10. `components/RelativeTime.tsx`（相对时间）
11. 草稿保存（localStorage，每会话独立）
12. Composer 自适应高度（多行撑高）
13. 消息右键菜单：复制、编辑、撤回（接通 P1 后端后启用）
14. 通讯录补拒绝/移除联系人按钮
15. `components/Skeleton.tsx` + 各面板骨架替换

**第三批（P1 大项）**：

16. 附件上传 + 预览（`FilePreview`、Composer 附件按钮）
17. 工作项 UI（`WorkitemList`、`WorkitemDetail`）
18. 通知中心 UI（`NotificationCenter`）
19. 群聊类型会话 + @提及
20. 服务端搜索入口（与本地搜索区分）
21. 虚拟滚动接入会话/消息列表

### 7.2 文件落点约定

```text
packages/chat/client/src/
├── client/                # 现有面板组件（保持）
│   ├── AccountSecuritySection.tsx       [P0-b 新增]
│   ├── LocalSearch.tsx                  [P0-b 新增]
│   ├── PolicyBanner.tsx                 [P0-b 新增]
│   └── ProtocolUnsupportedPage.tsx      [P0-b 新增]
├── components/            # 通用组件（新建目录）
│   ├── Dialog.tsx          [P0-b 第一批]
│   ├── Dialog.module.css
│   ├── Toast.tsx           [P0-b 第一批]
│   ├── Toast.module.css
│   ├── DropdownMenu.tsx    [P0-b 第一批]
│   ├── DropdownMenu.module.css
│   ├── Avatar.tsx          [第二批]
│   ├── RelativeTime.tsx    [第二批]
│   ├── Skeleton.tsx        [第二批]
│   ├── FilePreview.tsx     [第三批]
│   └── ConfirmDialog.tsx   [第三批，Dialog 变体]
├── styles/
│   └── tokens.css          [P0-b 第一批，design tokens]
└── presentation.ts         # 现有，i18n 化时改这里
```

### 7.3 验收对照

每个 UI 工单合入前需对照本文件检查：

- [ ] 是否触达 U1–U7 任一条？是则**必须**补对应呈现（占布局条/三态分离/不可信内容处理等）。
- [ ] 是否触达授权/内容授权/出站路径？是则**必须**补拒绝用例 + 安全回归条目（与 [README §9.2](./README.md#92-每个迭代的检查清单) 同源）。
- [ ] 新增组件是否走 §2.2 通用组件而非就地手搓？是 Dialog/Toast/Menu 不得复刻。
- [ ] loading/empty/error 三态是否齐全？空态是否区分了原因？
- [ ] 错误文案是否走 `presentError`？是否未泄露存在性（U6）？
- [ ] a11y：`role`/`aria-*`/键盘可达/焦点管理是否覆盖？
- [ ] 暗色 token 是否引用而非硬编码色值？
- [ ] i18n key 是否已登记？

---

*本文档基于 [ui-gap-analysis.md](./ui-gap-analysis.md) 与 `packages/chat/client/src/client/*.tsx` 现状撰写。最后更新：2026-09-02。*
