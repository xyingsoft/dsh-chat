/**
 * 右侧聊天抽屉测试。
 *
 * 抽屉是**交互**组件，所以测的是交互契约：开关能不能被读屏理解、
 * 收起时还能不能看出有新消息、宽度会不会被拖到不可用。
 *
 * ## 为什么这个文件用 renderToStaticMarkup
 *
 * 其余组件是纯函数，直接调用就能拿到元素树（见 `element-tree.ts`）。抽屉不行 ——
 * 它用 hooks，当普通函数调会触发 "Invalid hook call"。
 *
 * `react-dom` 已经是依赖（宿主在 `PLATFORM_MODULES` 里提供它，打包时保持
 * external），所以用它的 server 渲染器拿静态 HTML 来断言，比为一个组件引入
 * 测试库便宜。断言 a11y 属性时 HTML 反而比元素树直观。
 *
 * Node 里没有 `document`，所以 portal 那半段不会渲染 —— 这正好覆盖了
 * 「无 DOM 环境不炸」这条，抽屉真实展开后的样子由 DSH 上的截图验证。
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ChatDrawer, DRAWER_WIDTH_BOUNDS, type ChatDrawerProps } from './ChatDrawer.js'

const child = createElement('p', null, '抽屉内容')

function render(props: Partial<ChatDrawerProps> = {}): string {
  return renderToStaticMarkup(createElement(ChatDrawer, { children: child, ...props }))
}

describe('触发按钮', () => {
  it('默认收起，只渲染按钮', () => {
    const html = render()
    expect(html).toContain('<button')
    // 收起时不渲染内容 —— 渲染了就意味着每次会话页加载都白拉一次数据
    expect(html).not.toContain('抽屉内容')
  })

  it('开关状态对读屏可见', () => {
    // 没有 aria-expanded 的开关，读屏用户只能听到「聊天 按钮」，
    // 不知道点下去是开还是关
    const html = render()
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-controls="dsh-chat-drawer"')
  })

  it('收起时仍显示未读数', () => {
    // 面板一收起来就与消息失联的话，用户只能一直开着 ——
    // 那「可收起」就没有意义了
    const html = render({ unreadCount: 7 })
    expect(html).toContain('>7<')
    expect(html).toContain('aria-label="7 条未读"')
  })

  it('未读为 0 时不显示角标', () => {
    expect(render({ unreadCount: 0 })).not.toContain('条未读')
  })

  it('超过 99 折成 99+，但读屏报真实数字', () => {
    const html = render({ unreadCount: 250 })
    expect(html).toContain('99+')
    expect(html).toContain('aria-label="250 条未读"')
  })

  it('title 提示当前动作是展开还是收起', () => {
    expect(render({ label: '团队聊天' })).toContain('title="展开团队聊天"')
  })

  it('自定义标签出现在按钮上', () => {
    expect(render({ label: '团队聊天' })).toContain('团队聊天')
  })
})

describe('宽度边界', () => {
  it('上下限是可用的区间', () => {
    // 太窄会话列表挤成一条，太宽把 AI 对话逼到角落
    expect(DRAWER_WIDTH_BOUNDS.min).toBeGreaterThanOrEqual(240)
    expect(DRAWER_WIDTH_BOUNDS.max).toBeLessThanOrEqual(900)
    expect(DRAWER_WIDTH_BOUNDS.default).toBeGreaterThan(DRAWER_WIDTH_BOUNDS.min)
    expect(DRAWER_WIDTH_BOUNDS.default).toBeLessThan(DRAWER_WIDTH_BOUNDS.max)
  })
})

describe('降级', () => {
  it('没有 document 时只渲染按钮而不抛', () => {
    // 插件可能被装进无 DOM 的环境（纯 host profile、SSR 预渲染）。
    // 那时抽屉不该把整棵树带崩
    expect(() => render()).not.toThrow()
  })

  it('localStorage 不可用时用默认值而不是崩溃', () => {
    // 隐私模式或被策略禁用时 localStorage 会抛。
    // 一个存不下的宽度偏好不该让面板消失
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('localStorage 被禁用')
      },
    })
    try {
      expect(() => render()).not.toThrow()
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })
})
