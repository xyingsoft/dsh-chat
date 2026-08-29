/**
 * 状态集合与文档的一致性测试。
 *
 * 对 `states.ts` 中登记的每一组状态，在全部 `docs/` 中查找与之**完全匹配的连续枚举**。
 * 文档对状态的措辞并不统一（有「状态为 …」「具有 … 状态」「签收状态 …」等多种），
 * 所以这里不匹配句式，只匹配「一串被 `、` 或 `或` 分隔的反引号值」这一稳定结构。
 *
 * 匹配要求顺序一致 —— 文档里的顺序本身携带信息（例如工作项状态大致按生命周期排列），
 * 乱序会掩盖「照抄时漏了一个又补在末尾」这类错误。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { ALL_STATE_SETS } from './states.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const docsDir = join(repoRoot, 'docs')

function collectMarkdown(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...collectMarkdown(full))
    else if (entry.endsWith('.md')) files.push(full)
  }
  return files
}

const corpus = collectMarkdown(docsDir)
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')

/** 构造匹配「`a`、`b` 或 `c`」这类连续枚举的正则，允许分隔符处出现空白。 */
function enumerationPattern(values: readonly string[]): RegExp {
  const body = values.map((value) => '`' + value + '`').join('\\s*(?:、|或|,|，)\\s*')
  return new RegExp(body)
}

it('登记表非空，且每组至少 3 个状态', () => {
  const entries = Object.entries(ALL_STATE_SETS)
  expect(entries.length).toBeGreaterThan(0)
  for (const [name, values] of entries) {
    expect(values.length, `${name} 状态数过少，疑似漏抄`).toBeGreaterThanOrEqual(3)
  }
})

it.each(Object.entries(ALL_STATE_SETS))(
  '%s 与文档中的枚举逐字一致且顺序相同',
  (name, values) => {
    const pattern = enumerationPattern(values)
    expect(
      pattern.test(corpus),
      `在 docs/ 中找不到与 ${name} 完全匹配的连续枚举。\n` +
        `代码中的取值与顺序：${values.join('、')}\n` +
        `若文档确实变更，应先更新文档再同步本文件。`,
    ).toBe(true)
  },
)

it('各组内部没有重复取值', () => {
  for (const [name, values] of Object.entries(ALL_STATE_SETS)) {
    expect(new Set(values).size, `${name} 存在重复取值`).toBe(values.length)
  }
})

it('状态取值均为文档使用的 snake_case 风格', () => {
  for (const [name, values] of Object.entries(ALL_STATE_SETS)) {
    for (const value of values) {
      expect(value, `${name} 的 ${value} 不符合 snake_case`).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  }
})
