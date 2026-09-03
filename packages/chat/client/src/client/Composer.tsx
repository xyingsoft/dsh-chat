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
 *
 * ## 附件（P1 壳，诚实门禁）
 *
 * 附件上传后端（P1）尚未实现。本组件只做**本地暂存层**：选择/拖拽文件 →
 * 预览卡（图片缩略图/图标+大小）→ 可移除。点发送时若带附件，不假装上传、
 * 不静默丢文件，而是弹说明让用户选「仅发送文字」（附件清空）或取消（保留）。
 * 绝不显示假的「上传进度条」。
 */

import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'

import { Dialog } from '../components/Dialog.js'
import { notify } from '../components/Toast.js'

import styles from './Composer.module.css'

/** §30.1：消息正文 8000 字素簇。 */
const MAX_GRAPHEMES = 8000
/** 剩余不足这个数才显示计数，平时不占注意力。 */
const COUNTER_THRESHOLD = 200
/** 一次最多暂存几个附件（P1 后端到来前只是本地壳上限）。 */
const MAX_ATTACHMENTS = 9

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

/** 本地暂存的附件。仅存在于当前 Composer 实例，未发送即设备本地视图状态。 */
export interface AttachmentDraft {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly mime: string
  /** 图片类文件的对象 URL（缩略图用）。释放由组件负责。 */
  readonly previewUrl: string | undefined
}

/** 人类可读的文件大小。导出便于测试。 */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Number.isInteger(kb) ? kb : (kb < 10 ? kb.toFixed(1) : Math.round(kb))} KB`
  const mb = kb / 1024
  return `${Number.isInteger(mb) ? mb : (mb < 10 ? mb.toFixed(1) : Math.round(mb))} MB`
}

function isImage(mime: string): boolean {
  return mime.startsWith('image/')
}

function nextAttachmentId(): string {
  // 轻量随机 id，仅用于本地 key/移除 —— 不是权威数据
  return `att-${Math.random().toString(36).slice(2, 10)}`
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

  // —— P1 附件壳（本地暂存） ——
  const [attachments, setAttachments] = useState<readonly AttachmentDraft[]>([])
  const [dropActive, setDropActive] = useState(false)
  const [attachGate, setAttachGate] = useState(false)
  const pickerRef = useRef<HTMLInputElement | null>(null)
  // 卸载时要用最新列表释放对象 URL，不能闭包捕获初值
  const attachmentsRef = useRef<readonly AttachmentDraft[]>(attachments)
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  const releaseAttachmentUrls = useCallback((list: readonly AttachmentDraft[]): void => {
    for (const item of list) {
      if (item.previewUrl !== undefined) {
        try {
          URL.revokeObjectURL(item.previewUrl)
        } catch {
          // 无 URL 环境（SSR/测试）下静默
        }
      }
    }
  }, [])

  const addFiles = useCallback(
    (files: readonly File[]): void => {
      const room = MAX_ATTACHMENTS - attachments.length
      if (room <= 0) {
        notify({ id: 'attach-limit', variant: 'warning', message: `一次最多暂存 ${MAX_ATTACHMENTS} 个附件` })
        return
      }
      const picked = files.slice(0, room).map((file): AttachmentDraft => {
        let previewUrl: string | undefined
        if (isImage(file.type)) {
          try {
            previewUrl = URL.createObjectURL(file)
          } catch {
            previewUrl = undefined
          }
        }
        return {
          id: nextAttachmentId(),
          name: file.name,
          size: file.size,
          mime: file.type || 'application/octet-stream',
          previewUrl,
        }
      })
      if (picked.length < files.length) {
        notify({ id: 'attach-limit', variant: 'warning', message: `一次最多暂存 ${MAX_ATTACHMENTS} 个附件` })
      }
      setAttachments((prev) => [...prev, ...picked])
      if (error !== undefined) setError(undefined)
    },
    [attachments.length, error],
  )

  const removeAttachment = useCallback(
    (id: string): void => {
      setAttachments((prev) => {
        const target = prev.find((item) => item.id === id)
        if (target !== undefined) releaseAttachmentUrls([target])
        return prev.filter((item) => item.id !== id)
      })
    },
    [releaseAttachmentUrls],
  )

  // 卸载时释放全部对象 URL，避免泄漏
  useEffect(() => {
    return () => releaseAttachmentUrls(attachmentsRef.current)
  }, [releaseAttachmentUrls])

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDropActive(false)
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length > 0) addFiles(files)
    },
    [addFiles],
  )

  // 多行自适应高度（ui-design.md gap：固定一行不会随内容长高）。
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

  const doSend = useCallback(async (): Promise<void> => {
    if (!canSend) return
    const body = props.value
    setSending(true)
    setError(undefined)
    // 先清空再发：等响应回来才清的话，慢网络下用户会以为没发出去而重复按。
    props.onChange('')
    const failure = await props.onSend(body)
    setSending(false)
    if (failure !== undefined) {
      setError(failure)
      props.onChange(body)
    }
    inputRef.current?.focus()
  }, [canSend, props])

  const send = useCallback(async (): Promise<void> => {
    if (!canSend) return
    if (attachments.length > 0) {
      // 附件发送能力（P1 后端）未开通 —— 弹说明而不是假装上传
      setAttachGate(true)
      return
    }
    await doSend()
  }, [canSend, attachments.length, doSend])

  const sendTextOnly = useCallback((): void => {
    setAttachGate(false)
    releaseAttachmentUrls(attachments)
    setAttachments([])
    void doSend()
  }, [attachments, doSend, releaseAttachmentUrls])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter') return
      if (event.shiftKey) return
      if (composingRef.current || event.nativeEvent.isComposing) return
      event.preventDefault()
      void send()
    },
    [send],
  )

  const remaining = MAX_GRAPHEMES - graphemes
  const showCounter = remaining <= COUNTER_THRESHOLD

  const attachmentsStrip =
    attachments.length === 0
      ? null
      : createElement(
          'div',
          { className: styles['attachments'], 'aria-label': '待发送附件' },
          ...attachments.map((item) =>
            createElement(
              'div',
              { key: item.id, className: styles['attachCard'] },
              item.previewUrl !== undefined
                ? createElement('img', {
                    className: styles['thumb'],
                    src: item.previewUrl,
                    alt: '',
                  })
                : createElement(
                    'span',
                    { className: styles['fileIcon'], 'aria-hidden': true },
                    '📎',
                  ),
              createElement(
                'span',
                { className: styles['attachMeta'] },
                createElement('span', { className: styles['attachName'], title: item.name }, item.name),
                createElement('span', { className: styles['attachSize'] }, formatAttachmentSize(item.size)),
              ),
              createElement(
                'button',
                {
                  type: 'button',
                  className: styles['attachRemove'],
                  onClick: () => removeAttachment(item.id),
                  'aria-label': `移除附件 ${item.name}`,
                },
                '×',
              ),
            ),
          ),
        )

  const gateDialog =
    !attachGate
      ? null
      : createElement(Dialog, {
          open: true,
          title: '附件发送尚未开通',
          size: 'sm',
          onClose: () => setAttachGate(false),
          closeOnOverlayClick: false,
          children: [
            createElement(
              'p',
              { key: 'body', className: styles['gateBody'] },
              '附件上传属于 P1 范围，当前版本只会发送文字。文件已保留在输入框上方待选区（不会丢）。',
            ),
            createElement(
              'div',
              { key: 'actions', className: styles['gateActions'] },
              createElement(
                'button',
                { type: 'button', className: styles['gateCancel'], onClick: () => setAttachGate(false) },
                '取消',
              ),
              createElement(
                'button',
                { type: 'button', className: styles['gatePrimary'], onClick: sendTextOnly },
                '仅发送文字',
              ),
            ),
          ],
        })

  return createElement(
    'div',
    {
      className: styles['root'],
      onDragOver: (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault()
      },
      onDragEnter: (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault()
        setDropActive(true)
      },
      onDragLeave: () => setDropActive(false),
      onDrop,
    },
    attachmentsStrip,
    createElement(
      'div',
      {
        className: [
          styles['field'],
          dropActive ? styles['dropActive'] : '',
        ].filter(Boolean).join(' '),
      },
      createElement(
        'button',
        {
          type: 'button',
          className: styles['attachBtn'],
          disabled: props.disabled === true || sending,
          onClick: () => pickerRef.current?.click(),
          title: '添加附件（拖拽文件到此也可）',
          'aria-label': '添加附件',
        },
        '+',
      ),
      createElement('input', {
        ref: pickerRef,
        className: styles['filePicker'],
        type: 'file',
        multiple: true,
        tabIndex: -1,
        'aria-hidden': true,
        onChange: (event: { currentTarget: HTMLInputElement }) => {
          const files = [...(event.currentTarget.files ?? [])]
          event.currentTarget.value = ''
          if (files.length > 0) addFiles(files)
        },
      }),
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
    dropActive
      ? createElement('div', { className: styles['dropHint'], role: 'status' }, '松开以添加附件')
      : null,
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
          : 'Enter 发送 · Shift+Enter 换行 · 可拖入附件',
    ),
    gateDialog,
  )
}

export const COMPOSER_LIMITS = { maxGraphemes: MAX_GRAPHEMES }
