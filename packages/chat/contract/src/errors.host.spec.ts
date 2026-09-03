/**
 * 错误码目录与文档的一致性测试。
 *
 * 这不是普通的单元测试 —— 它反向解析 `docs/archive/03-details/06-contracts-and-conventions.md`
 * §46 的表格，逐条与 `errors.ts` 核对。任何一方改动而另一方未跟上，测试都会失败。
 *
 * 这是「文档先行」在 CI 层面的机械保障：`errors.ts` 由文档生成，本测试确保它不会
 * 因为有人图省事直接改代码而与文档脱节。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { ERROR_CATALOGUE, type ErrorCode, isAutoRetryForbidden } from './errors.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const docPath = join(repoRoot, 'docs', 'archive', '03-details', '06-contracts-and-conventions.md')

interface DocRow {
  code: string
  http: number
  category: string
  retryability: string
  idempotency: string
}

/** 从 §46 的表格中解析出每一行。解析不到 32 行即视为文档结构变了，测试应当失败。 */
function parseDocCatalogue(): DocRow[] {
  const markdown = readFileSync(docPath, 'utf8')
  const section = markdown.split('## 46. 错误码目录')[1]?.split('## 47.')[0]
  if (!section) throw new Error('在文档中找不到 §46 错误码目录')

  const pattern =
    /^\|\s*`([A-Z_]+)`\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(retryable|conditional|terminal)\s*\|\s*([^|]+?)\s*\|$/

  const rows: DocRow[] = []
  for (const line of section.split(/\r?\n/)) {
    const match = pattern.exec(line)
    if (!match) continue
    rows.push({
      code: match[1]!,
      http: Number(match[2]!),
      category: match[3]!,
      retryability: match[4]!,
      idempotency: match[5]!,
    })
  }
  return rows
}

const docRows = parseDocCatalogue()

it('文档中的错误码数量与代码一致', () => {
  expect(docRows.length).toBeGreaterThan(0)
  expect(Object.keys(ERROR_CATALOGUE)).toHaveLength(docRows.length)
})

it('错误码集合与文档完全一致，无多余也无遗漏', () => {
  const inDoc = docRows.map((row) => row.code).sort()
  const inCode = Object.keys(ERROR_CATALOGUE).sort()
  expect(inCode).toEqual(inDoc)
})

it('每条错误码的 HTTP 映射、可重试性、分类与幂等语义都与文档逐字一致', () => {
  for (const row of docRows) {
    const definition = ERROR_CATALOGUE[row.code as ErrorCode]
    expect(definition, `文档中的 ${row.code} 在代码中不存在`).toBeDefined()
    expect(definition, `${row.code} 与文档不一致`).toEqual({
      http: row.http,
      retryability: row.retryability,
      category: row.category,
      idempotency: row.idempotency,
    })
  }
})

it('两条领域状态码刻意映射为 200，不是笔误', () => {
  // 文档：它们是被正常返回的领域状态而非请求失败，调用方按状态机处理
  const mappedTo200 = Object.entries(ERROR_CATALOGUE)
    .filter(([, definition]) => definition.http === 200)
    .map(([code]) => code)
    .sort()
  expect(mappedTo200).toEqual(['ATTACHMENT_UNAVAILABLE', 'SANDBOX_QUOTA_EXCEEDED'])
})

it('terminal 错误禁止异步任务自动重试', () => {
  expect(isAutoRetryForbidden('FORBIDDEN')).toBe(true)
  expect(isAutoRetryForbidden('VERSION_CONFLICT')).toBe(false)
  expect(isAutoRetryForbidden('RATE_LIMITED')).toBe(false)
})

it('可重试性取值只能是文档定义的三种', () => {
  const allowed = new Set(['retryable', 'conditional', 'terminal'])
  for (const [code, definition] of Object.entries(ERROR_CATALOGUE)) {
    expect(allowed.has(definition.retryability), `${code} 的可重试性非法`).toBe(true)
  }
})
