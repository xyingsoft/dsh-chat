/**
 * 时间呈现的共享工具。
 *
 * 抽出来是因为消息视图与会话列表要用**同一套日历日语义**（今天/昨天/日期），
 * 各写一份会漂移：一边把「昨天」写成 23:59 截止的滚动窗口，另一边按本地日历
 * 日切，同一时刻的消息在两处标不同的日子。
 *
 * ## 为什么按本地日历日而不是滚动 24 小时
 *
 * 「昨天」在用户语言里是日历概念 —— 今天早上收到的消息，下午看仍是「今天」，
 * 而滚动窗口会在几小时后把它变成「昨天」之外的更早日期。消息时间戳存 UTC
 * ISO（§48），换算成哪一天由**看的人的时区**决定，这也是聊天产品的通行语义。
 *
 * 所有函数都是纯函数，`now` 由调用方注入 —— 默认实现在渲染处取 `new Date()`，
 * 测试传固定值，避免用例随运行日期漂移。
 */

/** 两个时刻是否落在同一个本地日历日。 */
export function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function yesterdayOf(now: Date): Date {
  const d = new Date(now)
  d.setDate(d.getDate() - 1)
  return d
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 当天的 HH:MM。 */
function clockOf(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 日历日标签：今天 / 昨天 / `M月D日` / 跨年 `YYYY年M月D日`。
 *
 * 用作消息列表的分组头。
 */
export function dayLabel(iso: string, now: Date): string {
  const date = new Date(iso)
  if (isSameCalendarDay(date, now)) return '今天'
  if (isSameCalendarDay(date, yesterdayOf(now))) return '昨天'
  const sameYear = date.getFullYear() === now.getFullYear()
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`
  return sameYear ? monthDay : `${date.getFullYear()}年${monthDay}`
}

/**
 * 消息时间：今天 `HH:MM`，昨天 `昨天 HH:MM`，更早 `MM-DD HH:MM`（跨年带年份）。
 *
 * 相对细化只到「昨天」为止 —— 更远的消息写相对天数（「3 天前」）会随时间
 * 失真成另一个数字，而日期不会。分组头已经给了日历日，这里再给完整日期
 * 是为了长截图脱离上下文时仍可指认。
 */
export function formatMessageTime(iso: string, now: Date): string {
  const date = new Date(iso)
  const clock = clockOf(date)
  if (isSameCalendarDay(date, now)) return clock
  if (isSameCalendarDay(date, yesterdayOf(now))) return `昨天 ${clock}`
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return date.getFullYear() === now.getFullYear()
    ? `${monthDay} ${clock}`
    : `${date.getFullYear()}-${monthDay} ${clock}`
}

/**
 * 会话列表时间：今天 `HH:MM`，昨天 `昨天`，更早 `MM-DD`（跨年带年份）。
 *
 * 列表窄、每行还挤着预览与未读数，所以昨天起只留日期不带时刻 ——
 * 「要不要点进去」不需要精确到分钟。
 */
export function formatListTime(iso: string, now: Date): string {
  const date = new Date(iso)
  if (isSameCalendarDay(date, now)) return clockOf(date)
  if (isSameCalendarDay(date, yesterdayOf(now))) return '昨天'
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return date.getFullYear() === now.getFullYear()
    ? monthDay
    : `${date.getFullYear()}-${monthDay}`
}
