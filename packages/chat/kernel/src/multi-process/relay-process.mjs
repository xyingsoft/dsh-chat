/**
 * relay 进程。
 *
 * §4：relay 持有共享状态（队列、成员关系、审计），host 通过 HTTP 与之通信，
 * 浏览器**不直接与 relay 通信**。此前的集成测试把 relay 与 host 放在同一个
 * 进程里，「两个实例」实际是同一进程内的两个用户身份 —— 那验证不了跨进程的
 * 持久化与并发。
 *
 * 这个脚本是**真正独立的 OS 进程**：拥有自己的 SQLite 文件，通过 HTTP 提供
 * 服务，两个 host 进程连它。
 *
 * 用法：`node relay-process.mjs <db-path>`，就绪后向 stdout 打印 `READY <port>`。
 *
 * ## 为什么是 .mjs 而不是 .ts
 *
 * 它要被 `child_process.spawn` 直接执行。仓库里没有 ts 运行时加载器，
 * 引一个进来只为跑这个脚本不划算。它 import 的是各包编译出的 dist，
 * 因此测的仍然是真实实现，不是另写一份。
 */

import { createServer } from 'node:http'

import { ChatDatabase } from '../../../host/dist/storage/database.js'
import {
  acceptContactRequest,
  createContactRequest,
} from '../../../messaging/dist/contacts.js'
import {
  acceptDirectMessage,
  acknowledge,
  leaseBatch,
} from '../../../messaging/dist/delivery.js'
import { recordAuditEvent } from '../../../audit/dist/audit-events.js'

const dbPath = process.argv[2]
if (!dbPath) {
  process.stderr.write('用法：node relay-process.mjs <db-path>\n')
  process.exit(2)
}

const ORG = 'org-1'
const chat = ChatDatabase.open({ location: dbPath })

// 初始账号与联系人关系。真实部署里这些来自注册流程；这里直接建好，
// 因为本脚本要验证的是**跨进程投递**，不是注册
chat.transaction((db) => {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
  )
  const now = new Date().toISOString()
  insert.run('jia', '甲', now)
  insert.run('yi', '乙', now)

  const existing = db.prepare('SELECT 1 FROM contact_requests WHERE request_id = ?').get('cr-1')
  if (!existing) {
    createContactRequest(db, {
      requestId: 'cr-1',
      organizationId: ORG,
      requesterId: 'jia',
      targetId: 'yi',
      now: new Date(),
    })
    acceptContactRequest(db, { requestId: 'cr-1', now: new Date() })
  }
})

let auditSeq = 0

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function respond(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

const server = createServer(async (request, response) => {
  let body
  try {
    body = await readBody(request)
  } catch {
    respond(response, 400, { error: { code: 'NOT_FOUND_OR_FORBIDDEN' } })
    return
  }

  try {
    if (request.url === '/send') {
      // 领域写入与审计同事务（§26、§44.1.2）—— 跨进程不改变这条
      const result = chat.transaction((db) => {
        const accepted = acceptDirectMessage(db, {
          organizationId: ORG,
          messageId: body.messageId,
          senderId: body.senderId,
          recipientId: body.recipientId,
          body: body.body,
          operationId: body.operationId,
          queueCapacity: 100,
          now: new Date(),
        })
        if (accepted.ok && !accepted.idempotentReplay) {
          auditSeq += 1
          recordAuditEvent(db, {
            auditEventId: `ae-${auditSeq}`,
            organizationId: ORG,
            eventType: 'message_accepted',
            occurredAt: new Date(),
            actorAccountId: body.senderId,
            targetRef: `message:${body.senderId}/${body.messageId}`,
            outcome: 'succeeded',
            policyRevision: 1,
            operationId: body.operationId,
          })
        }
        return accepted
      })
      respond(response, result.ok ? 200 : 507, result)
      return
    }

    if (request.url === '/pull') {
      const items = chat.transaction((db) =>
        leaseBatch(db, {
          organizationId: ORG,
          recipientId: body.recipientId,
          deviceId: body.deviceId,
          batchSize: body.batchSize ?? 10,
          leaseMs: 60_000,
          now: new Date(),
        }),
      )
      respond(response, 200, { items })
      return
    }

    if (request.url === '/ack') {
      const acked = chat.transaction((db) =>
        acknowledge(db, {
          organizationId: ORG,
          recipientId: body.recipientId,
          deviceId: body.deviceId,
          deliverySeqs: body.deliverySeqs,
          now: new Date(),
        }),
      )
      respond(response, 200, { acked })
      return
    }

    if (request.url === '/queue-depth') {
      const row = chat.readonlyHandle
        .prepare(
          'SELECT COUNT(*) AS c FROM delivery_queue WHERE recipient_id = ? AND acked_at IS NULL',
        )
        .get(body.recipientId ?? 'yi')
      respond(response, 200, { pending: row.c })
      return
    }

    respond(response, 404, { error: { code: 'NOT_FOUND_OR_FORBIDDEN' } })
  } catch (error) {
    // 不把内部细节泄露给调用方；细节进 stderr 供测试诊断
    process.stderr.write(`relay 处理 ${request.url} 失败：${String(error)}\n`)
    respond(response, 500, { error: { code: 'INTERNAL' } })
  }
})

server.listen(0, '127.0.0.1', () => {
  // 测试靠这一行知道端口。用 0 让内核分配，避免并行测试抢端口
  process.stdout.write(`READY ${server.address().port}\n`)
})

// 收到 SIGTERM 时**关闭数据库再退出** —— 直接 exit 会让 SQLite 文件句柄
// 由内核回收，Windows 下随后的 rmSync 会 EPERM
const shutdown = () => {
  server.close(() => {
    chat.close()
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('message', (message) => {
  if (message === 'shutdown') shutdown()
})
