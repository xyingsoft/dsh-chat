/**
 * RelativeTime / formatRelativeTime 的纯函数单测。
 *
 * 相对时间的判定规则属于「客户端会撒谎」的高危区（跨时区/午夜边界），
 * 所以单独锁住：`刚刚 / X 分钟前 / 今天 HH:MM / 昨天 / MM-DD / YYYY-MM-DD`。
 */

import { describe, expect, it } from 'vitest'

import { formatRelativeTime, RelativeTime } from './RelativeTime.js'
import { textOf } from '../client/element-tree.js'

const NOW = new Date('2026-09-02T15:00:00+08:00')

describe('formatRelativeTime', () => {
  it('60 秒内显示「刚刚」', () => {
    const iso = new Date(NOW.getTime() - 30_000).toISOString()
    expect(formatRelativeTime(iso, NOW)).toBe('刚刚')
  })

  it('一小时内显示「X 分钟前」', () => {
    const iso = new Date(NOW.getTime() - 5 * 60_000).toISOString()
    expect(formatRelativeTime(iso, NOW)).toBe('5 分钟前')
  })

  it('当天显示「今天 HH:MM」', () => {
    expect(formatRelativeTime('2026-09-02T08:09:00+08:00', NOW)).toContain('今天 08:09')
  })

  it('昨天显示「昨天」', () => {
    expect(formatRelativeTime('2026-09-01T23:00:00+08:00', NOW)).toBe('昨天')
  })

  it('今年内显示「MM-DD」', () => {
    expect(formatRelativeTime('2026-03-05T10:00:00+08:00', NOW)).toBe('03-05')
  })

  it('跨年显示「YYYY-MM-DD」', () => {
    expect(formatRelativeTime('2025-12-31T10:00:00+08:00', NOW)).toBe('2025-12-31')
  })

  it('非法输入返回空串而不是抛错', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('')
  })
})

describe('RelativeTime 组件', () => {
  it('渲染相对时间并带绝对时间的 title', () => {
    const tree = RelativeTime({ value: '2026-09-02T08:09:00+08:00' })
    expect(textOf(tree)).toContain('今天 08:09')
    expect(tree.props).toHaveProperty('title')
  })

  it('非法输入渲染 null', () => {
    expect(RelativeTime({ value: 'bad' })).toBeNull()
  })
})
