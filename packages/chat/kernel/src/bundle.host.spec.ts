/**
 * kernel bundle 的装载契约测试。
 *
 * `cordis.patch.yml` 中的 `name` 是 Node 可解析的包名。写错一个字符不会报错，
 * 只会让该插件被静默跳过 —— 界面上表现为「功能没了」，日志里什么都没有。
 * 这类失效必须在 CI 阶段挡住，而不是等到装进 DSH 才发现。
 *
 * 见 docs/archive/02-architecture/02-plugin-model.md §6.2。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'
import { parse } from 'yaml'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface LoaderEntry {
  id?: string
  name?: string
  config?: unknown
}

const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  dsh?: { bundle?: { patch?: string } }
}

const patchPath = manifest.dsh?.bundle?.patch
const patch = parse(readFileSync(join(packageRoot, patchPath ?? 'cordis.patch.yml'), 'utf8')) as
  | Array<{ insert?: LoaderEntry[] }>
  | null

const entries: LoaderEntry[] = (patch ?? []).flatMap((row) => row.insert ?? [])

it('package.json 通过 dsh.bundle.patch 指向 cordis.patch.yml', () => {
  expect(patchPath, 'dsh.bundle.patch 缺失，DSH 不会把本包当作 bundle 装载').toBe(
    './cordis.patch.yml',
  )
})

it('补丁文件至少插入一个 loader 条目', () => {
  expect(entries.length).toBeGreaterThan(0)
})

it('每个条目都有 id 与 name', () => {
  for (const entry of entries) {
    expect(entry.id, `条目缺少 id：${JSON.stringify(entry)}`).toBeTruthy()
    expect(entry.name, `条目 ${entry.id} 缺少 name`).toBeTruthy()
  }
})

it('条目 id 不重复', () => {
  const ids = entries.map((entry) => entry.id)
  expect(new Set(ids).size, `存在重复 id：${ids.join(', ')}`).toBe(ids.length)
})

it.each(entries.map((entry) => [entry.id ?? '?', entry.name ?? '?']))(
  '%s 的包名 %s 可被 Node 解析且导出 apply',
  async (id, name) => {
    let module: Record<string, unknown>
    try {
      module = (await import(name)) as Record<string, unknown>
    } catch (error) {
      throw new Error(
        `条目 ${id} 的包名 ${name} 无法解析。DSH 会静默跳过该插件，界面上表现为功能缺失。\n` +
          `原始错误：${String(error)}`,
      )
    }
    expect(typeof module['apply'], `${name} 没有导出 apply，不是合法的 Cordis 插件`).toBe(
      'function',
    )
    // 没有 default export —— 上游事故复盘记载：多余的 default 会让 loader
    // 丢弃整个 namespace，连 inject 一起丢掉
    expect(module['default'], `${name} 不应有 default export`).toBeUndefined()
  },
)
