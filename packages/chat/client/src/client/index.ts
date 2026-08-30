/**
 * dsh-chat 客户端插件。
 *
 * §5：Web 客户端**必须**作为 DSH client 插件实现，UI 通过 `ctx.slots.register`
 * 贡献，样式用 DSH 主题 token + CSS Modules。
 *
 * ## 两步式注册
 *
 * `ctx.slots.inject(key, cb)` 先等待该 slot 被其**所有者**声明，然后在回调里
 * `ctx.slots.register(options, Component)` 填入。直接 register 一个尚未声明的
 * slot 会失败 —— 这也是为什么注册要嵌套在 inject 里。
 *
 * ## 关于 ui-settings 的依赖
 *
 * `settings.section` 这个 slot 键由 `@deepseek-ai/dsh-client-ui-settings` 声明。
 * 它的**传递**依赖闭包是 54 个包 / 1.9 MB（依赖整个 session/agent 栈），但那些
 * 只在它自己的 `.d.ts` 里被引用 —— `skipLibCheck: true` 会跳过对 `.d.ts` 的类型
 * 检查，同时**仍然处理其中的模块增强**。因此只 vendor 这一个包（28.6 KB）即可
 * 拿到 slot 键的类型，不必把整个栈拖进来。
 *
 * 运行时依赖在 `package.json` 的 `dsh.client.inject` 中声明，由宿主提供。
 */

import { createElement } from 'react'

import type { Context } from '@deepseek-ai/cordis'

// slots 服务由 ui-renderer 增强到 Context 上；settings.section 这个键由
// ui-settings 增强到 SlotMap 上。两者都是类型层面的副作用导入。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 会话头部的 slot 键由 ui-conversation 声明。同样是类型层面的副作用导入
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

import { ChatDrawer } from './ChatDrawer.js'
import { ChatSection } from './ChatSection.js'
import { StatusSection, type CapabilityRow } from './StatusSection.js'

export const name = 'dsh-chat-client'

export const inject = ['slots']

/**
 * 各能力的就绪状态。
 *
 * §6 要求「可选能力**必须**显式显示为未安装或 `NOT_IMPLEMENTED`，**不得伪装为
 * 可用**」。这张表如实呈现哪些已就绪、哪些没有 —— 一个假装能用的聊天界面比
 * 没有界面更糟。
 *
 * 写在这里而不是从 host 拉取，因为它描述的是**本次构建装载了什么**，
 * 属于构建期事实而非运行期状态。
 */
const CAPABILITIES: readonly CapabilityRow[] = [
  { name: '插件装载与卸载', status: 'ready', note: '路由注册与 disposer 级联已验证' },
  { name: '错误码与状态集合', status: 'ready', note: '32 条错误码、11 组状态，与文档双向锁定' },
  { name: '本地持久化', status: 'ready', note: 'SQLite schema 与迁移，含 P0 全部必备字段' },
  { name: '授权判定', status: 'ready', note: '角色默认能力 + 作用域链合并' },
  { name: '邀请码', status: 'ready', note: '一次性消费，并发下由条件更新保证' },
  { name: '组织与成员', status: 'ready', note: '三级层次、版本控制、邀请与接受' },
  { name: '文本私聊', status: 'ready', note: '发送、租约拉取、ACK 均经 HTTP 走通' },
  { name: '工作项与通知', status: 'ready', note: '创建、分派、依赖成环、收件箱均经 HTTP 走通' },
  { name: '审计', status: 'ready', note: '仅追加，与领域写入同事务' },
  { name: '消息编辑与撤回', status: 'ready', note: '追加事件模型，撤回后显示占位' },
  { name: '设备注册与请求签名', status: 'ready', note: 'Ed25519，nonce 去重与时间偏移' },
  { name: '通知聚合与 SSE', status: 'ready', note: '5 分钟窗口，断线后按游标补拉' },
  { name: '会话列表与消息视图', status: 'ready', note: '接 host 端点，编辑与撤回如实呈现' },
  { name: '本插件被 DSH 装载', status: 'ready', note: '已在 DSH Desktop v2.0.4 上验证渲染' },
  { name: '第二验证因素与恢复', status: 'not_implemented', note: '属 P0-b 关口' },
  { name: '在线状态', status: 'not_implemented', note: '属 P0-b 关口' },
  { name: '群聊与附件', status: 'not_implemented', note: '属 P1 及之后' },
]

export interface ClientConfig {
  /** §41：单调递增整数。 */
  readonly protocolVersion?: number
  readonly schemaVersion?: number
}

export function apply(ctx: Context, config: ClientConfig = {}): void {
  // 两步式：先等 settings.section 被其所有者声明，再填入自己的分区。
  // 整个注册经 inject 的回调返回，卸载时随 fiber 级联释放（§48）。
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-chat',
            // 给一个靠后的顺序值，不抢占既有分区的位置
            order: 200,
            label: () => 'dsh-chat',
            inject: () => ({
              capabilities: CAPABILITIES,
              protocolVersion: config.protocolVersion ?? 1,
              schemaVersion: config.schemaVersion ?? 1,
            }),
          },
          StatusSection,
        ),
      ),
    'dsh-chat-client: settings section',
  )

  // 右侧抽屉：聊天的唯一入口，带输入框。
  //
  // 一度想做成「聊天」标签页（conversation.view），指望切过去就只剩一个输入框。
  // **试了，不行** —— 官方的「轨迹」标签同样保留原生输入框，view 只替换正文区，
  // 输入框由 ConversationRoot 常驻渲染，没有 opt-out。标签页里两个输入框
  // 上下紧挨着，比抽屉更糟。
  //
  // 抽屉至少把它们在空间上分开：我们的在右侧栏内，原生的在主区域左下。
  // 这不是理想解 —— 理想解是复用原生输入框，但 conversation.composer 的选择器
  // 契约要求纯函数、只读 owner props，表达不了「用户切了聊天模式」。
  // 已登记为需要上游改动的事项。
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'dsh-chat-drawer',
            order: 100,
          },
          ChatDrawerEntry,
        ),
      ),
    'dsh-chat-client: conversation drawer',
  )
}

/**
 * 抽屉入口。
 *
 * 把 `ChatSection`（真实数据）塞进 `ChatDrawer`（开合与宽度）。拆成两层是因为
 * 它们变化的原因不同：抽屉管的是「摆在哪、多宽、开没开」，内容管的是
 * 「显示什么」。混成一个组件的话，改布局要动数据逻辑，反之亦然。
 */
function ChatDrawerEntry(): ReturnType<typeof ChatDrawer> {
  // children 传函数：抽屉把当前宽度递进来，内容据此在并排与钻取之间切换。
  // 传节点的话内容拿不到宽度，只能固定一种布局。
  //
  return ChatDrawer({
    children: (width: number) => createElement(ChatSection, { width }),
  })
}

export { ChatDrawer } from './ChatDrawer.js'
export type { ChatDrawerProps } from './ChatDrawer.js'
export { StatusSection } from './StatusSection.js'
export type { CapabilityRow, CapabilityStatus, StatusSectionProps } from './StatusSection.js'
export { ChatSection } from './ChatSection.js'
export type { ChatSectionProps } from './ChatSection.js'
export { ConversationList } from './ConversationList.js'
export type { ConversationSummary, ConversationListProps } from './ConversationList.js'
export { MessageView, REVOKED_PLACEHOLDER } from './MessageView.js'
export type { DisplayMessage, MessageViewProps } from './MessageView.js'
