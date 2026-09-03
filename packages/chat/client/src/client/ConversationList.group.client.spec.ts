/**
 * 群聊类型会话壳的呈现测试（P1 首项）。
 *
 * 当前 host 还不返回群会话 —— 壳的职责是：数据一来就能按群形态渲染
 * （成员数徽标 + 不画 1v1 在线点），而不是等 P1 后端全部落完再改列表。
 * 这里用固定 fixture 锁住「给 kind/memberCount 就渲染成什么样」。
 */

import { describe, expect, it } from 'vitest'

import { ConversationList, type ConversationSummary } from './ConversationList.js'
import { textOf } from './element-tree.js'

const noop = (): void => {}

const direct: ConversationSummary = {
  conversationId: 'd1',
  title: '乙',
  preview: '你：收到',
  lastActivityAt: '2026-09-03T02:00:00.000Z',
  unreadCount: 0,
  presence: 'online',
}

const group: ConversationSummary = {
  conversationId: 'g1',
  title: '设计小组',
  kind: 'group',
  memberCount: 12,
  preview: '乙：晚上评审？',
  lastActivityAt: '2026-09-03T02:00:00.000Z',
  unreadCount: 3,
}

const format = (): string => '09:05'

describe('ConversationList 群聊类型会话壳', () => {
  it('群会话渲染群名与成员数徽标', () => {
    const tree = ConversationList({ conversations: [group], onSelect: noop, formatTime: format })
    const text = textOf(tree)
    expect(text).toContain('设计小组')
    expect(text).toContain('12 人')
    expect(text).toContain('晚上评审')
  })

  it('群会话不渲染 1v1 的在线状态点语义', () => {
    // 1v1 行含 presence title/aria；群行没有 —— 结构上就不该有那个点
    const groupTree = ConversationList({ conversations: [group], onSelect: noop, formatTime: format })
    expect(textOf(groupTree)).not.toContain('在线')
    expect(textOf(groupTree)).not.toContain('离线')
  })

  it('缺省（无 kind）仍按 1v1 渲染：不出现成员徽标', () => {
    const tree = ConversationList({ conversations: [direct], onSelect: noop, formatTime: format })
    const text = textOf(tree)
    expect(text).toContain('乙')
    expect(text).not.toContain('人】')
  })

  it('群没有成员数时不臆造徽标', () => {
    const bare: ConversationSummary = {
      conversationId: 'g2',
      title: '无人数群',
      kind: 'group',
      preview: '',
      lastActivityAt: '2026-09-03T02:00:00.000Z',
      unreadCount: 0,
    }
    const text = textOf(ConversationList({ conversations: [bare], onSelect: noop, formatTime: format }))
    expect(text).toContain('无人数群')
    expect(text).not.toMatch(/\d+ 人/)
  })
})
