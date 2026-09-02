/**
 * 下拉/右键菜单（ui-design.md §2.2.3）。
 *
 * 约束：
 * - trigger=contextmenu 阻止默认菜单；click 由子元素触发；
 * - 键盘可达：↑↓ 移动、Enter 选择、Esc 关闭；关闭后焦点还原；
 * - aria：容器 role="menu"，项 role="menuitem"，分隔线 role="separator"；
 * - 溢出时重新夹紧到视口，优先保留下半部分可见。
 *
 * 用法（children 渲染函数拿到 openAt）：
 * ```ts
 * createElement(DropdownMenu, { trigger: 'click', items }, (openAt) =>
 *   createElement('button', { onClick: (e) => openAt(e.currentTarget) }, '⋯'))
 * ```
 * openAt 可传元素（按元素下方对齐）或 {x,y}（按坐标）。
 */

import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import styles from './DropdownMenu.module.css'

export interface DropdownMenuItem {
  readonly id: string
  readonly label: string
  readonly onSelect?: () => void
  readonly disabled?: boolean
  readonly danger?: boolean
  /** 仅渲染分隔线。 */
  readonly separator?: boolean
  readonly icon?: ReactElement
}

export interface DropdownMenuProps {
  readonly trigger: 'contextmenu' | 'click' | 'manual'
  readonly items: readonly DropdownMenuItem[]
  readonly ariaLabel?: string
  readonly onClose?: () => void
  readonly children: (
    openAt: (anchor: HTMLElement | { readonly x: number; readonly y: number }) => void,
  ) => ReactElement
}

type Anchor = { readonly kind: 'below'; readonly element: HTMLElement } | { readonly kind: 'point'; readonly x: number; readonly y: number }

export function DropdownMenu(props: DropdownMenuProps): ReactElement {
  const { trigger, items, ariaLabel = '菜单', onClose, children } = props
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<Anchor | undefined>(undefined)
  const [activeIndex, setActiveIndex] = useState(-1)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  const close = useCallback((): void => {
    setOpen(false)
    setActiveIndex(-1)
    onClose?.()
  }, [onClose])

  const openAt = useCallback(
    (target: HTMLElement | { readonly x: number; readonly y: number }): void => {
      restoreRef.current = document.activeElement as HTMLElement | null
      if (typeof target === 'object' && 'x' in target) {
        setAnchor({ kind: 'point', x: target.x, y: target.y })
      } else {
        setAnchor({ kind: 'below', element: target })
      }
      setOpen(true)
    },
    [],
  )

  // 打开后聚焦菜单容器，进入键盘导航
  useEffect(() => {
    if (open) menuRef.current?.focus()
  }, [open])

  // 关闭后焦点还原
  useEffect(() => {
    if (open) return
    if (restoreRef.current !== null) {
      restoreRef.current.focus?.()
      restoreRef.current = null
    }
  }, [open])

  // 定位并夹紧到视口；滚动/resize 时重夹
  useLayoutEffect(() => {
    if (!open || menuRef.current === null) return
    const menu = menuRef.current
    const apply = (): void => {
      const rect = menu.getBoundingClientRect()
      let left = 0
      let top = 0
      if (anchor?.kind === 'point') {
        left = anchor.x
        top = anchor.y
      } else if (anchor?.kind === 'below') {
        const anchorRect = anchor.element.getBoundingClientRect()
        left = anchorRect.left
        top = anchorRect.bottom + 4
      }
      if (left + rect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - rect.width - 8)
      if (top + rect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - rect.height - 8)
      left = Math.max(8, left)
      top = Math.max(8, top)
      menu.style.left = `${left}px`
      menu.style.top = `${top}px`
    }
    apply()
    window.addEventListener('scroll', apply, true)
    window.addEventListener('resize', apply)
    return () => {
      window.removeEventListener('scroll', apply, true)
      window.removeEventListener('resize', apply)
    }
  }, [open, anchor])

  // 键盘导航
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      const selectable: readonly { readonly index: number; readonly item: DropdownMenuItem }[] =
        items.flatMap((item, index) =>
          item.separator === true || item.disabled === true ? [] : [{ index, item }],
        )
      const step = (delta: number): void => {
        event.preventDefault()
        if (selectable.length === 0) return
        const current = selectable.findIndex(({ index }) => index === activeIndex)
        const next =
          current === -1
            ? delta > 0
              ? selectable[0]!
              : selectable[selectable.length - 1]!
            : selectable[(current + delta + selectable.length) % selectable.length]!
        setActiveIndex(next.index)
      }
      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          event.stopPropagation()
          close()
          break
        case 'ArrowDown':
          step(1)
          break
        case 'ArrowUp':
          step(-1)
          break
        case 'Enter':
        case ' ': {
          event.preventDefault()
          const current = selectable.find(({ index }) => index === activeIndex)
          const target = current ?? selectable[0]
          target?.item.onSelect?.()
          close()
          break
        }
        default:
          break
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, items, activeIndex, close])

  // 点击菜单外关闭
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node) === true) return
      close()
    }
    document.addEventListener('pointerdown', onPointer, true)
    return () => document.removeEventListener('pointerdown', onPointer, true)
  }, [open, close])

  const onContext = (event: MouseEvent): void => {
    if (trigger !== 'contextmenu') return
    event.preventDefault()
    event.stopPropagation()
    openAt({ x: event.clientX, y: event.clientY })
  }

  const menuNodes: ReactNode[] = []
  let selectableAt = -1
  items.forEach((item, index) => {
    if (item.separator === true) {
      menuNodes.push(
        createElement('div', { key: item.id, role: 'separator', className: styles['separator'] }),
      )
      return
    }
    if (item.disabled !== true) selectableAt += 1
    menuNodes.push(
      createElement(
        'button',
        {
          key: item.id,
          type: 'button',
          role: 'menuitem',
          tabIndex: -1,
          disabled: item.disabled === true,
          className: [
            styles['item'],
            item.danger === true ? styles['danger'] : '',
            activeIndex === index ? styles['itemActive'] : '',
          ]
            .filter(Boolean)
            .join(' '),
          onPointerEnter: () => setActiveIndex(index),
          onClick: () => {
            item.onSelect?.()
            close()
          },
        },
        item.icon ?? null,
        createElement('span', { className: styles['itemLabel'] }, item.label),
      ),
    )
  })
  void selectableAt

  return createElement(
    'span',
    { className: styles['wrap'], onContextMenu: onContext },
    children(openAt),
    open && typeof document !== 'undefined'
      ? createPortal(
          createElement(
            'div',
            {
              ref: menuRef,
              className: styles['menu'],
              role: 'menu',
              'aria-label': ariaLabel,
              tabIndex: -1,
              onPointerDown: (event: PointerEvent) => event.stopPropagation(),
            },
            ...menuNodes,
          ),
          document.body,
        )
      : null,
  )
}
