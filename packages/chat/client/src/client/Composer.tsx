/**
 * 消息输入框。
 *
 * 在这之前界面只能读不能写 —— 那不是「界面做完了」，是做了一半。
 *
 * ## 长度按字素簇算
 *
 * §30.1 的上限是 8000 **字素簇**，不是 UTF-16 码元。用 `.length` 计数的话，
 * 一个 emoji 算 2、一个带修饰符的家庭 emoji 能算 11 —— 用户会在远不到上限时
 * 被拒。服务端已经按字素簇校验，客户端要用同一把尺子，否则出现「界面说还能
 * 输入 3000 字，发出去被拒」。
 *
 * ## Enter 发送，Shift+Enter 换行
 *
 * 聊天场景的默认约定。输入法组字期间的 Enter **不能**当发送 ——
 * 中文/日文用户按 Enter 是在确认候选词，那时发出去的是半截句子。
 * 靠 `isComposing` 判断。
 */

import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react'

import styles from './Composer.module.css'

/** §30.1：消息正文 8000 字素簇。 */
const MAX_GRAPHEMES = 8000
/** 剩余不足这个数才显示计数，平时不占注意力。 */
const COUNTER_THRESHOLD = 200

/**
 * 字素簇计数。导出供消息内联编辑复用 —— 编辑后的正文走同一条校验路径，
 * 两把尺子会在「编辑框说没问题、提交被拒」上分叉。
 */
export function countGraphemes(text: string): number {
  // Intl.Segmenter 在所有目标浏览器里都有；真没有时退回 [...text]，
  // 那按码位算，比 .length 准，比字素簇粗
  if (typeof Intl?.Segmenter !== 'function') return [...text].length
  return [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].length
}

export interface ComposerProps {
  /** 发送。返回错误码表示失败，返回 undefined 表示成功。 */
  readonly onSend: (body: string) => Promise<string | undefined>
  /**
   * 受控草稿文本（工单：草稿保存）。
   *
   * 草稿由父层持有并持久化 —— 切会话时换草稿、发送后清空都通过 `value`
   * 生效，本组件不自己存。这样「打了没发」能活过页面刷新与设备重启
   * （localStorage 在父层做），且列表上的草稿标记与输入框内容永远同源。
   */
  readonly value: string
  readonly onChange: (text: string) => void
  readonly disabled?: boolean
  readonly placeholder?: string
}

export function Composer(props: ComposerProps): ReactElement {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const composingRef = useRef(false)

  // 多行自适应高度（ui-design.md gap：固定一行不会随内容长高）。
  // 输入框高度 = 内容高度，上限由 CSS 的 max-height 兜住后内部滚动。
  useEffect(() => {
    const el = inputRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [props.value])

  const graphemes = countGraphemes(props.value)
  const overLimit = graphemes > MAX_GRAPHEMES
  const empty = props.value.trim().length === 0
  const canSend = !empty && !overLimit && !sending && props.disabled !== true

  const send = useCallback(async () => {
    if (!canSend) return
    const body = props.value
    setSending(true)
    setError(undefined)
    // 先清空再发：等响应回来才清的话，慢网络下用户会以为没发出去而重复按。
    // 失败时把内容放回去，不让用户白打一遍 —— 两者都走 onChange，
    // 父层的草稿持久化（含 localStorage）随之更新，不需要再单独同步
    props.onChange('')
    const failure = await props.onSend(body)
    setSending(false)
    if (failure !== undefined) {
      setError(failure)
      props.onChange(body)
    }
    inputRef.current?.focus()
  }, [canSend, props])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter') return
      // Shift+Enter 换行
      if (event.shiftKey) return
      // 输入法组字期间的 Enter 是在确认候选词，不是发送。
      // 不判这个的话中文用户会发出半截句子
      if (composingRef.current || event.nativeEvent.isComposing) return
      event.preventDefault()
      void send()
    },
    [send],
  )

  const remaining = MAX_GRAPHEMES - graphemes
  const showCounter = remaining <= COUNTER_THRESHOLD

  return createElement(
    'div',
    { className: styles['root'] },
    createElement(
      'div',
      { className: styles['field'] },
      createElement('textarea', {
        ref: inputRef,
        className: styles['input'],
        value: props.value,
        rows: 1,
        placeholder: props.placeholder ?? '发消息…',
        disabled: props.disabled === true || sending,
        'aria-label': '消息内容',
        onChange: (event: { target: { value: string } }) => {
          props.onChange(event.target.value)
          if (error !== undefined) setError(undefined)
        },
        onCompositionStart: () => {
          composingRef.current = true
        },
        onCompositionEnd: () => {
          composingRef.current = false
        },
        onKeyDown,
      }),
      createElement(
        'button',
        {
          type: 'button',
          className: styles['send'],
          disabled: !canSend,
          onClick: () => void send(),
          title: '发送（Enter）',
          'aria-label': '发送',
        },
        sending ? '…' : '↑',
      ),
    ),
    createElement(
      'p',
      {
        className: [styles['hint'], error !== undefined ? styles['error'] : '']
          .filter(Boolean)
          .join(' '),
        // 发送失败要被读屏播报，不能只是变个颜色
        role: error !== undefined ? 'alert' : undefined,
      },
      error !== undefined
        ? error
        : showCounter
          ? createElement(
              'span',
              {
                className: [
                  styles['counter'],
                  overLimit ? styles['counterOver'] : styles['counterWarn'],
                ].join(' '),
              },
              overLimit ? `超出 ${-remaining} 字` : `还可输入 ${remaining} 字`,
            )
          : 'Enter 发送 · Shift+Enter 换行',
    ),
  )
}

export const COMPOSER_LIMITS = { maxGraphemes: MAX_GRAPHEMES }
