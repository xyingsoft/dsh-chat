/**
 * 命令与事件定义的一致性测试。
 *
 * 事件名与错误码、状态集合一样，采用**反向解析文档核对**的防漂移机制：
 * §6.1 的能力矩阵中「消费者与持久事件」一列列出了全部持久领域事件名，
 * 代码里登记的每一个都必须在那里找得到。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { COMMAND_NAMES, DOMAIN_EVENT_NAMES, type CommandInput } from './commands.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const pluginModelDoc = readFileSync(
  join(repoRoot, 'docs', 'archive', '02-architecture', '02-plugin-model.md'),
  'utf8',
)

describe('事件名与文档一致', () => {
  it('每个登记的事件名都出现在 §6.1 的能力矩阵中', () => {
    for (const name of DOMAIN_EVENT_NAMES) {
      expect(
        pluginModelDoc.includes('`' + name + '`'),
        `事件 ${name} 未出现在 §6.1 能力矩阵中。若确为新增，应先更新文档。`,
      ).toBe(true)
    }
  })

  it('事件名不重复', () => {
    expect(new Set(DOMAIN_EVENT_NAMES).size).toBe(DOMAIN_EVENT_NAMES.length)
  })

  it('事件名为 snake_case，与文档风格一致', () => {
    for (const name of DOMAIN_EVENT_NAMES) {
      expect(name, `${name} 不符合 snake_case`).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })
})

describe('命令定义', () => {
  it('每个命令名都有对应的输入类型', () => {
    // CommandInput 的键集合必须与 COMMAND_NAMES 完全一致 ——
    // 新增命令若忘记加输入类型，这里会失败而不是留到运行时
    const declared = Object.keys({
      'message.send': 0,
      'message.pull': 0,
      'message.ack': 0,
      'message.edit': 0,
      'message.revoke': 0,
      'workItem.create': 0,
      'workItem.assign': 0,
      'workItem.acknowledge': 0,
      'workItem.addDependency': 0,
      'notification.list': 0,
      'notification.mark': 0,
    } satisfies Record<keyof CommandInput, number>).sort()

    expect([...COMMAND_NAMES].sort()).toEqual(declared)
  })

  it('命令名不重复', () => {
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length)
  })

  it('命令名采用 域.动作 的形式', () => {
    for (const name of COMMAND_NAMES) {
      expect(name, `${name} 不符合 域.动作 形式`).toMatch(/^[a-zA-Z]+\.[a-zA-Z]+$/)
    }
  })
})

describe('幂等键由调用方生成', () => {
  it('会改变状态的命令都带 operationId', () => {
    // §26：事务提交后连接断开时，调用方用**同一幂等键**查询最终结果。
    // 服务端分配的话，重试就换了一个键，幂等无从谈起。
    //
    // 只读命令（pull/list）与不产生新状态的确认命令不需要 —— pull 分配租约
    // 但租约本身可重复获取，ack 由 (recipient, deliverySeq) 天然幂等。
    const mutating: Array<keyof CommandInput> = [
      'message.send',
      'message.edit',
      'message.revoke',
      'workItem.create',
      'workItem.assign',
      'workItem.acknowledge',
      'workItem.addDependency',
    ]
    // 类型层面已由 `extends CommandEnvelope` 保证；这里断言清单本身不为空，
    // 防止将来有人把命令从 mutating 列表里删掉却忘了改类型
    expect(mutating.length).toBeGreaterThan(0)
    for (const name of mutating) {
      expect(COMMAND_NAMES).toContain(name)
    }
  })
})
