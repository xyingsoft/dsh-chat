/**
 * `/conversations` 的群聊形态（S4b）端到端测试。
 *
 * 私聊行来自 messaging 聚合，群聊行来自本地镜像 —— 两条来源在这个端点合并。
 * 这里验证的是合并后的对外契约：群会话带 `kind: 'group'` 与可选的
 * `memberCount`（client 的 ConversationSummary 壳靠它们区分形态），
 * 且私聊/群聊按最后活动统一排序。
 */

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acceptDirectMessage } from '@dsh-chat/messaging'

import { ChatDatabase } from '../storage/database.js'
import { addGroupMember, ingestGroupMessage } from '../storage/groups.js'
import {
  conversationsHandler,
  mergeConversationRows,
  type MessageCommandDeps,
  type Principal,
} from './message-commands.js'

const ORG = 'org-1'
const NOW = new Date('2026-08-30T00:00:00Z')
const at = (ms: number): Date => new Date(NOW.getTime() + ms)

let ctx: Context
let chat: ChatDatabase
let baseUrl: string
let principal: Principal | undefined

/** 一个成员、一条群消息的群 + 一条私聊，时间错开便于验证排序。 */
function seed(): void {
  chat.transaction((db) => {
    const insert = db.prepare(
      'INSERT INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    insert.run('alice', '甲', NOW.toISOString())
    insert.run('bob', '乙', NOW.toISOString())

    // 私聊：alice → bob，最早
    acceptDirectMessage(db, {
      messageId: 'dm-1',
      organizationId: ORG,
      senderId: 'alice',
      recipientId: 'bob',
      body: '私聊一条',
      operationId: 'op-dm-1',
      now: at(0),
      queueCapacity: 10,
    })

    // 群聊：alice 是成员，bob 在群里发了一条，最晚
    ingestGroupMessage(db, {
      messageId: 'gm-1',
      organizationId: ORG,
      senderId: 'bob',
      groupId: 'grp-1',
      groupName: '产品组',
      memberCount: 3,
      body: '群聊一条',
      operationId: 'op-gm-1',
      now: at(2000),
    })
    addGroupMember(db, { organizationId: ORG, groupId: 'grp-1', accountId: 'alice', now: at(1000) })
    addGroupMember(db, { organizationId: ORG, groupId: 'grp-1', accountId: 'bob', now: at(1000) })
  })
}

beforeEach(async () => {
  chat = ChatDatabase.open({ location: ':memory:' })
  seed()

  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${ctx.webServer.port}`
  principal = { accountId: 'alice', deviceId: 'alice-laptop', organizationId: ORG }

  const deps: MessageCommandDeps = {
    database: { transaction: chat.transaction.bind(chat) } as MessageCommandDeps['database'],
    expectedOrigin: baseUrl,
    authenticate: () => principal,
    queueCapacity: 10,
    leaseMs: 60_000,
    now: () => NOW,
  }

  await ctx.plugin({
    inject: ['webServer'],
    apply(inner: Context) {
      inner.effect(
        () => inner.webServer.register({ kind: 'exact', path: '/api/chat/conversations', handler: conversationsHandler(deps) }),
        'route /api/chat/conversations',
      )
    },
  })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  chat.close()
})

interface ConversationRow {
  readonly peerId: string
  readonly peerDisplayName: string
  readonly kind?: 'direct' | 'group'
  readonly memberCount?: number
  readonly preview: string
  readonly lastActivityAt: string
  readonly unreadCount: number
  readonly lastMessageOutgoing: boolean
}

interface ConversationsPayload {
  readonly data: { readonly conversations: ConversationRow[] }
}

async function listConversations(): Promise<ConversationsPayload> {
  const response = await fetch(`${baseUrl}/api/chat/conversations`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as ConversationsPayload
}

describe('会话列表的群聊形态', () => {
  it('成员在列表里看到群：kind 为 group、名字是群名、带成员数', async () => {
    const body = await listConversations()
    const rows = body.data.conversations
    const group = rows.find((row) => row.peerId === 'grp-1')
    expect(group).toBeDefined()
    expect(group).toMatchObject({
      peerId: 'grp-1',
      peerDisplayName: '产品组',
      kind: 'group',
      memberCount: 3,
      preview: '群聊一条',
      unreadCount: 0,
    })
  })

  it('私聊与群聊按最后活动统一排序', async () => {
    const body = await listConversations()
    expect(body.data.conversations.map((row) => row.peerId)).toEqual(['grp-1', 'bob'])
  })

  it('私聊行不带 kind（client 缺省按 1v1 呈现）', async () => {
    const body = await listConversations()
    const direct = body.data.conversations.find((row) => row.peerId === 'bob')
    expect(direct?.kind).toBeUndefined()
    expect(direct?.memberCount).toBeUndefined()
  })

  it('非成员看不到群会话', async () => {
    principal = { accountId: 'carol', deviceId: 'carol-laptop', organizationId: ORG }
    const body = await listConversations()
    expect(body.data.conversations.find((row) => row.peerId === 'grp-1')).toBeUndefined()
  })

  it('未认证返回 UNAUTHENTICATED', async () => {
    principal = undefined
    const response = await fetch(`${baseUrl}/api/chat/conversations`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(401)
  })
})

describe('mergeConversationRows', () => {
  it('按 lastActivityAt 合并排序并夹到 limit', () => {
    const direct = [
      { peerId: 'a', lastActivityAt: '2026-08-30T00:00:02.000Z' },
      { peerId: 'b', lastActivityAt: '2026-08-30T00:00:00.000Z' },
    ] as unknown as Parameters<typeof mergeConversationRows>[0]
    const groups = [
      { peerId: 'g1', kind: 'group' as const, lastActivityAt: '2026-08-30T00:00:01.000Z' },
    ] as unknown as Parameters<typeof mergeConversationRows>[1]
    const merged = mergeConversationRows(direct, groups, 2)
    expect(merged.map((row) => row.peerId)).toEqual(['a', 'g1'])
  })
})
