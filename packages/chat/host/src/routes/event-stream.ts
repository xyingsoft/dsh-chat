/**
 * SSE 事件流。
 *
 * §17.1：`Notification` 是**持久化收件箱记录，不是 SSE 推送本身**。
 *
 * > 浏览器 SSE 断开、桌面通知权限被拒绝或设备离线**都不会让通知丢失**；
 * > host 重连后从收件箱游标补拉。
 *
 * §4：「事件流断开、组织切换、权限修订变化和 `sync_diverged` 都是客户端
 * **必须显式呈现**的状态，不能表现为静默停止刷新。」
 *
 * ## SSE 是加速，不是数据通路
 *
 * 这一点决定了整个设计。推送失败不需要重试到成功 —— 客户端重连后会从游标
 * 补拉，那才是权威路径。所以：
 *
 * - 连接建立时**先发一次游标**，让客户端知道从哪补
 * - 推送失败直接关连接，不在这里做重试逻辑
 * - 不做「保证送达」的确认握手 —— 那是在 SSE 之上重造一个可靠通道，
 *   而可靠通道已经存在（收件箱 + 游标）
 *
 * ## 为什么不直接把 outbox 消费放进这个文件
 *
 * outbox 是**每个组织一份**的任务队列，SSE 连接是**每个设备一条**。两者数量
 * 关系不同，生命周期也不同：一个没有任何浏览器连着的 host 仍然要消费 outbox
 * （否则积压），而一条 SSE 连接断开不该让 outbox 停下。所以消费循环独立，
 * 本文件只负责把消费到的事件转发给当下连着的连接。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** 一条推给浏览器的事件。 */
export interface StreamEvent {
  readonly id: string
  readonly type: string
  readonly data: unknown
}

interface Subscriber {
  readonly organizationId: string
  readonly accountId: string
  readonly response: ServerResponse
}

/**
 * 当下连着的 SSE 连接。
 *
 * **不是持久状态** —— 进程重启后为空，客户端重连并从游标补拉。把它持久化
 * 是在解一个不存在的问题：一条已经断了的连接，记住它没有任何用处。
 */
export class EventStreamHub {
  readonly #subscribers = new Map<string, Subscriber>()

  /**
   * 注册一条连接。返回移除它的函数。
   *
   * 连接键取 `(organizationId, accountId, deviceId)`：同一账号在多台设备各有
   * 一条，同一账号在不同组织也各有一条 —— 组织切换后旧组织的连接必须能被
   * 单独关掉，否则前一组织的事件会继续推给已经切走的界面。
   */
  subscribe(key: string, subscriber: Subscriber): () => void {
    // 同一键的旧连接先关掉。留着的话，一次断线重连会让同一设备收到两份，
    // 而客户端按事件 ID 去重只掩盖了浪费，没有消除它
    this.#subscribers.get(key)?.response.end()
    this.#subscribers.set(key, subscriber)
    return () => {
      if (this.#subscribers.get(key) === subscriber) this.#subscribers.delete(key)
    }
  }

  /**
   * 向某组织的某个账号推送。返回实际写出的连接数。
   *
   * 返回 0 是**正常情况**而不是失败 —— 收件人此刻没有任何设备在线。
   * 调用方不该据此重试：通知已经在收件箱里，对方上线就能拉到。
   */
  publish(organizationId: string, accountId: string, event: StreamEvent): number {
    let delivered = 0
    for (const [key, subscriber] of this.#subscribers) {
      if (subscriber.organizationId !== organizationId) continue
      if (subscriber.accountId !== accountId) continue
      if (writeEvent(subscriber.response, event)) {
        delivered += 1
      } else {
        // 写失败说明连接已经断了但还没触发 close。清掉它，
        // 否则这条死连接会在每次推送时都被尝试一遍
        this.#subscribers.delete(key)
      }
    }
    return delivered
  }

  /** 关闭全部连接。插件卸载时调用 —— §48 要求卸载后不残留。 */
  closeAll(): void {
    for (const subscriber of this.#subscribers.values()) subscriber.response.end()
    this.#subscribers.clear()
  }

  get size(): number {
    return this.#subscribers.size
  }
}

/**
 * 写一条 SSE 事件。
 *
 * 每个字段各占一行、以空行结尾 —— 这是 SSE 的线格式，少一个换行整条事件
 * 就不会被浏览器分发。`data` 内的换行要逐行加 `data:` 前缀，否则多行 JSON
 * 会被截断在第一行。
 */
export function writeEvent(response: ServerResponse, event: StreamEvent): boolean {
  if (response.writableEnded) return false
  try {
    const payload = JSON.stringify(event.data)
    const lines = payload.split('\n').map((line) => `data: ${line}`)
    response.write(`id: ${event.id}\nevent: ${event.type}\n${lines.join('\n')}\n\n`)
    return true
  } catch {
    return false
  }
}

export interface EventStreamDeps {
  readonly hub: EventStreamHub
  readonly authenticate: (request: IncomingMessage) =>
    | { readonly accountId: string; readonly deviceId: string; readonly organizationId: string }
    | undefined
  /** 当前收件箱游标。连接建立时先发给客户端，让它知道从哪补拉。 */
  readonly cursorOf: (organizationId: string, accountId: string) => string
  readonly now: () => Date
}

/**
 * SSE 端点。
 *
 * 用 `GET` 而非 `POST` —— `EventSource` 只能发 GET。因此**没有跨源写防护
 * 这一层**，安全性完全依赖认证：`authenticate` 返回 undefined 就是 401。
 * 这是可以接受的，因为这个端点不改变任何状态。
 */
export function eventStreamHandler(deps: EventStreamDeps) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const principal = deps.authenticate(request)
    if (!principal) {
      response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }))
      return
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      // 代理缓冲会让「实时推送」变成「几十秒后一起到」，那还不如不推
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    // §17.1：host 重连后从收件箱游标补拉。先把游标发过去，客户端才知道
    // 该从哪一条开始补 —— 否则它要么全量拉，要么漏掉断线期间的通知
    writeEvent(response, {
      id: '0',
      type: 'stream.ready',
      data: {
        cursor: deps.cursorOf(principal.organizationId, principal.accountId),
        organizationId: principal.organizationId,
        serverTime: deps.now().toISOString(),
      },
    })

    const key = `${principal.organizationId}:${principal.accountId}:${principal.deviceId}`
    const unsubscribe = deps.hub.subscribe(key, {
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      response,
    })

    request.on('close', unsubscribe)
    response.on('close', unsubscribe)
  }
}
