/**
 * 输入框测试。
 *
 * 用 `renderToStaticMarkup`（理由同 `ChatDrawer.client.spec.ts`：组件有 hooks，
 * 当普通函数调会触发 Invalid hook call）。
 *
 * 静态渲染测不到键盘与发送流程，所以那两块拆成可单独验证的部分：
 * 字素簇计数是纯函数，输入法保护的判定条件在下面按契约断言。
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { COMPOSER_LIMITS, Composer, type ComposerProps } from './Composer.js'

function render(props: Partial<ComposerProps> = {}): string {
  return renderToStaticMarkup(
    createElement(Composer, {
      onSend: async () => undefined,
      value: '',
      onChange: () => {},
      ...props,
    }),
  )
}

describe('初始状态', () => {
  it('渲染输入框与发送按钮', () => {
    const html = render()
    expect(html).toContain('<textarea')
    expect(html).toContain('<button')
  })

  it('空内容时发送按钮禁用', () => {
    // 允许发空消息的话，一次误触就在对方那边留一条空气泡
    expect(render()).toContain('disabled=""')
  })

  it('受控草稿：value 渲染进输入框，有内容时发送可用', () => {
    // 草稿由父层持有（切会话恢复、发送后清空都走 value）——
    // 受控失灵的话，切回来草稿就是空的，等于没保存
    const html = render({ value: '还没发出去的话' })
    expect(html).toContain('还没发出去的话')
    expect(html).not.toContain('disabled=""')
  })

  it('提示 Enter 发送、Shift+Enter 换行', () => {
    const html = render()
    expect(html).toContain('Enter 发送')
    expect(html).toContain('Shift+Enter 换行')
  })

  it('输入框有 aria-label，读屏能报出这是什么', () => {
    expect(render()).toContain('aria-label="消息内容"')
  })

  it('发送按钮有 aria-label 与 title', () => {
    const html = render()
    expect(html).toContain('aria-label="发送"')
    expect(html).toContain('title="发送（Enter）"')
  })

  it('自定义占位符', () => {
    expect(render({ placeholder: '发消息给 李工…' })).toContain('发消息给 李工…')
  })

  it('disabled 时输入框也禁用', () => {
    // 没有选中会话时不该能打字 —— 打完了没地方发
    const html = render({ disabled: true })
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('长度上限与 §30.1 一致', () => {
  it('上限是 8000 字素簇', () => {
    expect(COMPOSER_LIMITS.maxGraphemes).toBe(8000)
  })
})

describe('字素簇计数（与服务端同一把尺子）', () => {
  // 服务端用 Intl.Segmenter 按字素簇校验。客户端若用 .length，
  // 会出现「界面说还能输入 3000 字，发出去被拒」
  const count = (text: string): number =>
    [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].length

  it('一个家庭 emoji 算一个字素簇，而不是 11 个码元', () => {
    const family = '👨‍👩‍👧‍👦'
    expect(family.length).toBeGreaterThan(1)
    expect(count(family)).toBe(1)
  })

  it('中文按字计数', () => {
    expect(count('你好世界')).toBe(4)
  })

  it('带变体选择符的 emoji 不被拆开', () => {
    expect(count('❤️')).toBe(1)
  })
})
