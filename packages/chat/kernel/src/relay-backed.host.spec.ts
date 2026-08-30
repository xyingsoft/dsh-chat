/**
 * 插件经 relay 工作的端到端验收。
 *
 * 这是「plugin ↔ relay 已接通」的证据。此前 relay 仓库拆出来了，但插件仍直接
 * 调本地领域代码 —— 两份代码并行存在却从不对话，那种「拆分」只是复制。
 *
 * 这里起**真实的 relay 进程**，让插件以 relay 模式装载，然后从浏览器视角
 * （HTTP 打 host 的同源 API）走一遍读写，最后回 relay 的库里核对数据确实
 * 落在了那一侧。
 *
 * ## 账号是真开出来的
 *
 * 第一版把账号直接写进 relay 的库，因为那时候还没有开户端点。现在走完整的
 * 引导链路：relay 用 `DSH_CHAT_RELAY_BOOTSTRAP_INVITE` 签出第一张邀请码，
 * host 用它注册、本地生成密钥对、拿到 token。往下的每个业务请求都是 token
 * 认证的。
 *
 * 这条链路值得端到端跑一遍而不是各测各的：中间任何一环（码签发的组织、
 * 凭据落盘的位置、token 进不进请求头）单看都对，串起来错位一格就全不通。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import * as hostPlugin from '../../host/src/index.js'
import { CredentialStore } from '../../host/src/identity/credentials.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const RELAY_ENTRY = resolve(repoRoot, '..', 'dsh-chat-relay', 'dist', 'bin.js')

const SECRET = 'e2e-shared-secret-0123456789'
/** relay 引导时建的组织。开出来的账号就落在这里。 */
const ORG = 'org-bootstrap'
const BOOTSTRAP_INVITE = 'e2e-bootstrap-invite-code'

let workDir: string
let relayProcess: ChildProcess | undefined
let relayPort = 0
let relayDb = ''
let ctx: Context
let baseUrl: string
let account: { accountId: string; deviceId: string }

/**
 * 起 relay 进程，等它打印监听地址。
 *
 * 等输出而不是 sleep：后者在慢机器上 flaky，在快机器上白等。
 */
function startRelay(): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [RELAY_ENTRY], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DSH_CHAT_RELAY_SECRET: SECRET,
        DSH_CHAT_RELAY_DB: relayDb,
        DSH_CHAT_RELAY_HOST: '127.0.0.1',
        // 0 让内核分配，避免并行测试抢端口
        DSH_CHAT_RELAY_PORT: '0',
        // 全新的库里一条账号都没有，签不出邀请码，也就开不了户。
        // 这个变量解开那个死锁，且在第一个人开完户之后自动失效
        DSH_CHAT_RELAY_BOOTSTRAP_INVITE: BOOTSTRAP_INVITE,
      },
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectPromise(new Error(`relay 未在 20 秒内就绪。stderr:\n${stderr}`))
    }, 20_000)

    let buffered = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buffered)
      if (match === null) return
      clearTimeout(timer)
      resolvePromise({ child, port: Number(match[1]) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectPromise(new Error(`relay 提前退出 code=${code}。stderr:\n${stderr}`))
    })
  })
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function dataOf<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { data: T }
  return body.data
}

beforeAll(async () => {
  // relay 的 dist 是这场测试的输入。缺了就明确报错而不是静默跳过 ——
  // 「测试没跑」和「测试通过了」在 CI 摘要里长得一样
  expect(
    existsSync(RELAY_ENTRY),
    `找不到 relay 产物：${RELAY_ENTRY}\n` +
      '先在 ../dsh-chat-relay 里跑 `yarn build`。两个仓库并列存放时这条才成立。',
  ).toBe(true)

  workDir = mkdtempSync(join(tmpdir(), 'dsh-relay-e2e-'))
  relayDb = join(workDir, 'relay.db')

  const started = await startRelay()
  relayProcess = started.child
  relayPort = started.port

  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${ctx.webServer.port}`

  await ctx.plugin(hostPlugin, {
    organizationId: ORG,
    // 还没开户时用的本地身份。开完户之后 host 以凭据里的账号为准，
    // 这个值就不再参与判定 —— 下面有一条测试专门盯住这一点
    localAccountId: 'not-yet-enrolled',
    localDeviceId: 'jia-desktop',
    // host 自己的库仍然要开（服务的生命周期），但业务读写都会走 relay
    databasePath: join(workDir, 'host.db'),
    relayUrl: `http://127.0.0.1:${relayPort}`,
    relaySharedSecret: SECRET,
  })

  // 协商是 apply() 里不 await 发起的，这里等它落定再开始断言
  await new Promise((r) => setTimeout(r, 300))

  // 走真实开户。失败就让整场测试在这里停住 —— 往下每一条都依赖它
  const enrolled = await post('/api/chat/identity/enroll', {
    inviteCode: BOOTSTRAP_INVITE,
    displayName: '甲',
    deviceName: '甲的桌面端',
  })
  expect(enrolled.status, `开户失败：${await enrolled.clone().text()}`).toBe(200)
  account = await dataOf<{ accountId: string; deviceId: string }>(enrolled)
}, 60_000)

afterAll(async () => {
  await ctx?.fiber.dispose()
  if (relayProcess !== undefined && relayProcess.exitCode === null) {
    await new Promise<void>((r) => {
      relayProcess?.once('exit', () => r())
      relayProcess?.kill('SIGTERM')
      setTimeout(() => r(), 5000)
    })
  }
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('开户是真开出来的', () => {
  it('账号与设备在 relay 的库里', async () => {
    const inRelay = new DatabaseSync(relayDb, { readOnly: true })
    const acct = inRelay
      .prepare('SELECT display_name FROM accounts WHERE account_id = ?')
      .get(account.accountId) as { display_name: string } | undefined
    const device = inRelay
      .prepare('SELECT device_name FROM devices WHERE device_id = ?')
      .get(account.deviceId) as { device_name: string } | undefined
    inRelay.close()

    expect(acct?.display_name).toBe('甲')
    expect(device?.device_name).toBe('甲的桌面端')
  })

  it('设备私钥没有出现在 relay 的库里', async () => {
    // §7 的「私钥永不上传」。整个库 dump 出来找，比逐表逐列检查更难被绕过
    const store = new CredentialStore(join(workDir, 'dsh-chat.credentials.json'))
    const local = store.read()
    expect(local?.signingPrivateKey.length).toBeGreaterThan(0)

    const inRelay = new DatabaseSync(relayDb, { readOnly: true })
    const tables = inRelay
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
    let dump = ''
    for (const { name } of tables) {
      dump += JSON.stringify(inRelay.prepare(`SELECT * FROM "${name}"`).all())
    }
    inRelay.close()

    expect(dump).not.toContain(local?.signingPrivateKey)
    // 公钥反过来必须在 —— 否则说明注册压根没提交它，上一条就成了空断言
    expect(dump).toContain(local?.signingPublicKey)
  })

  it('token 在 relay 那边只存哈希', async () => {
    const local = new CredentialStore(join(workDir, 'dsh-chat.credentials.json')).read()
    const inRelay = new DatabaseSync(relayDb, { readOnly: true })
    const sessions = JSON.stringify(inRelay.prepare('SELECT * FROM device_sessions').all())
    inRelay.close()

    expect(sessions).not.toContain(local?.accessToken)
    expect(sessions).not.toContain(local?.refreshToken)
  })

  it('引导码用掉之后失效，同一张码开不出第二个户', async () => {
    const again = await post('/api/chat/identity/enroll', {
      inviteCode: BOOTSTRAP_INVITE,
      displayName: '乙',
      deviceName: '乙的机器',
    })
    expect(again.status).toBe(404)
  })

  it('状态端点报的是 relay 签发的账号，不是配置里那个占位值', async () => {
    // 配置里写的是 not-yet-enrolled。开完户还报它的话，说明 host 这边
    // 认的「谁」和 relay 认的不是同一个人
    const status = await dataOf<{ mode: string; accountId: string }>(
      await post('/api/chat/identity/status', {}),
    )
    expect(status.mode).toBe('enrolled')
    expect(status.accountId).toBe(account.accountId)
    expect(status.accountId).not.toBe('not-yet-enrolled')
  })
})

describe('浏览器视角不变', () => {
  it('打的还是同一个同源 API', async () => {
    // §4：浏览器只与 host 的同源 API 通信，不直接与 relay 通信。
    // 换后端对浏览器应当完全透明
    const response = await post('/api/chat/conversations', {})
    expect(response.status).toBe(200)
  })

  it('健康检查仍由 host 本地应答', async () => {
    // 它报的是「这个插件活着」，不是「relay 活着」。混为一谈会让 relay
    // 挂掉时健康检查也跟着挂，分不清是插件问题还是后端问题
    const response = await fetch(`${baseUrl}/api/chat/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', plugin: 'dsh-chat-host' })
  })

  it('跨源写请求仍被 host 挡住', async () => {
    // 转发不该顺带把跨源防护丢掉
    const response = await fetch(`${baseUrl}/api/chat/messages`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(403)
  })
})

describe('数据落在 relay 那一侧', () => {
  it('经 host 创建的组织出现在 relay 的库里，而不是 host 的库', async () => {
    const created = await post('/api/organization', {
      name: '经 relay 创建的组织',
      operationId: 'op-relay-1',
    })
    expect(created.status).toBe(200)
    const body = await dataOf<{ organization: { organizationId: string } }>(created)
    const newOrg = body.organization.organizationId

    // relay 的库里有
    const inRelay = new DatabaseSync(relayDb, { readOnly: true })
    const relayRow = inRelay
      .prepare('SELECT name FROM organizations WHERE organization_id = ?')
      .get(newOrg) as { name: string } | undefined
    inRelay.close()
    expect(relayRow?.name).toBe('经 relay 创建的组织')

    // host 的库里没有 —— 这条才真正证明「拆开了」，
    // 否则可能只是两边都写了一份
    const inHost = new DatabaseSync(join(workDir, 'host.db'), { readOnly: true })
    const hostRow = inHost
      .prepare('SELECT COUNT(*) AS c FROM organizations')
      .get() as { c: number }
    inHost.close()
    expect(hostRow.c).toBe(0)
  })
})

describe('错误码穿过 relay 后仍然是同一个', () => {
  it('未建立联系人时发消息，浏览器拿到的仍是 NOT_FOUND_OR_FORBIDDEN', async () => {
    // 错误码目录是两侧共享的。转发过程中被翻译或吞掉的话，
    // 客户端的可重试性判断就全错了
    const response = await post('/api/chat/messages', {
      messageId: 'msg-relay-1',
      recipientId: 'yi',
      body: '还没加好友',
      operationId: 'op-relay-msg-1',
    })
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: string; retryability: string } }
    expect(body.error.code).toBe('NOT_FOUND_OR_FORBIDDEN')
    expect(body.error.retryability).toBe('terminal')
  })
})

describe('relay 不可达时的表现', () => {
  it('杀掉 relay 后请求返回可重试错误，而不是假装成功或挂死', async () => {
    // §41 禁止静默降级。relay 没了就该明确报出来，
    // 不能回落到本地库假装一切正常 —— 那会让两边的数据分叉
    await new Promise<void>((r) => {
      relayProcess?.once('exit', () => r())
      relayProcess?.kill('SIGTERM')
      setTimeout(() => r(), 5000)
    })

    const response = await post('/api/chat/conversations', {})
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string; retryability: string } }
    expect(body.error.code).toBe('SERVICE_READ_ONLY')
    expect(body.error.retryability).toBe('retryable')
  }, 30_000)
})
