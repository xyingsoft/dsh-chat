/**
 * 模态对话框（ui-design.md §2.2.1）。
 *
 * 硬约束：
 * - Portal 渲染到 document.body，避开祖先 transform/overflow；
 * - 焦点陷阱：Tab 到尾回到首，关闭后焦点回打开前所在的元素；
 * - aria-modal + aria-labelledby/describedby；
 * - overlay 点击默认不关闭（破坏性操作防误关）；
 * - 打开时锁定 body 滚动。
 */

import {
  createElement,
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import styles from './Dialog.module.css'

export interface DialogProps {
  readonly open: boolean
  readonly title: string
  readonly onClose: () => void
  readonly role?: 'dialog' | 'alertdialog'
  readonly size?: 'sm' | 'md' | 'lg'
  readonly closeOnOverlayClick?: boolean
  readonly closeOnEsc?: boolean
  /** 打开后是否把焦点放到第一个可聚焦元素。 */
  readonly initialFocus?: 'first' | 'none'
  readonly children: ReactNode
}

const SIZE_CLASS = { sm: 'sizeSm', md: 'sizeMd', lg: 'sizeLg' } as const

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function queryFocusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (node) => node.offsetParent !== null || node === document.activeElement,
  )
}

export function Dialog(props: DialogProps): ReactElement | null {
  const {
    open,
    title,
    onClose,
    role = 'dialog',
    size = 'md',
    closeOnOverlayClick = false,
    closeOnEsc = true,
    initialFocus = 'first',
    children,
  } = props

  const titleId = useId()
  const bodyId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  // 记录打开前焦点，关闭后还回去（a11y 硬要求）
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    if (panel !== null && initialFocus === 'first') {
      const targets = queryFocusables(panel)
      ;(targets[0] ?? panel).focus()
    }
    return () => {
      restoreRef.current?.focus?.()
    }
  }, [open, initialFocus])

  // Esc 关闭 + Tab 焦点陷阱
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      const panel = panelRef.current
      if (event.key === 'Escape' && closeOnEsc) {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab' || panel === null) return
      const targets = queryFocusables(panel)
      if (targets.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = targets[0]!
      const last = targets[targets.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, closeOnEsc, onClose])

  // 滚动锁定
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  if (!open) return null

  const panelStyle = { '--dsh-chat-dialog-width': undefined } as CSSProperties

  const panel = createElement(
    'div',
    {
      ref: panelRef,
      role,
      tabIndex: -1,
      className: [
        styles['panel'],
        styles[SIZE_CLASS[size] ?? 'sizeMd'],
        role === 'alertdialog' ? styles['alert'] : '',
      ]
        .filter(Boolean)
        .join(' '),
      style: panelStyle,
      'aria-modal': true,
      'aria-labelledby': titleId,
      'aria-describedby': bodyId,
      'aria-label': undefined,
    },
    createElement('h2', { id: titleId, className: styles['title'] }, title),
    createElement('div', { id: bodyId, className: styles['body'] }, children),
  )

  return createPortal(
    createElement(
      'div',
      {
        className: styles['overlay'],
        onPointerDown: closeOnOverlayClick ? () => onClose() : undefined,
      },
      createElement(
        'div',
        { className: styles['backdrop'], onPointerDown: closeOnOverlayClick ? () => onClose() : undefined },
        panel,
      ),
    ),
    document.body,
  )
}
