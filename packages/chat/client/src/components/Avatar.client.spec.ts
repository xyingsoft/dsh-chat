/**
 * Avatar 生成式头像的纯函数单测。
 *
 * 锁住的契约：取名字首字大写、同名同色（hash 稳定）、空名渲染占位不崩、
 * 语义（aria-label）随 title/名字。
 */

import { describe, expect, it } from 'vitest'

import { Avatar } from './Avatar.js'
import { textOf, walk, findByClass } from '../client/element-tree.js'

describe('Avatar', () => {
  it('取名字的首个字符并大写', () => {
    expect(textOf(Avatar({ name: 'alice' }))).toBe('A')
    expect(textOf(Avatar({ name: '周培智' }))).toBe('周')
  })

  it('同一名字的颜色稳定（hash 派生）', () => {
    const a = walk(Avatar({ name: '李雷' }))[0]!
    const b = walk(Avatar({ name: '李雷' }))[0]!
    expect(a.props['style']).toEqual(b.props['style'])
  })

  it('不同名字通常给出不同色相', () => {
    const styleOf = (name: string): string =>
      String(
        (walk(Avatar({ name }))[0]!.props['style'] as Record<string, string>)[
          '--dsh-chat-avatar-hue'
        ],
      )
    const hues = new Set(['甲', '乙', '丙', '丁', '戊'].map(styleOf))
    expect(hues.size).toBeGreaterThan(1)
  })

  it('空名字渲染占位而不抛错，且不可被读屏读出', () => {
    const tree = Avatar({ name: '  ' })
    expect(textOf(tree)).toBe('?')
    const node = walk(tree)[0]!
    expect(node.props['aria-hidden']).toBe(true)
  })

  it('提供 title 时读屏可感知（否则视为装饰）', () => {
    const tree = Avatar({ name: 'alice', title: 'alice 的头像' })
    expect(findByClass(tree, 'avatar')).toHaveLength(1)
    expect(walk(tree)[0]!.props['aria-label']).toBe('alice 的头像')
  })
})
