/**
 * 轻量 Toast 通知（ui-design.md §2.2.2）。
 *
 * 约束：
 * - 只承载「操作反馈」，不承载影响继续操作的信息（那些走占布局条 U2）；
 * - 最多同时 3 条，超出 FIFO；同一 id 重复触发是更新而非新增；
 * - info/success/warning 默认 4s 自动消失；error 默认不自动关；
 * - 自动消失的 Toast 不得带破坏性撤销入口。
 *
 * 用法：应用侧挂载一次 <ToastHost/>（ChatDrawer 已挂），任意位置调用
 * `notify({ id, variant, message })`。组件不自己编文案（已本地化）。
 */

import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import styles from './Toast.module.css'

export type ToastVariant = 'info' | 'success' | 'warning' | 'error'

export interface ToastInput {
  /** 调用方生成，便于去重/更新。 */
  readonly id: string
  readonly variant: ToastVariant
  readonly message: string
  /** 默认 4000；error 默认 0（不自动关，需手动关）。 */
  readonly durationMs?: number
  readonly action?: { readonly label: string; readonly onClick: () => void }
}

interface ActiveToast extends ToastInput {
  readonly key: number
}

const DEFAULT_DURATION = 4_000
const MAX_VISIBLE = 3

let keyCounter = 0
let pendingInputs: ToastInput[] = []
let listener: ((inputs: ToastInput[]) => void) | undefined

export function notify(input: ToastInput): void {
  const next = [...pendingInputs.filter((item) => item.id !== input.id), input]
  // 超出上限淘汰最旧的
  while (next.length > MAX_VISIBLE) next.shift()
  pendingInputs = next
  listener?.(pendingInputs)
}

function close(id: string): void {
  pendingInputs = pendingInputs.filter((item) => item.id !== id)
  listener?.(pendingInputs)
}

/** 挂载一次的通知区域。渲染进 body portal，避免被面板的 overflow 裁剪。 */
export function ToastHost(): ReactElement {
  const [toasts, setToasts] = useState<readonly ToastInput[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    listener = (inputs) => {
      setToasts([...inputs])
      const alive = new Set(inputs.map((item) => item.id))
      // 清理已消失条目的定时器
      for (const [id, timer] of timersRef.current) {
        if (!alive.has(id)) {
          clearTimeout(timer)
          timersRef.current.delete(id)
        }
      }
      // 为新条目排自动消失
      for (const toast of inputs) {
        if (timersRef.current.has(toast.id)) continue
        const duration = toast.durationMs ?? (toast.variant === 'error' ? 0 : DEFAULT_DURATION)
        if (duration <= 0) continue
        const timer = setTimeout(() => close(toast.id), duration)
        timersRef.current.set(toast.id, timer)
      }
    }
    listener(pendingInputs)
    return () => {
      listener = undefined
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [])

  return createPortal(
    createElement(
      'div',
      { className: styles['region'], role: 'region', 'aria-label': '通知' },
      toasts.map((toast) =>
        createElement(ToastItem, { key: toast.id, toast, onClose: () => close(toast.id) }),
      ),
    ),
    document.body,
  )
}

function ToastItem({
  toast,
  onClose,
}: {
  readonly toast: ToastInput
  readonly onClose: () => void
}): ReactElement {
  const { id, variant, message, action } = toast
  const icon = variant === 'success' ? '✓' : variant === 'error' ? '✕' : variant === 'warning' ? '!' : 'i'
  const nodes: ReactNode[] = [
    createElement('span', { key: 'icon', className: styles['icon'], 'aria-hidden': true }, icon),
    createElement('span', { key: 'msg', className: styles['message'] }, message),
  ]
  if (action !== undefined) {
    nodes.push(
      createElement(
        'button',
        {
          key: 'action',
          type: 'button',
          className: styles['action'],
          onClick: () => {
            action.onClick()
            onClose()
          },
        },
        action.label,
      ),
    )
  }
  nodes.push(
    createElement(
      'button',
      { key: 'close', type: 'button', className: styles['close'], onClick: onClose, 'aria-label': '关闭通知' },
      '×',
    ),
  )

  return createElement(
    'div',
    {
      className: [styles['toast'], styles[variant]].filter(Boolean).join(' '),
      role: variant === 'error' ? 'alert' : 'status',
    },
    ...nodes,
  )
}
