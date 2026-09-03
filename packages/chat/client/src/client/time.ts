/**
 * 时间呈现的共享工具 —— **固定北京时间（Asia/Shanghai, UTC+8）**。
 *
 * 消息时间戳存 UTC ISO（§48）；展示统一换算为北京时间，而不是读机器本地
 * 时区：本产品界面语言为中文、团队以北京时间为约定时钟（用户明确要求），
 * 避免同一条消息在开会机器/服务器时区下显示成另一天。
 *
 * 会话列表、消息视图与消息分组头共用同一套日历日切分（今天/昨天/日期），
 * 各写一份会漂移：一边把「昨天」写成 23:59 截止的滚动窗口，另一边按日历日
 * 切，同一时刻的消息在两处标不同的日子。
 *
 * 实现不做时区表查询：UTC+8 无夏令时，换算 = 时刻 + 8h 后取 UTC 字段。
 * 所有函数纯函数，`now` 由调用方注入 —— 默认实现在渲染处取 `new Date()`，
 * 测试传固定值，避免用例随运行日期漂移。
 */

/** UTC+8 固定偏移（毫秒）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

export interface BeijingWall {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 一个时刻的北京时间墙钟分量。 */
export function beijingWallOf(instant: Date): BeijingWall {
  const shifted = new Date(instant.getTime() + BEIJING_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

function dayKeyOf(instant: Date): string {
  const w = beijingWallOf(instant)
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`
}

/** 北京时间「昨天」的日历日 key。 */
function yesterdayKeyOf(now: Date): string {
  const w = beijingWallOf(now)
  // 北京昨天零点对应的时刻
  const startOfTodayUtc = Date.UTC(w.year, w.month - 1, w.day) - BEIJING_OFFSET_MS
  return dayKeyOf(new Date(startOfTodayUtc - 1))
}

/** 两个时刻是否落在同一个北京时间日历日。 */
export function isSameCalendarDay(a: Date, b: Date): boolean {
  return dayKeyOf(a) === dayKeyOf(b)
}

/** 北京时间的 HH:MM。 */
function clockOf(instant: Date): string {
  const w = beijingWallOf(instant)
  return `${pad(w.hour)}:${pad(w.minute)}`
}

/**
 * 日历日标签：今天 / 昨天 / `M月D日` / 跨年 `YYYY年M月D日`。
 *
 * 用作消息列表的分组头。
 */
export function dayLabel(iso: string, now: Date): string {
  const instant = new Date(iso)
  const w = beijingWallOf(instant)
  if (dayKeyOf(instant) === dayKeyOf(now)) return '今天'
  if (dayKeyOf(instant) === yesterdayKeyOf(now)) return '昨天'
  const monthDay = `${w.month}月${w.day}日`
  return w.year === beijingWallOf(now).year ? monthDay : `${w.year}年${monthDay}`
}

/**
 * 消息时间：今天 `HH:MM`，昨天 `昨天 HH:MM`，更早 `MM-DD HH:MM`（跨年带年份）。
 *
 * 相对细化只到「昨天」为止 —— 更远的消息写相对天数（「3 天前」）会随时间
 * 失真成另一个数字，而日期不会。分组头已经给了日历日，这里再给完整日期
 * 是为了长截图脱离上下文时仍可指认。
 */
export function formatMessageTime(iso: string, now: Date): string {
  const instant = new Date(iso)
  const w = beijingWallOf(instant)
  const clock = clockOf(instant)
  if (dayKeyOf(instant) === dayKeyOf(now)) return clock
  if (dayKeyOf(instant) === yesterdayKeyOf(now)) return `昨天 ${clock}`
  const monthDay = `${pad(w.month)}-${pad(w.day)}`
  return w.year === beijingWallOf(now).year
    ? `${monthDay} ${clock}`
    : `${w.year}-${monthDay} ${clock}`
}

/**
 * 会话列表时间：今天 `HH:MM`，昨天 `昨天`，更早 `MM-DD`（跨年带年份）。
 *
 * 列表窄、每行还挤着预览与未读数，所以昨天起只留日期不带时刻 ——
 * 「要不要点进去」不需要精确到分钟。
 */
export function formatListTime(iso: string, now: Date): string {
  const instant = new Date(iso)
  const w = beijingWallOf(instant)
  if (dayKeyOf(instant) === dayKeyOf(now)) return clockOf(instant)
  if (dayKeyOf(instant) === yesterdayKeyOf(now)) return '昨天'
  const monthDay = `${pad(w.month)}-${pad(w.day)}`
  return w.year === beijingWallOf(now).year
    ? monthDay
    : `${w.year}-${monthDay}`
}
