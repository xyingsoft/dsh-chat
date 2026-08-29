/**
 * dsh-chat 客户端插件。
 *
 * §5：Web 客户端**必须**作为 DSH client 插件实现，UI 通过 `ctx.slots.register`
 * 贡献，样式用 DSH 主题 token + CSS Modules。
 *
 * ## 当前状态：组件已就绪，slot 注册暂缓
 *
 * `StatusSection` 与其样式已实现并测试，但**尚未注册到 `settings.section`**。
 *
 * 原因是类型而非能力：`settings.section` 这个 slot 键由
 * `@deepseek-ai/dsh-client-ui-settings` 声明，而该包的传递闭包是 **54 个包 /
 * 1.9 MB**（依赖整个 session/agent 栈）。为一个类型键把它拖进 vendor 不合理。
 *
 * 尝试在本地 `declare module` 补这个键也不可行：`register` 的选项类型是
 * `BaseOptions<K, EntryKey, D, H, M, N> & KindOptions<K, EntryKey, M>`，
 * 其形状由 SlotMap 条目的具体类型推导而来。本地猜一个形状可能编译通过但运行时
 * 对不上 —— 那比不注册更糟，因为失败会发生在用户的界面上而不是 CI 里。
 *
 * 接通方式有两条，取其一即可：
 *
 * 1. 上游把 slot 键的类型拆到一个轻量包中；
 * 2. 本项目改为在 DSH Desktop 的工作区内联调，直接使用其已装的 ui-settings 类型。
 *
 * 在那之前，本插件只注册不依赖外部 slot 的部分。§6 要求「可选能力必须显式显示为
 * 未安装，**不得伪装为可用**」—— 注册一个类型来路不明的 slot 正是「伪装」。
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-chat-client'

/**
 * 声明所需服务。
 *
 * `slots` 由 ui-renderer 提供；`@deepseek-ai/dsh-client-ui-settings` 在
 * `package.json` 的 `dsh.client.inject` 中声明，宿主装载它之后
 * `settings.section` 才存在。
 */
export const inject = ['slots']

export interface ClientConfig {
  readonly protocolVersion?: string
  readonly schemaVersion?: number
}

export function apply(_ctx: Context, _config: ClientConfig = {}): void {
  // 目前没有可安全注册的 slot，见文件头部说明。
  // 这个空实现是刻意的：插件仍会被装载，导出形态正确，卸载时无残留；
  // 等 slot 类型可用后在此加入 ctx.slots.inject(...) 即可，不需要改动其他部分。
}

export { StatusSection } from './StatusSection.js'
export type { CapabilityRow, CapabilityStatus, StatusSectionProps } from './StatusSection.js'
