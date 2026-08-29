/**
 * host 进程。
 *
 * §4：host 负责**本地持久化缓存**、保存设备凭证、运行 relay 客户端。
 * 因此这个进程有自己的 SQLite 文件 —— 与 relay 的那个是两个文件，
 * 这正是「host 本地缓存」与「relay 共享状态」的分界。
 *
 * 两个 host 进程各跑一份这个脚本，指向不同的本地库、同一个 relay。
 *
 * 用法：
 *   node host-process.mjs <local-db> <relay-url> send <messageId> <body>
 *   node host-process.mjs <local-db> <relay-url> receive
 *   node host-process.mjs <local-db> <relay-url> local-count
 *
 * 结果以单行 JSON 打印到 stdout。
 */

import { ChatDatabase } from '../../../host/dist/storage/database.js'
import {
  enqueueOutgoing,
  markAccepted,
  markFailed,
  outgoingOf,
} from '../../../messaging/dist/outgoing.js'

const [, , localDb, relayUrl, action, ...rest] = process.argv
if (!localDb || !relayUrl || !action) {
  process.stderr.write('用法：node host-process.mjs <local-db> <relay-url> <action> [args]\n')
  process.exit(2)
}

const ORG = 'org-1'
const chat = ChatDatabase.open({ location: localDb })

async function post(path, body) {
  const response = await fetch(`${relayUrl}${path}`, {
    method: 'POST',
    // connection: close 让 undici 不保留 keep-alive 套接字。留着的话，
    // 那个套接字会把事件循环撑到超时才释放，而进程本该做完就退
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

/** 确保本地账号表里有这两个人 —— 本地库有自己的外键约束。 */
function seedAccounts() {
  chat.transaction((db) => {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
    )
    const now = new Date().toISOString()
    insert.run('jia', '甲', now)
    insert.run('yi', '乙', now)
  })
}

async function send(messageId, body) {
  seedAccounts()
  const key = { organizationId: ORG, senderId: 'jia', messageId }

  // §4：**先本地保存再发网络请求**。反过来的话，进程在请求发出后、响应
  // 回来前崩溃，这条消息就彻底消失了
  chat.transaction((db) =>
    enqueueOutgoing(db, { ...key, recipientId: 'yi', body, now: new Date() }),
  )
  const beforeSend = chat.transaction((db) => outgoingOf(db, key))

  const result = await post('/send', {
    messageId,
    senderId: 'jia',
    recipientId: 'yi',
    body,
    operationId: `op-${messageId}`,
  })

  if (result.status === 200 && result.body.ok) {
    chat.transaction((db) => markAccepted(db, key, result.body.deliverySeq, new Date()))
  } else {
    chat.transaction((db) =>
      markFailed(db, key, result.body.errorCode ?? 'INTERNAL', new Date()),
    )
  }

  const afterSend = chat.transaction((db) => outgoingOf(db, key))
  return {
    // 发网络请求之前本地就是 pending —— 这是三态里的第一态
    stateBeforeRequest: beforeSend?.state,
    stateAfterRequest: afterSend?.state,
    deliverySeq: afterSend?.deliverySeq ?? null,
    relayStatus: result.status,
  }
}

async function receive() {
  seedAccounts()
  const pulled = await post('/pull', { recipientId: 'yi', deviceId: 'yi-device', batchSize: 10 })
  const items = pulled.body.items ?? []

  // 落到本地库再 ACK。顺序反过来的话，ACK 成功但本地写入失败，
  // 消息就在 relay 上被标记为已投递而本地没有 —— 永久丢失
  chat.transaction((db) => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO messages
         (message_id, organization_id, sender_id, recipient_id, kind, body, revision,
          created_at, received_at, operation_id, event_format_version, encryption_meta)
       VALUES (?, ?, ?, ?, 'text', ?, 1, ?, ?, ?, 1, ?)`,
    )
    const now = new Date().toISOString()
    for (const item of items) {
      insert.run(
        item.messageId,
        ORG,
        item.senderId,
        'yi',
        item.body,
        item.createdAt ?? now,
        now,
        `op-${item.messageId}`,
        JSON.stringify({ scheme: 'none', keyEpoch: 0, formatVersion: 1 }),
      )
    }
  })

  const acked =
    items.length === 0
      ? { body: { acked: 0 } }
      : await post('/ack', {
          recipientId: 'yi',
          deviceId: 'yi-device',
          deliverySeqs: items.map((item) => item.deliverySeq),
        })

  return {
    pulled: items.map((item) => ({ messageId: item.messageId, body: item.body })),
    acked: acked.body.acked,
    localCount: localCount(),
  }
}

function localCount() {
  const row = chat.readonlyHandle.prepare('SELECT COUNT(*) AS c FROM messages').get()
  return row.c
}

const actions = {
  send: () => send(rest[0], rest[1]),
  receive: () => receive(),
  'local-count': async () => ({ localCount: localCount() }),
}

const handler = actions[action]
if (handler === undefined) {
  process.stderr.write(`未知动作：${action}\n`)
  process.exit(2)
}

// 不调 process.exit()：Windows 下 undici 的套接字还在关闭时强制退出，会撞上
// libuv 的 `!(handle->flags & UV_HANDLE_CLOSING)` 断言而崩溃（退出码
// 3221226505），即便业务逻辑已经全部成功 —— 第一版就是这么挂的，stdout 里
// 明明是正确的 JSON，退出码却是崩溃。
//
// 上面的 `connection: close` 让那个窗口变窄，但窄不等于没有。改为设置
// exitCode 并让事件循环自然排空。
try {
  const result = await handler()
  process.stdout.write(`${JSON.stringify(result)}\n`)
  chat.close()
  process.exitCode = 0
} catch (error) {
  process.stderr.write(`${String(error)}\n`)
  chat.close()
  process.exitCode = 1
}
