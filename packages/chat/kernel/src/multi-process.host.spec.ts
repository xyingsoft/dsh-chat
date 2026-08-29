/**
 * 真正的两个 host 进程 + 一个 relay 进程。
 *
 * §43 的骨架要求两个 host 实例与一个 relay。此前的集成测试把它们放在同一个
 * 进程里 ——「两个实例」实际是同一进程内的两个用户身份，那验证不了：
 *
 * - **跨进程持久化**：relay 的写入对另一个进程可见，不是靠共享内存
 * - **host 本地缓存与 relay 共享状态是两份数据**：两个 host 各有自己的
 *   SQLite 文件，收到的消息落在自己那份里
 * - **relay 重启后 host 仍能继续**：关掉 relay 进程再起一个新的
 *
 * 这里起的是**三个真实 OS 进程**，通过 HTTP 与各自的 SQLite 文件通信。
 *
 * ## 仍然没有覆盖的
 *
 * host 进程直接调 relay 的 HTTP 接口，而不是通过一个「relay 客户端」抽象 ——
 * 那一层在 P0-a 尚未实现。写在这里免得这份测试被读成「架构已完整」。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const RELAY_SCRIPT = join(here, 'multi-process', 'relay-process.mjs')
const HOST_SCRIPT = join(here, 'multi-process', 'host-process.mjs')
const repoRoot = resolve(here, '../../../..')

let workDir: string
let relay: ChildProcess | undefined
let relayUrl: string

/**
 * 起一个 relay 进程，等它打印端口。
 *
 * 用「等 READY 行」而不是「sleep 一秒」：后者在慢机器上会 flaky，
 * 在快机器上白等。
 */
function startRelay(dbPath: string): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [RELAY_SCRIPT, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectPromise(new Error(`relay 未在 15 秒内就绪。stderr:\n${stderr}`))
    }, 15_000)

    let buffered = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const match = /^READY (\d+)$/m.exec(buffered)
      if (match === null) return
      clearTimeout(timer)
      resolvePromise({ child, url: `http://127.0.0.1:${match[1]}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectPromise(new Error(`relay 提前退出，code=${code}。stderr:\n${stderr}`))
    })
  })
}

/** 跑一个 host 进程到结束，返回它打印的 JSON。 */
function runHost(localDb: string, action: string, ...args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [HOST_SCRIPT, localDb, relayUrl, action, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('exit', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`host 进程退出 code=${code}\nstdout:${stdout}\nstderr:${stderr}`))
        return
      }
      try {
        resolvePromise(JSON.parse(stdout.trim()) as Record<string, unknown>)
      } catch (error) {
        rejectPromise(new Error(`host 输出不是 JSON：${stdout}\n${String(error)}`))
      }
    })
  })
}

async function stopRelay(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return
  await new Promise<void>((resolvePromise) => {
    child.once('exit', () => resolvePromise())
    child.kill('SIGTERM')
    // Windows 上 SIGTERM 不总能送达，兜底强杀
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
      resolvePromise()
    }, 5000)
  })
}

beforeAll(async () => {
  // dist 是三个进程共同的输入。缺了就明确报错而不是静默跳过 ——
  // 「测试没跑」和「测试通过了」在 CI 摘要里长得一样
  expect(
    existsSync(join(repoRoot, 'packages', 'chat', 'host', 'dist', 'storage', 'database.js')),
    'dist 不存在。先跑 `yarn check:types`（它会 tsc --build 出 dist），再跑测试。',
  ).toBe(true)

  workDir = mkdtempSync(join(tmpdir(), 'dsh-chat-multiproc-'))
  const started = await startRelay(join(workDir, 'relay.db'))
  relay = started.child
  relayUrl = started.url
}, 30_000)

afterAll(async () => {
  await stopRelay(relay)
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('三进程投递', () => {
  it('host A 发送，host B 在另一个进程里收到', async () => {
    const sent = await runHost(join(workDir, 'host-a.db'), 'send', 'msg-1', '跨进程的你好')
    expect(sent['relayStatus']).toBe(200)
    expect(sent['stateAfterRequest']).toBe('accepted')
    expect(sent['deliverySeq']).toBe(1)

    const received = await runHost(join(workDir, 'host-b.db'), 'receive')
    expect(received['pulled']).toEqual([{ messageId: 'msg-1', body: '跨进程的你好' }])
    expect(received['acked']).toBe(1)
  }, 30_000)

  it('发送方在网络请求之前就是 pending（§4 三态的第一态）', async () => {
    // 先本地保存再发请求。反过来的话，进程在请求发出后、响应回来前崩溃，
    // 这条消息就彻底消失了
    const sent = await runHost(join(workDir, 'host-a.db'), 'send', 'msg-2', '第二条')
    expect(sent['stateBeforeRequest']).toBe('pending')
    expect(sent['stateAfterRequest']).toBe('accepted')
  }, 30_000)

  it('host 本地库与 relay 库是两份数据', async () => {
    // 这是「host 本地持久化缓存」与「relay 共享状态」的分界。
    // host A 从没收过消息，它的本地库里就不该有
    const a = await runHost(join(workDir, 'host-a.db'), 'local-count')
    const b = await runHost(join(workDir, 'host-b.db'), 'local-count')
    expect(a['localCount']).toBe(0)
    expect(b['localCount']).toBeGreaterThan(0)
  }, 30_000)

  it('已 ACK 的消息不会被重复投递给同一 host', async () => {
    // 第一条已在前面的用例里 ACK 过
    const again = await runHost(join(workDir, 'host-b.db'), 'receive')
    expect((again['pulled'] as unknown[]).map((m) => (m as { messageId: string }).messageId)).not.toContain(
      'msg-1',
    )
  }, 30_000)

  it('跨进程幂等：同一 messageId 重发不产生第二条', async () => {
    const first = await runHost(join(workDir, 'host-a.db'), 'send', 'msg-dup', '重复的')
    const second = await runHost(join(workDir, 'host-a.db'), 'send', 'msg-dup', '重复的')
    expect(second['deliverySeq']).toBe(first['deliverySeq'])
  }, 30_000)
})

describe('relay 进程重启', () => {
  it('重启后队列与已 ACK 状态都还在', async () => {
    // 与「同进程内关闭重开数据库」不同：这里 relay 是另一个 OS 进程，
    // 杀掉它再起一个新的
    const dbPath = join(workDir, 'relay.db')

    await runHost(join(workDir, 'host-a.db'), 'send', 'msg-survive', '重启前发的')

    await stopRelay(relay)
    const restarted = await startRelay(dbPath)
    relay = restarted.child
    relayUrl = restarted.url

    const received = await runHost(join(workDir, 'host-b.db'), 'receive')
    const ids = (received['pulled'] as Array<{ messageId: string }>).map((m) => m.messageId)
    expect(ids).toContain('msg-survive')
    // 重启前已 ACK 的那条不会复活
    expect(ids).not.toContain('msg-1')
  }, 60_000)
})
