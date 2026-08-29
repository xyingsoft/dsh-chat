/**
 * 客户端的呈现约定。
 *
 * §5 对客户端的约束大多是**禁止事项**，而禁止事项很难靠代码结构表达。
 * 这里把其中三条可判定的做成纯函数，让它们能被测试锁住：
 *
 * 1. 离线三态**绝不可混淆**：「本地已保存待发送」「服务器已接收」「终态失败」。
 * 2. 错误按**可重试性分级**呈现，`terminal` **不提供重试按钮**。
 * 3. **不得**把 `NOT_FOUND_OR_FORBIDDEN` 渲染成「对象不存在」这类推断性描述。
 *
 * 这些是纯函数而不是组件内的 if —— §48 要求判定可测试，而组件里的分支很难
 * 单独验证。
 */

import { ERROR_CATALOGUE, type ErrorCode, type Retryability } from '@dsh-chat/contract'

/**
 * 消息的本地投递态。
 *
 * §5：「本地已保存待发送」「服务器已接收」「终态失败」三态**绝不可混淆**。
 *
 * 特别注意 `accepted` 的语义边界 —— §28 第 4 步：发送方 host 把记录改为
 * `accepted` 后**不能声称消息已送达或已读**。因此这里没有 `delivered` 或
 * `read` 状态，那需要接收方的信息，而 P0 不做已读回执（§15 明确「不做」）。
 */
export const LOCAL_DELIVERY_STATES = ['pending', 'accepted', 'failed'] as const
export type LocalDeliveryState = (typeof LOCAL_DELIVERY_STATES)[number]

/** 三态各自的呈现要求。 */
export interface DeliveryPresentation {
  readonly label: string
  /** 是否可以呈现为「已送达」。三态中没有任何一个可以 —— 这是断言而非配置。 */
  readonly claimsDelivered: false
  /** 是否提供重试入口。 */
  readonly offersRetry: boolean
}

export function presentDeliveryState(state: LocalDeliveryState): DeliveryPresentation {
  switch (state) {
    case 'pending':
      // 本地已保存待发送。不能显示为「已发送」——那会让用户以为对方已收到
      return { label: '待发送', claimsDelivered: false, offersRetry: false }
    case 'accepted':
      // 服务器已接收。**不是**已送达、更不是已读（§28 第 4 步）
      return { label: '服务器已接收', claimsDelivered: false, offersRetry: false }
    case 'failed':
      // 终态失败。§28：管理员删除队列或保留期到期时，必须让发送方看见终态失败
      return { label: '发送失败', claimsDelivered: false, offersRetry: true }
  }
}

/** 错误的呈现方式，按 §5 的分级要求。 */
export interface ErrorPresentation {
  readonly retryability: Retryability
  /** `terminal` 不提供重试按钮 —— §5 的明确要求。 */
  readonly offersRetry: boolean
  /** `conditional` 需要说明前置条件并给出对应操作入口。 */
  readonly requiresPrecondition: boolean
  /** 面向用户的措辞。 */
  readonly message: string
}

/**
 * 把错误码映射为呈现方式。
 *
 * 可重试性**取自错误码目录而不是调用方猜测** —— §46 明确「可重试性是错误码的
 * 固有属性，不由调用方猜测」。
 */
export function presentError(code: ErrorCode): ErrorPresentation {
  const definition = ERROR_CATALOGUE[code]
  const retryability = definition.retryability

  return {
    retryability,
    offersRetry: retryability === 'retryable',
    requiresPrecondition: retryability === 'conditional',
    message: userFacingMessage(code),
  }
}

/**
 * 面向用户的措辞。
 *
 * §5 禁止把 `NOT_FOUND_OR_FORBIDDEN` 渲染成「对象不存在」这类**推断性描述** ——
 * 服务端刻意不区分「无权限」与「不存在」，客户端替它猜一个就把这层保护抹掉了。
 */
function userFacingMessage(code: ErrorCode): string {
  switch (code) {
    case 'NOT_FOUND_OR_FORBIDDEN':
      // 不写「对象不存在」也不写「你没有权限」——两者都是推断
      return '无法访问该内容'
    case 'RECIPIENT_QUEUE_FULL':
      // 「发送未被接收」是这个错误码的幂等语义，措辞要让用户知道可以重试
      return '对方的收件队列已满，消息未被接收，稍后可重试'
    case 'RATE_LIMITED':
      return '操作过于频繁，请稍后重试'
    case 'VERSION_CONFLICT':
      return '内容已被他人修改，请刷新后重试'
    case 'REVIEW_REQUIRED':
      return '需要先获得评审结论才能完成'
    case 'DEPENDENCY_CYCLE':
      return '该依赖会形成循环，无法添加'
    case 'PROTOCOL_VERSION_UNSUPPORTED':
      return '客户端与服务端版本不兼容，请升级'
    case 'SERVICE_READ_ONLY':
      return '服务正在恢复中，暂时只读'
    default:
      return '操作未能完成'
  }
}

/**
 * 事件流连接状态。
 *
 * §5 要求以下状态**必须显式呈现**：事件流断开、组织切换、权限修订变化、
 * `sync_diverged`。且「**不得**把事件流断开等状态表现为静默停止刷新」。
 */
export const STREAM_STATES = ['connected', 'reconnecting', 'disconnected', 'sync_diverged'] as const
export type StreamState = (typeof STREAM_STATES)[number]

export interface StreamPresentation {
  readonly label: string
  /** 是否必须对用户可见。除 `connected` 外全部为真 —— 静默是被禁止的。 */
  readonly mustBeVisible: boolean
  /** 是否应停止自动重发。`sync_diverged` 下 host 停止 ACK 与自动重发（§28.1）。 */
  readonly haltsAutoResend: boolean
}

export function presentStreamState(state: StreamState): StreamPresentation {
  switch (state) {
    case 'connected':
      return { label: '已连接', mustBeVisible: false, haltsAutoResend: false }
    case 'reconnecting':
      return { label: '正在重连', mustBeVisible: true, haltsAutoResend: false }
    case 'disconnected':
      // 不得表现为静默停止刷新
      return { label: '连接已断开', mustBeVisible: true, haltsAutoResend: false }
    case 'sync_diverged':
      // §28.1：进入 sync_diverged 后停止 ACK、自动重发与新的组织写入
      return { label: '同步出现分叉，正在对账', mustBeVisible: true, haltsAutoResend: true }
  }
}
