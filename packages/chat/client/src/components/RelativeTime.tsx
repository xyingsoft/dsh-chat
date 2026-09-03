/**
 * 相对时间文本（固定北京时间，与 client/time.ts 同一套 UTC+8 语义）。
 *
 * ui-design.md §4.8 契约：
 * `刚刚 / X 分钟前 / 今天 HH:MM / 昨天 / MM-DD / YYYY-MM-DD`。
 * 时间戳存 UTC ISO，展示统一按北京时间换算；原始绝对时间放 `title`，悬停可见。
 */

import { createElement, type ReactElement } from 'react'

/** UTC+8 固定偏移（毫秒）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function beijingParts(instant: Date): { y: number; mo: number; d: number; h: number; mi: number } {
  const shifted = new Date(instant.getTime() + BEIJING_OFFSET_MS)
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    mi: shifted.getUTCMinutes(),
  }
}

function dayKey(parts: { y: number; mo: number; d: number }): string {
  return `${parts.y}-${pad2(parts.mo)}-${pad2(parts.d)}`
}

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return ''
  const nowParts = beijingParts(now)
  const parts = beijingParts(time)
  const diffMs = now.getTime() - time.getTime()
  const minutes = Math.floor(diffMs / 60_000)

  // 北京日历日差：今天/昨天
  const nowKey = dayKey(nowParts)
  const key = dayKey(parts)
  let dayDiff = 0
  if (key !== nowKey) {
    const nowDayStartUtc = Date.UTC(nowParts.y, nowParts.mo - 1, nowParts.d) - BEIJING_OFFSET_MS
    const thatDayStartUtc = Date.UTC(parts.y, parts.mo - 1, parts.d) - BEIJING_OFFSET_MS
    dayDiff = Math.round((nowDayStartUtc - thatDayStartUtc) / 86_400_000)
  }

  if (diffMs < 60_000 && minutes === 0) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (dayDiff === 0) return `今天 ${pad2(parts.h)}:${pad2(parts.mi)}`
  if (dayDiff === 1) return '昨天'
  if (parts.y === nowParts.y) {
    return `${pad2(parts.mo)}-${pad2(parts.d)}`
  }
  return `${parts.y}-${pad2(parts.mo)}-${pad2(parts.d)}`
}

export function RelativeTime({ value }: { readonly value: string }): ReactElement | null {
  const text = formatRelativeTime(value)
  if (text === '') return null
  const parts = beijingParts(new Date(value))
  const absolute = `${parts.y}-${pad2(parts.mo)}-${pad2(parts.d)} ${pad2(parts.h)}:${pad2(parts.mi)}（北京时间）`
  return createElement(
    'time',
    { dateTime: value, title: absolute, className: undefined },
    text,
  )
}
