/**
 * 群聊的本地镜像：store 与聚合（S4b）。
 *
 * host 是自包含的本地库（relay 模式下则是纯转发，见 `relay/proxy.ts`），没有
 * host → relay 的取件入本地库路径。因此群聊在本地以「镜像」形态落地：取件/同步
 * 方（后续里程碑的 relay 直连，或本地的名单同步）调用这里的 store 助手写入，
 * `/conversations` 聚合从这里读。镜像的对象是 relay v011/v012 的契约：
 *
 * - `groups`：群名册（名称、已知成员数、活动时间）。
 * - `group_members`：成员关系 —— `/conversations` 靠它判断「某个账号在不在群里」。
 * - `group_messages`：群消息。relay 里这类消息是 `recipient_type='group'` 的
 *   `messages` 行；host 本地 `messages.recipient_id` 带指向 `accounts` 的外键，
 *   收不下群 id（见 migrations v8 的说明），所以群消息落在独立的镜像表，
 *   幂等键与 messages 相同（§14 的 `(sender_id, message_id)`）。
 *
 * 所有写操作**必须在调用方的事务内执行**（§26：领域写入与 outbox 同事务），
 * 与 messaging 包的领域函数同一约定。
 */

import type { DatabaseSync } from 'node:sqlite'

import {
  CURRENT_EVENT_FORMAT_VERSION,
  PLAINTEXT_ENCRYPTION_META,
} from '@dsh-chat/contract'

/** 群消息预览的字素簇上限，与 messaging 的私聊预览保持同一口径。 */
const PREVIEW_GRAPHEMES = 40

/**
 * 截断预览。按字素簇而不是 `length` —— 与 messaging 的 `truncate` 同一规则：
 * 按 UTF-16 码元切会把 emoji 劈成两半，序列化后是替换字符。
 */
function truncate(body: string): string {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })
  const graphemes = [...segmenter.segment(body)]
  if (graphemes.length <= PREVIEW_GRAPHEMES) return body
  return `${graphemes.slice(0, PREVIEW_GRAPHEMES).map((s) => s.segment).join('')}…`
}

/** 群名册镜像的写入参数。memberCount 未知时可省略（保留镜像既有值）。 */
export interface GroupRosterInput {
  readonly organizationId: string
  readonly groupId: string
  readonly name: string
  readonly memberCount?: number
  readonly now: Date
}

/**
 * 写入/刷新群名册镜像（幂等）。
 *
 * 新建行时把首见时间记为活动时间；已存在时只前进不回退（`last_activity_at`
 * 单调，与会话排序的一致性相关 —— 一条迟到的旧消息不该把群顶回列表顶部）。
 * `member_count` 只在调用方确实知道时覆盖（`COALESCE`），避免名单还没同步
 * 就把已知的数冲成 NULL。
 */
export function upsertGroupRoster(
  db: DatabaseSync,
  input: GroupRosterInput,
): void {
  const iso = input.now.toISOString()
  db.prepare(
    `INSERT INTO groups (organization_id, group_id, name, member_count,
                         created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (organization_id, group_id) DO UPDATE SET
       name = excluded.name,
       member_count = COALESCE(excluded.member_count, groups.member_count),
       last_activity_at = CASE WHEN groups.last_activity_at < excluded.last_activity_at
                               THEN excluded.last_activity_at ELSE groups.last_activity_at END`,
  ).run(
    input.organizationId,
    input.groupId,
    input.name,
    input.memberCount ?? null,
    iso,
    iso,
  )
}

/** 群成员镜像的写入参数。 */
export interface GroupMemberInput {
  readonly organizationId: string
  readonly groupId: string
  readonly accountId: string
  readonly now: Date
}

/**
 * 记录一个账号属于某个群（幂等）。
 *
 * `/conversations` 按成员关系过滤 —— 没有这一行，账号在镜像里就查不到这个群。
 * 成员名单来自 relay/名单同步；逐条取件路径（后续里程碑）在给自己落消息时应
 * 同时确认自己这一行，否则「收到了群消息」却看不到会话。
 */
export function addGroupMember(
  db: DatabaseSync,
  input: GroupMemberInput,
): void {
  db.prepare(
    `INSERT INTO group_members (organization_id, group_id, account_id, joined_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (organization_id, group_id, account_id) DO NOTHING`,
  ).run(input.organizationId, input.groupId, input.accountId, input.now.toISOString())
}

/** 落一条群消息所需的信息（对齐 messaging 的 AcceptMessageInput 形状）。 */
export interface IngestGroupMessageInput {
  readonly messageId: string
  readonly organizationId: string
  readonly senderId: string
  readonly groupId: string
  /** 群名快照。写入时同步刷新名册镜像的显示名。 */
  readonly groupName: string
  /** 名单快照已知的成员数；未知（如逐条拉取）时省略。 */
  readonly memberCount?: number
  readonly body: string
  readonly operationId: string
  readonly now: Date
}

export interface IngestGroupMessageResult {
  /** 幂等命中：同一 `(senderId, messageId)` 重试，不重复写入。 */
  readonly idempotentReplay: boolean
}

/**
 * 本地落一条群消息（镜像），**必须在调用方的事务内执行**。
 *
 * 语义与 messaging 的 `acceptDirectMessage` 对齐：幂等键是 `(senderId, messageId)`
 * （§14），重试返回首次写入的结果而不新增；消息行与名册刷新一并完成。
 * 群成员关系**不在这里维护** —— 本函数不知道「这条消息是给哪个本地账号取件
 * 的」，成员镜像由调用方（取件/名单同步）用 `addGroupMember` 维护。
 *
 * 没有队列容量预检：本地镜像不建每成员的投递队列（那属于取件/ACK 路径，
 * 后续里程碑再接），所以不存在「队列满」的本地状态。
 */
export function ingestGroupMessage(
  db: DatabaseSync,
  input: IngestGroupMessageInput,
): IngestGroupMessageResult {
  const existing = db
    .prepare(
      'SELECT 1 FROM group_messages WHERE sender_id = ? AND message_id = ?',
    )
    .get(input.senderId, input.messageId)
  if (existing !== undefined) {
    return { idempotentReplay: true }
  }

  const iso = input.now.toISOString()
  db.prepare(
    `INSERT INTO group_messages
       (message_id, organization_id, group_id, sender_id, kind, body, revision,
        created_at, received_at, operation_id, event_format_version, encryption_meta)
     VALUES (?, ?, ?, ?, 'text', ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    input.messageId,
    input.organizationId,
    input.groupId,
    input.senderId,
    input.body,
    iso,
    iso,
    input.operationId,
    CURRENT_EVENT_FORMAT_VERSION,
    JSON.stringify(PLAINTEXT_ENCRYPTION_META),
  )

  upsertGroupRoster(db, {
    organizationId: input.organizationId,
    groupId: input.groupId,
    name: input.groupName,
    ...(input.memberCount === undefined ? {} : { memberCount: input.memberCount }),
    now: input.now,
  })

  return { idempotentReplay: false }
}

/**
 * `/conversations` 里的一个群会话行。peerId 复用为会话 id（= 群 id），
 * peerDisplayName 是群名 —— 与 client 侧 ConversationSummary 的约定一致。
 */
export interface GroupConversationSummary {
  readonly peerId: string
  readonly peerDisplayName: string
  /** 让 client 区分群与 1v1 的标记。 */
  readonly kind: 'group'
  /** 名单同步已知的成员数；未知时不携带，client 据此不显示徽标。 */
  readonly memberCount?: number
  readonly preview: string
  readonly lastActivityAt: string
  /** S4b 没有本地未读模型（无逐成员队列），恒为 0。 */
  readonly unreadCount: number
  readonly lastMessageOutgoing: boolean
}

interface GroupRow {
  group_id: string
  name: string
  member_count: number | null
  created_at: string
  last_activity_at: string
}

interface LastMessageRow {
  message_id: string
  sender_id: string
  body: string
  created_at: string
}

/**
 * 某账号在某组织下可见的群会话，按最后活动时间倒序。
 *
 * 参与关系 = 成员镜像里有该账号，或该账号在群里发过消息（取件路径先于名单
 * 同步时兜底）。群会话只在镜像有名单行时出现；每行都带组织过滤（§9）。
 */
export function groupConversationsOf(
  db: DatabaseSync,
  organizationId: string,
  accountId: string,
  options: { readonly limit?: number } = {},
): readonly GroupConversationSummary[] {
  const rows = db
    .prepare(
      `SELECT g.group_id, g.name, g.member_count, g.created_at, g.last_activity_at,
              (SELECT gm.created_at FROM group_messages gm
                WHERE gm.organization_id = g.organization_id
                  AND gm.group_id = g.group_id
                ORDER BY gm.created_at DESC, gm.message_id DESC LIMIT 1) AS last_msg_at
         FROM groups g
        WHERE g.organization_id = ?
          AND (EXISTS (SELECT 1 FROM group_members m
                        WHERE m.organization_id = g.organization_id
                          AND m.group_id = g.group_id
                          AND m.account_id = ?)
            OR EXISTS (SELECT 1 FROM group_messages gm
                        WHERE gm.organization_id = g.organization_id
                          AND gm.group_id = g.group_id
                          AND gm.sender_id = ?))
        ORDER BY COALESCE(last_msg_at, g.last_activity_at) DESC, g.group_id
        LIMIT ?`,
    )
    .all(
      organizationId,
      accountId,
      accountId,
      options.limit ?? 50,
    ) as unknown as Array<GroupRow & { last_msg_at: string | null }>

  return rows.map((row) => summarizeGroup(db, organizationId, accountId, row))
}

/** 取一个群的最后一条消息与预览等派生值。 */
function summarizeGroup(
  db: DatabaseSync,
  organizationId: string,
  accountId: string,
  row: GroupRow,
): GroupConversationSummary {
  const last = db
    .prepare(
      `SELECT message_id, sender_id, body, created_at
         FROM group_messages
        WHERE organization_id = ? AND group_id = ?
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1`,
    )
    .get(organizationId, row.group_id) as LastMessageRow | undefined

  const summary: GroupConversationSummary = {
    peerId: row.group_id,
    peerDisplayName: row.name,
    kind: 'group',
    preview: last === undefined ? '' : truncate(last.body),
    lastActivityAt: last?.created_at ?? row.last_activity_at,
    unreadCount: 0,
    lastMessageOutgoing: last?.sender_id === accountId,
  }
  // 名单没同步过成员数就不携带该字段（exactOptionalPropertyTypes 下必须按
  // 存在与否构造，不能塞 undefined）
  if (row.member_count !== null) {
    return { ...summary, memberCount: row.member_count }
  }
  return summary
}
