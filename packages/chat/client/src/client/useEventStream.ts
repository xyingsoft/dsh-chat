/**
 * 订阅 host 的 SSE 事件流。
 *
 * §4：「事件流断开、组织切换、权限修订变化和 `sync_diverged` 都是客户端
 * **必须显式呈现**的状态，不能表现为静默停止刷新。」所以除了转发事件，
 * 还要如实报出连接状态 —— 那个状态是给用户看的，不是内部细节。
 *
 * ## 收到事件不等于拿到数据
 *
 * SSE 是**加速而不是数据通路**：推送里只有「有新东西了」和一个会话标识，
 * 正文要走权威接口拉。所以回调不带业务数据，只是一个「该刷新了」的信号。
 * 这样断线期间漏掉的推送也不会造成数据缺失 —— 重连后刷一次即可。
 *
 * ## 连接逻辑是纯函数，hook 只是包一层
 *
 * `connectEventStream` 不依赖 React。这个仓库的客户端测试跑静态渲染
 * （没有 jsdom），hook 里的逻辑测不到 —— 抽出来就能直接驱动，而不用去
 * mock React 的 hook。
 */

import { useEffect, useRef, useState } from 'react'

import type { StreamState } from '../presentation.js'

/** 退避序列，毫秒。最后一档重复使用。 */
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const

/** `EventSource` 里实际用到的那部分。 */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void
  close(): void
  onerror: ((event: unknown) => void) | null
  onopen: ((event: unknown) => void) | null
}

/** 转发给调用方的信号。**不带业务数据** —— 见文件头。 */
export interface StreamSignal {
  readonly type: string
  readonly peerId?: string
}

export interface ConnectOptions {
  readonly onSignal: (signal: StreamSignal) => void
  readonly onState: (state: StreamState) => void
  readonly open: (url: string) => EventSourceLike
  /** 注入定时器，测试用假的。 */
  readonly schedule?: (fn: () => void, ms: number) => unknown
  readonly cancel?: (handle: unknown) => void
}

/** host 的同源端点。相对路径 —— 能配就意味着能被配到别处去（§4）。 */
export const STREAM_PATH = '/api/chat/events'

/**
 * 建立订阅并在断开时按退避重连。返回停止函数。
 *
 * 退避是自己管的，不用 `EventSource` 自带的重连：后者的间隔由服务端
 * `retry:` 或浏览器默认值决定，而且**不区分「服务端重启了」与「服务端
 * 不见了」**。上限 30 秒 —— 不设上限的话，一个下线一晚上的 host 会被
 * 重连打满；而无上限的翻倍会让断久之后的一次重连等到明天。
 */
export function connectEventStream(options: ConnectOptions): () => void {
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let disposed = false
  let attempt = 0
  let source: EventSourceLike | undefined
  let timer: unknown

  const connect = (): void => {
    if (disposed) return
    const current = options.open(STREAM_PATH)
    source = current

    current.onopen = () => {
      if (disposed) return
      // 连上了才把退避归零。在 onerror 里归零的话，一个「连上就断」的服务端
      // 会让退避永远停在第一档，等于没有退避
      attempt = 0
      options.onState('connected')
    }

    current.onerror = () => {
      if (disposed) return
      current.close()
      options.onState('reconnecting')
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000
      attempt += 1
      timer = schedule(connect, delay)
    }

    // 服务端在连接建立时先发一条 stream.ready 带游标。这里只当作「连上了」——
    // 补拉机制（§17.1）还没接。把它也当刷新信号的话，每次重连都会多一次
    // 全量拉取
    current.addEventListener('stream.ready', () => {
      if (!disposed) options.onState('connected')
    })

    current.addEventListener('message.accepted', (event) => {
      if (disposed) return
      options.onState('connected')
      let peerId: string | undefined
      try {
        peerId = (JSON.parse(event.data ?? '{}') as { peerId?: string }).peerId
      } catch {
        // 解析不了就当作一个不带会话标识的刷新信号。丢掉整条事件更糟：
        // 界面会停在旧数据上，而用户看不出为什么
        peerId = undefined
      }
      options.onSignal({ type: 'message.accepted', ...(peerId === undefined ? {} : { peerId }) })
    })
  }

  connect()

  return () => {
    disposed = true
    if (timer !== undefined) cancel(timer)
    source?.close()
  }
}

export interface EventStreamOptions {
  readonly onEvent: (signal: StreamSignal) => void
  /** 构造 EventSource。测试注入假的。 */
  readonly open?: (url: string) => EventSourceLike
  /** 关掉订阅（比如还没开户时）。 */
  readonly enabled?: boolean
}

export function useEventStream(options: EventStreamOptions): { state: StreamState } {
  const [state, setState] = useState<StreamState>('reconnecting')
  // 回调放进 ref：把它列进 useEffect 依赖会让每次父组件重渲染都重建连接，
  // 而重建连接意味着丢掉服务端的订阅并重来一遍
  const onEventRef = useRef(options.onEvent)
  onEventRef.current = options.onEvent

  const { enabled = true, open } = options

  useEffect(() => {
    if (!enabled) {
      setState('disconnected')
      return
    }
    return connectEventStream({
      onSignal: (signal) => onEventRef.current(signal),
      onState: setState,
      open: open ?? ((url) => new EventSource(url) as unknown as EventSourceLike),
    })
  }, [enabled, open])

  return { state }
}
