/**
 * 双用户联调环境：起 relay + 播种测试对手方「乙」。
 *
 * 单机 local 模式下 UI 的会话列表永远是空的 —— 没有第二个账号，就没有
 * 会话可显示。这个脚本补齐那一半：起一个本地 relay，并往库里种一个
 * 固定账号「乙」，供 `bob.mjs` 扮演。
 *
 * ## 为什么乙直接写库而不是走 HTTP
 *
 * relay 只在库为空时签发一张引导邀请码，一码一户（见 dsh-chat-relay 的
 * bootstrap.ts）。甲（Desktop UI）要用掉这张码，乙就没有了；relay 也没有
 * 「已开户者再签码」的 HTTP 端点。而乙是**本机测试进程**，与 relay 共享
 * 同一个 SQLite 文件 —— 直写领域函数（`acceptDirectMessage` 等）与
 * relay 进程处理 HTTP 后走的是同一段代码，这个模式在 kernel 的多进程
 * 验收（multi-process.host.spec.ts）里已经跑通。
 *
 * ## 关于指纹
 *
 * 不设 DSH_CHAT_RELAY_TLS_FINGERPRINT —— 那是给「relay 在反代后面」的
 * 部署防中间人用的。这里 relay 与 host 都在本机回环上，配了只会在两条
 * 签名实现之间引入与测试目标无关的失败面。
 *
 * 用法：node examples/two-users/start-relay.mjs
 * 退出：Ctrl-C（SIGINT）。数据保留在 examples/two-users/data/。
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const relayDist = resolve(repoRoot, '..', 'dsh-chat-relay', 'dist')

// —— 与 README.md、bob.mjs 保持一致的环境常量 ——————————————————————

/** relay 监听端口。固定值：Desktop 侧的 config 依赖它。 */
const RELAY_PORT = 8787
/** 部署期共享密钥。本地联调值，勿用于任何真实部署。 */
const RELAY_SECRET = 'examples-two-users-secret'
/** 引导邀请码。只在 relay 库还没有真实账号时签发；甲用掉后失效。 */
const BOOTSTRAP_INVITE = 'two-users-invite'
/** 引导组织。host 侧配置的 organizationId 必须与它一致。 */
const ORG = 'org-bootstrap'
/** 测试对手方的固定账号。bob.mjs 以这个身份发消息。 */
const BOB_ACCOUNT_ID = 'yi'

const dataDir = join(here, 'data')
const relayDb = join(dataDir, 'relay.db')
mkdirSync(dataDir, { recursive: true })

/**
 * 等 TCP 端口可连 —— relay 监听成功即算就绪。
 *
 * 不解析 relay 的 stdout（bin.ts 打印的文案是给人看的，不是契约），
 * 也不 sleep 固定秒数（慢机器 flaky，快机器白等）。
 */
function waitUntilListening(port, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`端口 ${port} 未在 ${timeoutMs / 1000} 秒内可连。检查 relay 日志。`))
    }, timeoutMs)
    const probe = setInterval(() => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.destroy()
        clearTimeout(timer)
        clearInterval(probe)
        resolvePromise()
      })
      socket.on('error', () => {
        // 还没起来，下一轮再试
      })
    }, 300)
  })
}

// spawn 的模块参数用普通路径而非 file:// URL —— Windows 的 CJS loader
// 不认 URL 形式的入口，会把它拼进 cwd 变成一个不存在的相对路径
const relayBin = join(relayDist, 'bin.js')

const child = spawn(process.execPath, [relayBin], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    DSH_CHAT_RELAY_SECRET: RELAY_SECRET,
    DSH_CHAT_RELAY_DB: relayDb,
    DSH_CHAT_RELAY_HOST: '127.0.0.1',
    DSH_CHAT_RELAY_PORT: String(RELAY_PORT),
    DSH_CHAT_RELAY_BOOTSTRAP_INVITE: BOOTSTRAP_INVITE,
  },
})

const exited = new Promise((_resolve, reject) => {
  child.on('exit', (code) => reject(new Error(`relay 提前退出 code=${code}。检查上方日志。`)))
})

await Promise.race([waitUntilListening(RELAY_PORT, 20_000), exited])

/**
 * 播种乙的账号。幂等（INSERT OR IGNORE）—— 重启环境不报错、不换账号 ID。
 *
 * 只建账号，不建联系人：联系人关系的另一头是甲的账号 ID，而甲要开完户
 * 才有（见 README 的 `bob.mjs contact`）。
 */
const { ChatDatabase } = await import(
  pathToFileURL(join(relayDist, 'storage', 'database.js')).href
)
const chat = ChatDatabase.open({ location: relayDb })
chat.transaction((db) => {
  db.prepare(
    'INSERT OR IGNORE INTO accounts (account_id, display_name, created_at) VALUES (?,?,?)',
  ).run(BOB_ACCOUNT_ID, '乙（联调）', new Date().toISOString())
})
chat.close()

process.stdout.write(
  `
———————————————— 双用户联调环境已就绪 ————————————————

relay：      http://127.0.0.1:${RELAY_PORT}
乙的账号 ID：${BOB_ACCOUNT_ID}
邀请码：     ${BOOTSTRAP_INVITE}（甲在 Desktop 开户面板里输入）

下一步 —— 把下面的 config 填进 packages/chat/kernel/cordis.patch.yml
（替换 chat-host 条目的 config: {}），然后重启 DSH Desktop：

    - id: chat-host
      name: '@dsh-chat/host'
      config:
        organizationId: ${ORG}
        relayUrl: http://127.0.0.1:${RELAY_PORT}
        relaySharedSecret: ${RELAY_SECRET}

在 Desktop 的聊天面板完成开户后，跑：

    node examples/two-users/bob.mjs contact <你的账号ID>

乙就会与你建立联系人并发来第一条消息。详见 examples/two-users/README.md。

Ctrl-C 退出（数据保留在 examples/two-users/data/，删掉即重置）。
———————————————————————————————————————————————————
`,
)

// 转发退出信号给 relay。relay 自己会先关库再退 —— 直接杀进程在 Windows
// 下会让 SQLite 的 journal 句柄来不及释放
process.on('SIGINT', () => child.kill('SIGTERM'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', () => process.exit(0))
