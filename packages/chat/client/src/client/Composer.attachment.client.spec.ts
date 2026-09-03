/**
 * 附件上传壳的呈现测试（P1 附件，纯前端壳）。
 *
 * 后端上传未实现 —— 本壳只负责「选/拖文件 → 暂存预览 → 可移除」，发送时
 * 必须如实说明能力未开通（不假装上传进度）。这里锁静态形态与大小格式化；
 * 发送门禁的交互路径在真实桌面里由人工验收。
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Composer, formatAttachmentSize, type ComposerProps } from './Composer.js'

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

describe('formatAttachmentSize', () => {
  it('按 B/KB/MB 人类可读', () => {
    expect(formatAttachmentSize(512)).toBe('512 B')
    expect(formatAttachmentSize(2048)).toBe('2 KB')
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe('5 MB')
  })
})

describe('附件壳静态形态', () => {
  it('有「添加附件」按钮且隐藏的文件选择支持多选', () => {
    const html = render()
    expect(html).toContain('aria-label="添加附件"')
    expect(html).toContain('type="file"')
    expect(html).toContain('multiple=""')
  })

  it('禁用时附件按钮一并禁用（没有会话不该能挂附件）', () => {
    const html = render({ disabled: true })
    // 发送 + 附件 + 输入框三处禁用
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
