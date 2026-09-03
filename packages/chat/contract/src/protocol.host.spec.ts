/**
 * 协议版本协商的测试。
 *
 * §41 的核心约束是**不得静默降级**：协商失败必须是一个明确的失败状态，
 * 不能退化成「部分可用」。这里的多数用例都在验证这一点的各种表现形式。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ERROR_CATALOGUE } from './errors.js'
import { PROTOCOL_VERSION } from './persistence.js'
import {
  negotiate,
  upgradeHint,
  type ProtocolCapability,
  type ProtocolOffer,
} from './protocol.js'
import type { ProtocolVersion } from './index.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const opsDoc = readFileSync(
  join(repoRoot, 'docs', 'archive', '03-details', '05-observability-and-ops.md'),
  'utf8',
)

const v = (n: number): ProtocolVersion => n as ProtocolVersion

function relay(overrides: Partial<ProtocolCapability> = {}): ProtocolCapability {
  return {
    currentVersion: v(5),
    minimumVersion: v(3),
    eventFormatVersions: { message_accepted: 2, work_item_changed: 1 },
    ...overrides,
  }
}

function host(version: number, formats: Record<string, number> = {}): ProtocolOffer {
  return { protocolVersion: v(version), eventFormatVersions: formats }
}

describe('版本判定', () => {
  it('同版本协商通过，无弃用提示', () => {
    const result = negotiate(host(5), relay())
    expect(result.accepted).toBe(true)
    expect(result.outcome.kind).toBe('current')
    expect(result.deprecationDeadline).toBeUndefined()
    expect(upgradeHint(result)).toBeUndefined()
  })

  it('host 较旧但在窗口内：通过，且带出弃用截止时间', () => {
    // 这是「兼容但需要提醒」—— 若压成 accepted 布尔值，截止时间就无处安放，
    // 用户会在窗口结束当天才发现写入停了
    const result = negotiate(host(4), relay({ deprecationDeadline: '2026-12-01T00:00:00Z' }))
    expect(result.accepted).toBe(true)
    expect(result.outcome.kind).toBe('deprecated')
    expect(result.deprecationDeadline).toBe('2026-12-01T00:00:00Z')
    expect(upgradeHint(result)).toContain('2026-12-01T00:00:00Z')
  })

  it('host 低于最低支持版本：拒绝', () => {
    const result = negotiate(host(2), relay())
    expect(result.accepted).toBe(false)
    expect(result.outcome.kind).toBe('host_too_old')
  })

  it('边界：恰好等于最低支持版本时通过', () => {
    // 「最低**支持**版本」是闭区间。写成开区间会让文档承诺的兼容窗口
    // 实际少一个版本
    const result = negotiate(host(3), relay())
    expect(result.accepted).toBe(true)
  })

  it('host 高于 relay 当前版本：拒绝，且指向服务端', () => {
    // §41：升级顺序固定为 relay 先升、host 后升。出现这个方向说明部署顺序被违反
    const result = negotiate(host(6), relay())
    expect(result.accepted).toBe(false)
    expect(result.outcome.kind).toBe('relay_too_old')
    expect(upgradeHint(result)).toContain('升级服务端')
  })

  it('版本比较是整数比较，不受字符串序影响', () => {
    // §41 规定 ProtocolVersion 是单调递增整数。若它是字符串，
    // '1.10' < '1.9' 会让第 10 个版本被判定为比第 9 个旧
    const result = negotiate(host(10), relay({ currentVersion: v(10), minimumVersion: v(9) }))
    expect(result.accepted).toBe(true)
    expect(result.outcome.kind).toBe('current')
  })
})

describe('事件格式协商', () => {
  it('每个事件取两侧较小值', () => {
    const result = negotiate(
      host(5, { message_accepted: 3, work_item_changed: 1 }),
      relay(),
    )
    // relay 的 message_accepted 是 2，host 是 3 —— 只能按 2 投递
    expect(result.agreedEventFormats).toEqual({ message_accepted: 2, work_item_changed: 1 })
  })

  it('只有一侧声明的事件不进入交集', () => {
    // relay 独有的事件若投给不认识它的 host，host 只能丢弃或崩溃
    const result = negotiate(host(5, { message_accepted: 2, unknown_event: 9 }), relay())
    expect(result.agreedEventFormats).not.toHaveProperty('unknown_event')
    expect(result.agreedEventFormats).not.toHaveProperty('work_item_changed')
  })

  it('协商失败时不返回任何事件格式', () => {
    // 给了会让调用方误以为可以开始投递 —— 这正是「部分可用状态」
    const result = negotiate(host(2, { message_accepted: 2 }), relay())
    expect(result.accepted).toBe(false)
    expect(result.agreedEventFormats).toEqual({})
  })
})

describe('不得静默降级', () => {
  it('失败结果对应的错误码是 terminal，不可重试', () => {
    // §41：host 显示明确的升级提示并停止组织写入。
    // 若错误码可重试，客户端就会自动重试，等于静默降级成「时好时坏」
    const entry = ERROR_CATALOGUE.PROTOCOL_VERSION_UNSUPPORTED
    expect(entry.retryability).toBe('terminal')
    expect(entry.http).toBe(426)
  })

  it('每种失败都给出可操作的提示，且说明写入已停止', () => {
    for (const hostVersion of [2, 6]) {
      const hint = upgradeHint(negotiate(host(hostVersion), relay()))
      expect(hint, `v${hostVersion} 应有升级提示`).toBeDefined()
      expect(hint).toContain('组织写入已停止')
    }
  })

  it('提示里指明了要升级哪一边', () => {
    // 「协议版本不兼容」这种话用户读了也不知道要做什么
    expect(upgradeHint(negotiate(host(2), relay()))).toContain('升级本机')
    expect(upgradeHint(negotiate(host(6), relay()))).toContain('升级服务端')
  })
})

describe('与文档一致', () => {
  it('§41 确实规定协议版本为单调递增整数', () => {
    expect(opsDoc).toContain('`ProtocolVersion`（单调递增整数）')
    expect(Number.isInteger(PROTOCOL_VERSION as unknown as number)).toBe(true)
  })

  it('§41 确实规定协商失败返回 PROTOCOL_VERSION_UNSUPPORTED', () => {
    expect(opsDoc).toContain('协商失败返回 `PROTOCOL_VERSION_UNSUPPORTED`')
  })

  it('§41 要求 relay 返回四项：结果、当前版本、最低版本、弃用截止时间', () => {
    expect(opsDoc).toContain('relay 返回协商结果、服务端当前版本、最低支持版本和弃用截止时间')
    const result = negotiate(host(4), relay({ deprecationDeadline: '2026-12-01T00:00:00Z' }))
    expect(result.outcome).toBeDefined()
    expect(result.serverVersion).toBe(5)
    expect(result.minimumVersion).toBe(3)
    expect(result.deprecationDeadline).toBe('2026-12-01T00:00:00Z')
  })
})
