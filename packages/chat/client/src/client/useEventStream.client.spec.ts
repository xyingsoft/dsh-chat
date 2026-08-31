/**
 * 事件流订阅测试。
 *
 * 测的是 `connectEventStream` —— 那是不依赖 React 的那一半，抽出来正是为了
 * 能在这个没有 jsdom 的仓库里直接驱动它。
 *
 * 盯的两条：**断开必须被如实报出**（§4 禁止表现为静默停止刷新），以及
 * **重连要退避**（不退避的话，一个下线一晚上的 host 会被重连打满）。
 */

import { describe, expect, it } from 'vitest'

import type { StreamState } from '../presentation.js'

import {
  BACKOFF_MS,
  STREAM_PATH,
  connectEventStream,
  type EventSourceLike,
  type StreamSignal,
} from './useEventStream.js'

/** 受测试控制的假 EventSource。 */
class FakeSource implements EventSourceLike {
  onerror: ((event: unknown) => void) | null = null
  onopen: ((event: unknown) => void) | null = null
  closed = false
  readonly #listeners = new Map<string, ((event: { data?: string }) => void)[]>()

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, data?: string): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(data === undefined ? {} : { data })
    }
  }
}

/** 手动推进的假时钟。真定时器会让退避测试变成一场等待。 */
class FakeClock {
  #pending: { fn: () => void; at: number }[] = []
  #now = 0
  #next = 1

  readonly schedule = (fn: () => void, ms: number): unknown => {
    this.#pending.push({ fn, at: this.#now + ms })
    return this.#next++
  }

  readonly cancel = (): void => {
    this.#pending = []
  }

  /** 推进到某个时刻，跑掉到期的回调。 */
  advance(ms: number): void {
    this.#now += ms
    const due = this.#pending.filter((entry) => entry.at <= this.#now)
    this.#pending = this.#pending.filter((entry) => entry.at > this.#now)
    for (const entry of due) entry.fn()
  }
}

interface Harness {
  readonly sources: FakeSource[]
  readonly signals: StreamSignal[]
  readonly states: StreamState[]
  readonly clock: FakeClock
  readonly stop: () => void
}

function harness(): Harness {
  const sources: FakeSource[] = []
  const signals: StreamSignal[] = []
  const states: StreamState[] = []
  const clock = new FakeClock()
  const stop = connectEventStream({
    onSignal: (signal) => signals.push(signal),
    onState: (state) => states.push(state),
    open: (url) => {
      const source = new FakeSource(url)
      sources.push(source)
      return source
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  return { sources, signals, states, clock, stop }
}

describe('连接', () => {
  it('打的是 host 的同源相对路径', () => {
    // §4：浏览器不直接与 relay 通信。绝对 URL 意味着它能被配到别处去
    const h = harness()
    expect(h.sources[0]?.url).toBe(STREAM_PATH)
    expect(STREAM_PATH.startsWith('/')).toBe(true)
    h.stop()
  })

  it('连上后报 connected', () => {
    const h = harness()
    h.sources[0]?.onopen?.({})
    expect(h.states).toContain('connected')
    h.stop()
  })

  it('停止时关掉连接', () => {
    // 不关的话，抽屉每开一次就多一条流，服务端看到的是一堆幽灵订阅
    const h = harness()
    h.stop()
    expect(h.sources[0]?.closed).toBe(true)
  })

  it('停止之后不再重连', () => {
    const h = harness()
    h.stop()
    h.sources[0]?.onerror?.({})
    h.clock.advance(60_000)
    expect(h.sources).toHaveLength(1)
  })
})

describe('事件转发', () => {
  it('message.accepted 带出 peerId', () => {
    const h = harness()
    h.sources[0]?.emit('message.accepted', JSON.stringify({ peerId: 'yi' }))
    expect(h.signals).toEqual([{ type: 'message.accepted', peerId: 'yi' }])
    h.stop()
  })

  it('stream.ready 不当作刷新信号', () => {
    // 它只是连接建立的确认。当作刷新的话，每次重连都会多一次全量拉取
    const h = harness()
    h.sources[0]?.emit('stream.ready', JSON.stringify({ cursor: '0' }))
    expect(h.signals).toHaveLength(0)
    expect(h.states).toContain('connected')
    h.stop()
  })

  it('data 不是 JSON 时仍然刷新，只是不带会话标识', () => {
    // 丢掉整条事件更糟：界面会停在旧数据上，而用户看不出为什么
    const h = harness()
    h.sources[0]?.emit('message.accepted', '截断了的{')
    expect(h.signals).toEqual([{ type: 'message.accepted' }])
    h.stop()
  })
})

describe('断开必须被报出来', () => {
  it('报 reconnecting 而不是静默停下', () => {
    // §4：不能表现为静默停止刷新。静默的话，用户看着一个不再更新的界面，
    // 以为没人给自己发消息
    const h = harness()
    h.sources[0]?.onerror?.({})
    expect(h.states.at(-1)).toBe('reconnecting')
    h.stop()
  })

  it('断开时先关旧连接再重建', () => {
    const h = harness()
    const first = h.sources[0]
    first?.onerror?.({})
    expect(first?.closed).toBe(true)
    h.stop()
  })
})

describe('重连退避', () => {
  it('间隔按序列逐次拉长', () => {
    const h = harness()

    h.sources[0]?.onerror?.({})
    h.clock.advance(BACKOFF_MS[0] - 1)
    expect(h.sources).toHaveLength(1)
    h.clock.advance(1)
    expect(h.sources).toHaveLength(2)

    h.sources[1]?.onerror?.({})
    // 第二档还是 1 秒的话说明退避没生效
    h.clock.advance(BACKOFF_MS[0])
    expect(h.sources).toHaveLength(2)
    h.clock.advance(BACKOFF_MS[1] - BACKOFF_MS[0])
    expect(h.sources).toHaveLength(3)
    h.stop()
  })

  it('封顶在序列最后一档，不会一直翻倍', () => {
    // 无上限的话，断久之后的一次重连要等到明天
    const h = harness()
    for (let i = 0; i < 8; i += 1) {
      h.sources.at(-1)?.onerror?.({})
      h.clock.advance(BACKOFF_MS.at(-1) as number)
    }
    expect(h.sources).toHaveLength(9)
    h.stop()
  })

  it('连上之后退避归零', () => {
    // 归零点在 onopen 而不是 onerror：一个「连上就断」的服务端会让退避
    // 永远停在第一档，等于没有退避
    const h = harness()
    h.sources[0]?.onerror?.({})
    h.clock.advance(BACKOFF_MS[0])
    h.sources[1]?.onopen?.({})
    h.sources[1]?.onerror?.({})
    h.clock.advance(BACKOFF_MS[0])
    expect(h.sources).toHaveLength(3)
    h.stop()
  })
})
