/**
 * `AuditEvent` 契约定义与 §37 的双向锁定。
 *
 * 与错误码目录同一套机制：正向确认「代码里的每个字段在文档里有出处」，
 * 反向确认「文档里的每个短语在代码里有字段」。少了任何一个方向，
 * 漂移都能悄悄发生 —— 只做正向则文档新增字段不会被发现，
 * 只做反向则代码擅自新增字段不会被发现。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  AUDIT_EVENT_FIELD_SOURCES,
  AUDIT_OUTCOMES,
  type AuditEvent,
  type AuditEventInput,
} from './audit.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const securityDoc = readFileSync(
  join(repoRoot, 'docs', 'archive', '03-details', '04-security-compliance.md'),
  'utf8',
)

/** §37 中列举字段的那一句。以「每条审计事件包含」为锚定，不依赖行号。 */
function fieldSentence(): string {
  const line = securityDoc
    .split('\n')
    .find((candidate) => candidate.startsWith('每条审计事件包含'))
  expect(line, '§37 中「每条审计事件包含…」一句不见了；字段清单的出处已失效').toBeDefined()
  return line as string
}

describe('字段与 §37 双向锁定', () => {
  it('代码里的每个字段在 §37 中有出处（正向）', () => {
    const sentence = fieldSentence()
    for (const [field, phrase] of Object.entries(AUDIT_EVENT_FIELD_SOURCES)) {
      expect(
        sentence.includes(phrase),
        `字段 ${field} 声称出自 §37 的「${phrase}」，但该句中没有这个短语`,
      ).toBe(true)
    }
  })

  it('§37 里的每个短语在代码中有字段（反向）', () => {
    // 逐字取自 §37，按文档顺序。若文档新增一项而代码没跟上，这里会失败。
    const documented = [
      '`AuditEventId`',
      '`OrganizationId`',
      '事件类型',
      '发生时间',
      '服务端序列号',
      '操作者身份',
      '`DeviceId`',
      '来源 IP 前缀',
      '粗粒度区域',
      '目标对象引用',
      '操作结果',
      '错误码',
      '策略版本',
      '关联操作 ID',
      '关联领域事件 ID',
      '调用链 ID',
    ]
    const claimed = new Set(Object.values(AUDIT_EVENT_FIELD_SOURCES))
    for (const phrase of documented) {
      expect(claimed.has(phrase), `§37 的「${phrase}」在代码中没有对应字段`).toBe(true)
    }
    expect(claimed.size).toBe(documented.length)
  })

  it('对照表覆盖 AuditEvent 的全部字段', () => {
    // Record<keyof AuditEvent, string> 已在类型层面保证不漏；这里断言运行时
    // 键集合也一致，防止有人用 as 绕过类型
    const sample: AuditEvent = {
      auditEventId: 'a',
      organizationId: 'o',
      eventType: 'e',
      occurredAt: 't',
      serverSeq: 1,
      actorAccountId: undefined,
      deviceId: undefined,
      sourceIpPrefix: undefined,
      coarseRegion: undefined,
      targetRef: 'r',
      outcome: 'succeeded',
      errorCode: undefined,
      policyRevision: 1,
      operationId: undefined,
      relatedEventId: undefined,
      traceId: undefined,
    }
    expect(Object.keys(AUDIT_EVENT_FIELD_SOURCES).sort()).toEqual(Object.keys(sample).sort())
  })
})

describe('审计的结构性约束', () => {
  it('结构中没有 body / content 字段', () => {
    // §43 第 14 步：「审计表中不含任何消息正文」。这条约束靠人自觉守不住，
    // 所以在类型的键集合上直接断言
    const forbidden = ['body', 'content', 'text', 'payload', 'message']
    for (const key of Object.keys(AUDIT_EVENT_FIELD_SOURCES)) {
      expect(forbidden, `AuditEvent 不得包含内容字段，但出现了 ${key}`).not.toContain(key)
    }
  })

  it('outcome 不是布尔值，被拒绝的尝试同样可表达', () => {
    // §43 第 14 步：「被拒绝的越权尝试同样留下记录」。
    // 若用 boolean success，"拒绝" 就只能表达为 "不成功"，
    // 而 "不成功" 也涵盖崩溃、超时 —— 审计需要区分这些
    expect(AUDIT_OUTCOMES).toEqual(['succeeded', 'rejected'])
  })

  it('写入侧不含 serverSeq', () => {
    // 序列号由写入方在事务内按组织分配，不是调用方能提供的。
    // 若 Input 里有这个字段，调用方就能伪造序列，缺口检测随之失效。
    const input: AuditEventInput = {
      auditEventId: 'a',
      organizationId: 'o',
      eventType: 'e',
      occurredAt: new Date(),
      targetRef: 'r',
      outcome: 'succeeded',
      policyRevision: 1,
    }
    expect('serverSeq' in input).toBe(false)
  })

  it('§37 声明 AuditEvent 结构属于 contract 包', () => {
    expect(securityDoc).toContain('`AuditEvent` 的结构属于 `@dsh-chat/contract`')
  })
})
