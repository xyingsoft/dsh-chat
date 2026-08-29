/**
 * 遍历 React 元素树的测试辅助。
 *
 * ## 为什么不用 react-dom 或 testing-library
 *
 * 客户端运行时是 vendored 的（见 `scripts/verify-vendored-runtime.mjs`）。
 * 引入 `react-dom` 会把依赖闭包与那套带外校验一起动了，而本文件要做的事
 * ——「组件返回的树里有没有这段文字、这个 class、这个 aria 属性」——
 * 用几十行纯 React API 就能做到。
 *
 * 这不是「测试替身」：`ConversationList` 与 `MessageView` 都是纯函数组件，
 * 调用它们拿到的就是真实的元素树，没有任何模拟。缺的只是浏览器布局，
 * 而本层测的是**呈现内容**而非布局。
 *
 * 放在 src 而不是测试文件里，是因为两个测试文件都要用。它不出现在包的
 * 公开导出中。
 */

import { isValidElement, type ReactElement, type ReactNode } from 'react'

/** 树上的一个节点：元素本身加上它的属性。 */
export interface WalkedNode {
  readonly type: string
  readonly props: Record<string, unknown>
}

function childrenOf(node: ReactNode): ReactNode[] {
  if (!isValidElement(node)) return []
  const children = (node.props as { children?: ReactNode }).children
  if (children === undefined || children === null) return []
  return Array.isArray(children) ? (children as ReactNode[]) : [children]
}

/**
 * 深度优先遍历全部元素节点，**按文档顺序**。
 *
 * 顺序不是可有可无的：`findAll(tree, 'button')[0]` 必须是页面上第一个按钮，
 * 否则「第一条会话被选中」这类断言会在实现没变的情况下随机通过或失败。
 * 用栈就要把子节点反着压入，否则出栈顺序是反的。
 */
export function walk(root: ReactNode): WalkedNode[] {
  const found: WalkedNode[] = []
  const stack: ReactNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined || !isValidElement(node)) continue
    found.push({
      type: typeof node.type === 'string' ? node.type : '(component)',
      props: node.props as Record<string, unknown>,
    })
    const children = childrenOf(node)
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push(children[i] as ReactNode)
    }
  }
  return found
}

/**
 * 树上全部文本内容，按出现顺序拼接。
 *
 * 只收字符串与数字子节点 —— 这正是 React 会转义并渲染为文本的那些。
 * 如果哪天有人用了 `dangerouslySetInnerHTML`，那段内容**不会**出现在这里，
 * 而 `hasDangerousHtml` 会抓到它。
 */
export function textOf(root: ReactNode): string {
  const parts: string[] = []
  const visit = (node: ReactNode): void => {
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node))
      return
    }
    for (const child of childrenOf(node)) visit(child)
  }
  visit(root)
  return parts.join('')
}

/** 树上是否有任何节点使用了 `dangerouslySetInnerHTML`。 */
export function hasDangerousHtml(root: ReactNode): boolean {
  return walk(root).some((node) => node.props['dangerouslySetInnerHTML'] !== undefined)
}

/** 按标签名找节点。 */
export function findAll(root: ReactNode, type: string): WalkedNode[] {
  return walk(root).filter((node) => node.type === type)
}

/** 按 class 片段找节点。CSS Modules 下 class 名带哈希，所以用包含匹配。 */
export function findByClass(root: ReactNode, fragment: string): WalkedNode[] {
  return walk(root).filter((node) => {
    const className = node.props['className']
    return typeof className === 'string' && className.includes(fragment)
  })
}

/** 触发某节点的 onClick。 */
export function click(node: WalkedNode): void {
  const handler = node.props['onClick']
  if (typeof handler !== 'function') throw new Error(`节点 ${node.type} 没有 onClick`)
  ;(handler as () => void)()
}

/** 断言用：把元素树当作 ReactElement 处理，避免每处都写类型断言。 */
export function asElement(node: ReactNode): ReactElement {
  if (!isValidElement(node)) throw new Error('不是一个 React 元素')
  return node
}
