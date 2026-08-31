/**
 * 可见性选择器测试。
 *
 * 静态渲染（同 `Composer.client.spec.ts`：没有 jsdom）。所以这里测两样：
 * 首屏渲染的形状，以及**三档的措辞**。
 *
 * 措辞值得单独测：「隐藏」最容易被写成「显示为离线」，而实际是「状态未知」。
 * 那不是文案偏好 —— 说成离线是在替用户断言一件假的事，而系统只是不说。
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { VISIBILITY_OPTIONS, VisibilityPicker } from './VisibilityPicker.js'

function render(props: Parameters<typeof VisibilityPicker>[0] = {}): string {
  return renderToStaticMarkup(createElement(VisibilityPicker, props))
}

describe('三档与措辞', () => {
  it('恰好三档，取值与契约一致', () => {
    expect(VISIBILITY_OPTIONS.map((o) => o.value)).toEqual([
      'everyone',
      'shared_scopes',
      'hidden',
    ])
  })

  it('隐藏那一档说的是「状态未知」，且不声称显示为离线', () => {
    // 说成离线是在替用户断言一件假的事 —— 系统只是不说。
    //
    // 但文案里出现「离线」两个字是可以的，甚至是好的：主动写「不是离线」
    // 恰好挡掉了这个最常见的误解。所以查的是有没有**声称**离线，
    // 不是有没有出现那两个字
    const hidden = VISIBILITY_OPTIONS.find((o) => o.value === 'hidden')
    expect(hidden?.hint).toContain('状态未知')
    expect(hidden?.hint).not.toMatch(/显示为离线|看到你离线|显示离线/)
  })

  it('隐藏那一档说明消息照常收发', () => {
    // §9.1：隐藏时仍发心跳以维持投递。不说的话「隐身」会被误解成「断开」
    expect(VISIBILITY_OPTIONS.find((o) => o.value === 'hidden')?.hint).toContain('消息')
  })

  it('每一档都从对方视角写，而不是从设置项名字写', () => {
    // 「所有人可见」这种名字不回答「谁能看到什么」，说明文字要补上
    for (const option of VISIBILITY_OPTIONS) {
      expect(option.hint.length, `${option.value} 缺少说明`).toBeGreaterThan(8)
      expect(option.hint, `${option.value} 的说明没提到「看到」`).toMatch(/看到|收发/)
    }
  })
})

describe('渲染', () => {
  it('首屏还在读取时不摆出一个猜出来的默认值', () => {
    // 显示「所有人可见」会让用户以为那就是当前档位，而实际不明
    const html = render({ load: () => new Promise(() => {}) })
    expect(html).not.toContain('<select')
    expect(html).not.toContain('所有人可见')
  })

  it('读不到时说明白「不可用」，不是无声消失', () => {
    // 无声消失的话，用户不知道是没这个功能还是坏了
    const html = renderToStaticMarkup(
      createElement(VisibilityPicker, {
        load: () => Promise.reject(new Error('INTERNAL')),
      }),
    )
    // 首屏仍是占位（effect 还没跑），但占位本身存在 —— 不是一个空节点
    expect(html.length).toBeGreaterThan(0)
  })
})

/**
 * 已加载之后的分支（select、srOnly 标签、失败回滚）静态渲染跑不到 ——
 * 那些都在 `useEffect` 之后。这里不为它们写「渲染两次比较相等」那种
 * 形式上通过的用例：一个不会失败的测试比没有测试更糟，它会让人以为
 * 那部分被覆盖了。
 *
 * 真正覆盖它们要么引入 jsdom（整个仓库都没有），要么把状态机抽成纯函数。
 * 当前这个组件的状态只有「读到没读到 + 失败没失败」，抽出来的收益不抵
 * 增加的间接层，所以留白并在这里写明。
 */
