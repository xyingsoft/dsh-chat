/**
 * 测试对手方「乙」的命令行。
 *
 * 乙没有 UI —— 它是这个脚本。甲（DSH Desktop）在 UI 里看到的会话另一头，
 * 由下面三个子命令扮演：
 *
 *   node bob.mjs contact <甲的账号ID> [欢迎消息]
 *       与甲建立联系人关系（request + accept），可选发第一条消息。
 *       甲的账号 ID 在 Desktop 设置面板的「账号 ID」里（可复制）。
 *
 *   node bob.mjs send <甲的账号ID> <消息文本>
 *       以乙的身份发一条直发消息。
 *
 *   node bob.mjs log <甲的账号ID>
 *       打印乙与甲的双向消息历史（只读，不消费投递队列）。
 *
 *   node bob.mjs group <甲的账号ID> [群名]
 *       乙建一个群并把甲拉进去（P1 S2 播种；群消息收发在 S4 后可用）。
 *
 * ## 前置
 *
 * start-relay.mjs 已在跑（乙的账号是它播种的）。
 *
 * ## 写入路径
 *
 * 直写 relay 的 SQLite（领域函数与 relay 的 HTTP 处理器走同一份代码，
 * 模式见 kernel 的 multi-process.host.spec.ts）。理由见 start-relay.mjs
 * 头部：引导邀请码一码一户，被甲用掉了；乙没有码也没有设备凭证。
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const relayDist = resolve(repoRoot, '..', 'dsh-chat-relay', 'dist')
const relayDb = join(here, 'data', 'relay.db')

/** 与 start-relay.mjs 的常量保持一致。 */
const ORG = 'org-bootstrap'
const BOB_ACCOUNT_ID = 'yi'

const [, , action, aliceId, ...rest] = process.argv

if (!existsSync(relayDb)) {
  process.stderr.write(`找不到 ${relayDb} —— 先跑 node examples/two-users/start-relay.mjs\n`)
  process.exit(2)
}
if (action !== 'contact' && action !== 'send' && action !== 'log' && action !== 'group') {
  process.stderr.write('用法：node bob.mjs <contact|send|log|group> <甲的账号ID> [文本|群名]\n')
  process.exit(2)
}
if (action !== undefined && (aliceId === undefined || aliceId.length === 0)) {
  process.stderr.write('缺少甲的账号 ID（Desktop 设置面板 → 账号 ID，可复制）\n')
  process.exit(2)
}

const { ChatDatabase } = await import(
  pathToFileURL(join(relayDist, 'storage', 'database.js')).href
)
const { createContactRequest, acceptContactRequest } = await import(
  pathToFileURL(join(relayDist, 'domain', 'messaging', 'contacts.js')).href
)
const { acceptDirectMessage } = await import(
  pathToFileURL(join(relayDist, 'domain', 'messaging', 'delivery.js')).href
)
const { createGroup, addGroupMember } = await import(
  pathToFileURL(join(relayDist, 'domain', 'messaging', 'groups.js')).href
)

const chat = ChatDatabase.open({ location: relayDb })

function contact() {
  const welcome =
    rest.length > 0 ? rest.join(' ') : '你好，我是乙（联调对手方）。用 bob.mjs send 回复你。'
  // 先断言甲存在（在事务外：断言失败要干净退出，不该把句柄留在半开的事务里）
  const alice = chat.readonlyHandle
    .prepare('SELECT display_name FROM accounts WHERE account_id = ?')
    .get(aliceId)
  if (alice === undefined) {
    process.stderr.write(
      `relay 库里没有账号 ${aliceId}。确认甲已在 Desktop 完成开户，且账号 ID 复制完整。\n`,
    )
    process.exit(2)
  }
  const aliceName = alice.display_name

  // 幂等：已有 accepted 关系就不重复建（重复 INSERT 会撞唯一约束，
  // 那是脚本重跑的常态而不是异常）
  const existing = chat.readonlyHandle
    .prepare(
      `SELECT 1 FROM contact_requests
        WHERE organization_id = ? AND requester_id = ? AND target_id = ? AND state = 'accepted'`,
    )
    .get(ORG, BOB_ACCOUNT_ID, aliceId)

  if (existing === undefined) {
    const requestId = `cr-${randomUUID()}`
    const accepted = chat.transaction((db) => {
      createContactRequest(db, {
        requestId,
        organizationId: ORG,
        requesterId: BOB_ACCOUNT_ID,
        targetId: aliceId,
        now: new Date(),
      })
      return acceptContactRequest(db, { requestId, now: new Date() })
    })
    if (!accepted) {
      process.stderr.write('联系人请求接受失败（不该发生 —— 请求是刚建的）。\n')
      process.exit(1)
    }
    process.stdout.write(`已与 ${aliceName}（${aliceId}）建立联系人。\n`)
  } else {
    process.stdout.write(`与 ${aliceName}（${aliceId}）已是联系人，跳过建关系。\n`)
  }
  sendMessage(welcome)
  process.stdout.write(`已发出消息：「${welcome}」\n`)
}

function sendMessage(body) {
  const messageId = randomUUID()
  const result = chat.transaction((db) =>
    acceptDirectMessage(db, {
      organizationId: ORG,
      messageId,
      senderId: BOB_ACCOUNT_ID,
      recipientId: aliceId,
      body,
      operationId: `bob-${messageId}`,
      queueCapacity: 100,
      now: new Date(),
    }),
  )
  if (!result.ok) {
    process.stderr.write(`发送被拒：${JSON.stringify(result)}\n`)
    process.exit(1)
  }
  return result
}

function send() {
  const body = rest.join(' ')
  if (body.length === 0) {
    process.stderr.write('消息文本不能为空\n')
    process.exit(2)
  }
  const result = sendMessage(body)
  process.stdout.write(
    result.idempotentReplay === true
      ? '这条消息此前已写入（幂等重放），甲侧看到的是同一条。\n'
      : `已发送（deliverySeq ${result.deliverySeq}）。\n`,
  )
}

function log() {
  // 只读查询，不动 delivery_queue —— 乙有没有「收」不影响甲的界面状态
  const rows = chat.readonlyHandle
    .prepare(
      `SELECT sender_id, body, created_at FROM messages
        WHERE organization_id = ?
          AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
        ORDER BY created_at`,
    )
    .all(ORG, BOB_ACCOUNT_ID, aliceId, aliceId, BOB_ACCOUNT_ID)
  if (rows.length === 0) {
    process.stdout.write('还没有消息。先 send 一条，或在 Desktop 里给乙发一条。\n')
    return
  }
  for (const row of rows) {
    const who = row.sender_id === BOB_ACCOUNT_ID ? '乙' : '甲'
    process.stdout.write(`[${row.created_at}] ${who}：${row.body}\n`)
  }
}

function groupCreate() {
  const name = (rest.length > 0 ? rest.join(' ') : '甲乙联调群').trim()
  const alice = chat.readonlyHandle
    .prepare('SELECT display_name FROM accounts WHERE account_id = ?')
    .get(aliceId)
  if (alice === undefined) {
    process.stderr.write(
      `relay 库里没有账号 ${aliceId}。确认甲已在 Desktop 完成开户，且账号 ID 复制完整。\n`,
    )
    process.exit(2)
  }

  // 幂等：已存在同名的群就复用，不再重复建
  const existing = chat.readonlyHandle
    .prepare('SELECT group_id FROM groups WHERE organization_id = ? AND name = ?')
    .get(ORG, name)
  if (existing !== undefined) {
    // 仍确保甲在成员里（缺了只补，不报错）
    chat.transaction((db) =>
      addGroupMember({ db, organizationId: ORG, groupId: existing.group_id, accountId: aliceId }),
    )
    process.stdout.write(`群「${name}」已存在（${existing.group_id}），已确保成员含甲。\n`)
    return
  }

  const { groupId } = chat.transaction((db) => {
    const created = createGroup({ db, organizationId: ORG, creatorAccountId: BOB_ACCOUNT_ID, name })
    addGroupMember({ db, organizationId: ORG, groupId: created.groupId, accountId: aliceId })
    return created
  })
  process.stdout.write(
    `已建群「${name}」（${groupId}），成员：乙 + ${alice.display_name}。\n` +
      '群消息收发（S4）接通前，界面暂时还看不到这条群会话。\n',
  )
}

if (action === 'contact') contact()
else if (action === 'send') send()
else if (action === 'group') groupCreate()
else log()

chat.close()
