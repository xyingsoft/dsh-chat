/**
 * 右侧聊天抽屉。
 *
 * 挂在 `conversation.session.header.utilities`（会话头部右对齐的工具区），
 * 点按钮从右侧滑出一块可调宽度的面板。
 *
 * ## 为什么是这个位置
 *
 * §5 只规定行为不规定布局，位置是产品决定。选会话头部右侧是因为：
 * 它就在你正在看的 AI 对话旁边，**不用离开当前页面**；而 DSH 一共 58 个 slot
 * 里没有「右侧栏」这种东西，头部工具区是离右侧最近、语义又对得上的挂载点
 * （`conversation.view` 是「rendered one at a time」，挂那儿会把 AI 对话整个
 * 替换掉，不是并排）。
 *
 * ## 为什么用 portal
 *
 * 抽屉是 `position: fixed`。如果直接渲染在头部的 DOM 里，一旦某个祖先带了
 * `transform` / `filter` / `will-change`，它就会成为 fixed 的包含块，面板会
 * 跑到头部里面去而不是贴着窗口右边。portal 到 `document.body` 完全避开这一类
 * 祖先影响 —— 这不是洁癖，头部里带 transform 的动画很常见。
 *
 * ## 宽度与开合状态存在哪
 *
 * §5：「滚动位置、折叠状态、草稿编辑器焦点等属于设备本地的视图状态」。
 * 这里用 `localStorage` 而不是 DSH store —— store 需要在插件里声明并注入，
 * 而抽屉是个纯呈现组件，为两个数字引入服务依赖不划算。
 * 真要接 store 时换掉 `usePersistedState` 一个函数即可。
 */

import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import styles from './ChatDrawer.module.css'

const WIDTH_KEY = 'dsh-chat:drawer-width'
const OPEN_KEY = 'dsh-chat:drawer-open'

/** 宽度上下限。太窄会话列表挤成一条，太宽把 AI 对话逼到角落。 */
const MIN_WIDTH = 280
const MAX_WIDTH = 720
const DEFAULT_WIDTH = 380

/**
 * 读写 localStorage 的小状态。
 *
 * localStorage 在某些环境下会抛（隐私模式、被策略禁用），所以读写都包起来 ——
 * 一个存不下的宽度偏好不该让整个面板崩掉。
 */
function usePersistedState<T>(
  key: string,
  fallback: T,
  parse: (raw: string) => T | undefined,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = globalThis.localStorage?.getItem(key)
      if (raw === null || raw === undefined) return fallback
      return parse(raw) ?? fallback
    } catch {
      return fallback
    }
  })

  const update = useCallback(
    (next: T) => {
      setValue(next)
      try {
        globalThis.localStorage?.setItem(key, String(next))
      } catch {
        // 存不下就只在本次会话里生效
      }
    },
    [key],
  )

  return [value, update]
}

export interface ChatDrawerProps {
  /** 抽屉内容。由调用方给，便于单测时不拉网络。 */
  readonly children: ReactNode
  /** 触发按钮上的未读数。收起时也要能看出有新消息。 */
  readonly unreadCount?: number
  readonly label?: string
}

export function ChatDrawer(props: ChatDrawerProps): ReactElement {
  const [open, setOpen] = usePersistedState(OPEN_KEY, false, (raw) => raw === 'true')
  const [width, setWidth] = usePersistedState(WIDTH_KEY, DEFAULT_WIDTH, (raw) => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clamp(parsed) : undefined
  })
  const [resizing, setResizing] = useState(false)
  /**
   * 抽屉顶边的视口坐标。
   *
   * 不能写 `top: 0` —— DSH 有自绘标题栏，抽屉会钻到它下面去，头部（标题、
   * 关闭按钮）被整个盖住。第一版就是这样，界面上只看得到内容区。
   *
   * 也不写死一个偏移量：标题栏高度随平台与窗口状态变。改为**量**触发按钮
   * 所在容器的下边缘 —— 那正好是会话头部的底部，抽屉从那里往下铺。
   */
  const [topOffset, setTopOffset] = useState(0)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // 展开时量一次顶边。窗口尺寸变化时重量 —— 最大化/还原会改标题栏高度
  useEffect(() => {
    if (!open) return
    const measure = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      // 取按钮所在行的下边缘：抽屉紧贴会话头部下方，不遮挡头部本身
      setTopOffset(Math.max(0, Math.round(rect.bottom + 6)))
    }
    measure()
    globalThis.addEventListener?.('resize', measure)
    return () => globalThis.removeEventListener?.('resize', measure)
  }, [open])

  // Esc 关闭。抽屉是覆盖在内容上的，没有明确的关闭手势会让人觉得被困住
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    globalThis.addEventListener?.('keydown', onKey)
    return () => globalThis.removeEventListener?.('keydown', onKey)
  }, [open, setOpen])

  // 拖拽改宽度。监听挂在 window 上而不是手柄上 —— 挂手柄上的话，
  // 鼠标一旦移出那 7px 就丢事件，拖动会「断掉」
  useEffect(() => {
    if (!resizing) return
    const onMove = (event: MouseEvent): void => {
      // 抽屉贴右边缘，所以宽度 = 窗口宽 - 鼠标 x
      setWidth(clamp(globalThis.innerWidth - event.clientX))
    }
    const onUp = (): void => setResizing(false)
    globalThis.addEventListener?.('mousemove', onMove)
    globalThis.addEventListener?.('mouseup', onUp)
    return () => {
      globalThis.removeEventListener?.('mousemove', onMove)
      globalThis.removeEventListener?.('mouseup', onUp)
    }
  }, [resizing, setWidth])

  const unread = props.unreadCount ?? 0
  const label = props.label ?? '聊天'

  const trigger = createElement(
    'button',
    {
      type: 'button',
      ref: triggerRef,
      className: [styles['trigger'], open ? styles['triggerOpen'] : ''].filter(Boolean).join(' '),
      onClick: () => setOpen(!open),
      // 读屏要知道这是个开关、现在是开是关、控制的是哪块区域
      'aria-expanded': open,
      'aria-controls': 'dsh-chat-drawer',
      title: open ? `收起${label}` : `展开${label}`,
    },
    createElement('span', null, label),
    unread > 0
      ? createElement(
          'span',
          { className: styles['triggerBadge'], 'aria-label': `${unread} 条未读` },
          unread > 99 ? '99+' : String(unread),
        )
      : null,
  )

  if (!open) return trigger

  const drawer = createElement(
    'aside',
    {
      id: 'dsh-chat-drawer',
      className: styles['drawer'],
      style: { width: `${width}px`, top: `${topOffset}px` },
      'aria-label': label,
    },
    createElement('div', {
      className: [styles['resizer'], resizing ? styles['resizerActive'] : '']
        .filter(Boolean)
        .join(' '),
      onMouseDown: (event: { preventDefault: () => void }) => {
        // 不 preventDefault 的话拖动会选中页面文本，光标变成 I 形
        event.preventDefault()
        setResizing(true)
      },
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': '调整宽度',
    }),
    createElement(
      'div',
      { className: styles['header'] },
      createElement('p', { className: styles['title'] }, label),
      createElement(
        'div',
        { className: styles['headerActions'] },
        createElement(
          'button',
          {
            type: 'button',
            className: styles['iconButton'],
            onClick: () => setWidth(DEFAULT_WIDTH),
            title: '恢复默认宽度',
          },
          '⤢',
        ),
        createElement(
          'button',
          {
            type: 'button',
            className: styles['iconButton'],
            onClick: () => setOpen(false),
            title: '收起',
            'aria-label': '收起',
          },
          '×',
        ),
      ),
    ),
    createElement('div', { className: styles['body'] }, props.children),
  )

  return createElement(
    'span',
    null,
    trigger,
    // 没有 document 时（SSR、测试）就只渲染按钮，不炸
    typeof document === 'undefined' ? null : createPortal(drawer, document.body),
  )
}

function clamp(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)))
}

export const DRAWER_WIDTH_BOUNDS = { min: MIN_WIDTH, max: MAX_WIDTH, default: DEFAULT_WIDTH }
