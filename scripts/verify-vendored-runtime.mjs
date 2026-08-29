#!/usr/bin/env node
// 校验 vendor/dsh-runtime 下的 tarball 与 manifest.json 记录的 sha256、体积一致，
// 并确认 package.json 的 resolutions 覆盖了 manifest 中的每一个包。
//
// DSH 运行时不从 npm 安装（npm 上的 latest 标签指向远早于当前的版本），
// 而是按上游方式以 vendored tarball 分发。因此完整性校验是必需的，不是可选的。
//
// 用法：node scripts/verify-vendored-runtime.mjs

import { createHash } from 'node:crypto'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = join(root, 'vendor', 'dsh-runtime', '0.1.2-alpha.1')
const manifestPath = join(runtimeDir, 'manifest.json')

const problems = []

if (!existsSync(manifestPath)) {
  console.error(`找不到 manifest: ${manifestPath}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const resolutions = rootPkg.resolutions ?? {}

for (const entry of manifest.packages) {
  const file = join(runtimeDir, entry.filename)

  if (!existsSync(file)) {
    problems.push(`缺少 tarball：${entry.filename}`)
    continue
  }

  const bytes = readFileSync(file)
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  if (sha256 !== entry.sha256) {
    problems.push(`${entry.filename} 校验和不符\n    期望 ${entry.sha256}\n    实际 ${sha256}`)
  }

  const size = statSync(file).size
  if (size !== entry.size) {
    problems.push(`${entry.filename} 体积不符：期望 ${entry.size}，实际 ${size}`)
  }

  // resolutions 必须逐个指向 vendor 中的 tarball，否则 yarn 会回落到 npm，
  // 而 npm 上的 latest 是一个远早于当前的版本
  const resolution = resolutions[entry.name]
  if (!resolution) {
    problems.push(`package.json 的 resolutions 缺少 ${entry.name}`)
  } else if (!resolution.includes(entry.filename)) {
    problems.push(`${entry.name} 的 resolution 未指向 ${entry.filename}：${resolution}`)
  }
}

for (const name of Object.keys(resolutions)) {
  if (!manifest.packages.some((entry) => entry.name === name)) {
    problems.push(`resolutions 中的 ${name} 在 manifest 中没有对应条目`)
  }
}

if (problems.length > 0) {
  console.error('vendored 运行时校验失败：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(
  `vendored 运行时校验通过：${manifest.packages.length} 个包，` +
    `来源 ${manifest.repository} @ ${manifest.commit.slice(0, 10)}`,
)
