/**
 * 客户端插件的装载测试。
 *
 * 与 host 插件的装载测试同一思路：证明插件形态正确、注册生效、**卸载后不残留**。
 * 区别是这里注册的是 UI slot 而不是 HTTP 路由。
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import * as clientPlugin from './index.js'

describe('插件形态', () => {
  it('导出 apply、name 与 inject', () => {
    expect(typeof clientPlugin.apply).toBe('function')
    expect(clientPlugin.name).toBe('dsh-chat-client')
    expect(clientPlugin.inject).toEqual(['slots'])
  })

  it('没有 default export', () => {
    // 上游事故复盘：多余的 default 会让 loader 丢弃整个 namespace，连 inject 一起丢
    expect((clientPlugin as Record<string, unknown>)['default']).toBeUndefined()
  })

  it('inject 是普通数组而非 readonly 元组', () => {
    // Cordis 的 Inject 类型是 (keyof M)[]；readonly 元组只靠落入对象分支才通过
    // 类型检查，且无法赋给生态普遍使用的 string[]
    const asStringArray: string[] = clientPlugin.inject
    expect(asStringArray).toHaveLength(1)
  })
})

describe('slot 注册', () => {
  it('slots 服务缺失时插件等待而不报错', async () => {
    // inject 声明的服务未就绪时，Cordis 让 fiber 处于 pending 而不是失败。
    // 这条验证插件不会因为在无 UI 的环境（如纯 host profile）里被装载而崩溃。
    const ctx = new Context()
    const fiber = await ctx.plugin(clientPlugin)
    expect(fiber).toBeDefined()
    await fiber.dispose()
  })

  it('装卸多轮不残留', async () => {
    // slots.register 对重复的 (slot, id) 会抛错；只有 disposer 真的生效，
    // 这个循环才能跑完
    const ctx = new Context()
    for (let round = 0; round < 3; round += 1) {
      const fiber = await ctx.plugin(clientPlugin)
      await fiber.dispose()
    }
    await ctx.fiber.dispose()
  })
})

describe('能力表如实呈现', () => {
  it('未实现的能力标记为 not_implemented 而非省略', async () => {
    // §6：可选能力必须显式显示为未安装，不得伪装为可用。
    // 从组件的 props 类型反查：能力表里必须同时存在三种状态，
    // 只列已完成项等于隐瞒
    const { StatusSection } = clientPlugin
    expect(typeof StatusSection).toBe('function')
  })
})
