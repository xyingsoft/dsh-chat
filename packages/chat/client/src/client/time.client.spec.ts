/**
 * 时间呈现工具测试。
 *
 * 这些函数决定「今天/昨天/日期」的切分 —— 消息视图的分组头、消息时间、
 * 会话列表时间三处共用（time.ts 的存在理由就是防三处漂移）。
 *
 * `now` 全部注入固定值：用例不随运行日期漂移。日期用本地构造 ——
 * 「今天」是看的人的本地日历日（time.ts 的语义），测试机在哪个时区
 * 断言都成立。
 */

import { describe, expect, it } from 'vitest'

import { dayLabel, formatListTime, formatMessageTime, isSameCalendarDay } from './time.js'

/** 本地日期构造。月按日常写法（1-12），内部换算 Date 的 0 基。 */
function at(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month - 1, day, hour, minute)
}

/** now 固定在 2026-09-02 12:00（本地）。所有相对判断以它为基准。 */
const NOW = at(2026, 9, 2, 12, 0)

describe('isSameCalendarDay：本地日历日切分', () => {
  it('同一天的不同时刻是同一天', () => {
    expect(isSameCalendarDay(at(2026, 9, 2, 0, 0), at(2026, 9, 2, 23, 59))).toBe(true)
  })

  it('午夜前后是两天', () => {
    // 滚动 24 小时窗口会把 23:59 与次日 00:00 算作「24 小时内的同一批」，
    // 但用户的语言里那就是两天
    expect(isSameCalendarDay(at(2026, 9, 1, 23, 59), at(2026, 9, 2, 0, 0))).toBe(false)
  })

  it('月末与下月 1 日是两天', () => {
    expect(isSameCalendarDay(at(2026, 8, 31, 10, 0), at(2026, 9, 1, 10, 0))).toBe(false)
  })

  it('年末与次年 1 月 1 日是两天', () => {
    expect(isSameCalendarDay(at(2025, 12, 31, 22, 0), at(2026, 1, 1, 8, 0))).toBe(false)
  })
})

describe('dayLabel：分组头', () => {
  it('今天', () => {
    expect(dayLabel(at(2026, 9, 2, 9, 5).toISOString(), NOW)).toBe('今天')
  })

  it('昨天', () => {
    expect(dayLabel(at(2026, 9, 1, 23, 59).toISOString(), NOW)).toBe('昨天')
  })

  it('今年更早：M月D日（不补零）', () => {
    expect(dayLabel(at(2026, 4, 15, 8, 0).toISOString(), NOW)).toBe('4月15日')
  })

  it('跨年：带年份', () => {
    expect(dayLabel(at(2025, 12, 31, 22, 0).toISOString(), NOW)).toBe('2025年12月31日')
  })
})

describe('formatMessageTime：消息时间', () => {
  it('今天只有 HH:MM（分组头已给出日子）', () => {
    expect(formatMessageTime(at(2026, 9, 2, 9, 5).toISOString(), NOW)).toBe('09:05')
  })

  it('昨天带「昨天」前缀', () => {
    expect(formatMessageTime(at(2026, 9, 1, 23, 59).toISOString(), NOW)).toBe('昨天 23:59')
  })

  it('更早：MM-DD HH:MM', () => {
    expect(formatMessageTime(at(2026, 4, 15, 8, 0).toISOString(), NOW)).toBe('04-15 08:00')
  })

  it('跨年：带年份', () => {
    expect(formatMessageTime(at(2025, 12, 31, 22, 0).toISOString(), NOW)).toBe(
      '2025-12-31 22:00',
    )
  })
})

describe('formatListTime：会话列表时间', () => {
  it('今天 HH:MM', () => {
    expect(formatListTime(at(2026, 9, 2, 9, 5).toISOString(), NOW)).toBe('09:05')
  })

  it('昨天起只留日期不带时刻', () => {
    // 列表窄，还要挤预览与未读数 —— 「要不要点进去」不需要精确到分钟
    expect(formatListTime(at(2026, 9, 1, 23, 59).toISOString(), NOW)).toBe('昨天')
  })

  it('更早：MM-DD', () => {
    expect(formatListTime(at(2026, 4, 15, 8, 0).toISOString(), NOW)).toBe('04-15')
  })

  it('跨年：带年份', () => {
    expect(formatListTime(at(2025, 12, 31, 22, 0).toISOString(), NOW)).toBe('2025-12-31')
  })
})
