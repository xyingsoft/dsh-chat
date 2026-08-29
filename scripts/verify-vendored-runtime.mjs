#!/usr/bin/env node
// 校验 vendor/dsh-runtime 下的 tarball 与 manifest.json 一致，且 manifest 描述的
// 集合与 package.json 的 resolutions 完全对应。
//
// DSH 运行时不从 npm 安装 —— 上游自 0.1.2-alpha.1 起改为 vendored tarball 分发，
// 该版本根本不在 npm 上。
//
// 本脚本能防什么、不能防什么：
//   能防 —— tarball 被替换或损坏、tarball 内容与声明的包名版本不符、manifest 与
//           resolutions 集合不一致、有包被悄悄增删、以及「同时改 tarball 与 manifest」
//           的一致性篡改（被下方 EXPECTED 带外锚点挡下）。
//   不能防 —— 同时改 tarball、manifest 与 EXPECTED 三处的篡改。这不是密码学保证；
//           它只把篡改从「二进制块加一行 JSON」提升为「必须改动一段显眼的 JS 常量」，
//           从而在评审中无法藏匿。与上游的真实比对仍是人工动作，依据是 manifest 中
//           的 repository/commit 字段。
//
// 注意：resolutions 缺失并不会导致「静默回落到 npm 的错误版本」—— 声明范围
// ^0.1.2-alpha.1 在 npm 上匹配不到任何候选，yarn 会以 YN0082 直接失败。真正的风险
// 是有人把范围放宽成 * 或 latest，那时才会装到 npm 上的 0.0.1-rc.1，因此下面同时
// 校验各 workspace 声明的版本范围。
//
// 用法：node scripts/verify-vendored-runtime.mjs

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 带外锚点：预期的包集合与校验和，与 manifest.json 分开保存。
 *
 * manifest.json 是数据，本常量是断言。只改 tarball 与 manifest 的一致性篡改会在这里
 * 被挡下，因为攻击者还得改动这段常量 —— 而这是一段显眼的 JS diff，不是二进制块加
 * 一行 JSON 字段。这不是密码学保证，只是把篡改成本从「不可见」提到「必须在评审中
 * 正面解释」。
 *
 * 修改本表的唯一正当理由是升级 DSH 运行时版本，此时必须重新对照上游
 * vendor/dsh-runtime/<version>/manifest.json 逐个核对，并在 PR 中说明。
 */
const EXPECTED = Object.freeze({
  sourceVersion: '0.1.2-alpha.1',
  commit: 'cd5ef8148158c3a752a658978873241fdf8e2bbc',
  packages: Object.freeze({
    '@deepseek-ai/dsh-client-store':
      '32b1c4da110888f6dcae69bc80f94182a717c4d2feb1dcb2d6891052cac8ff0e',
    '@deepseek-ai/dsh-client-ui-renderer':
      'abcb7598964865e2a8b4008cc1d62702a88c6d3eea9a4c1e2677e8935b8934ae',
    '@deepseek-ai/dsh-client-ui-slots':
      '29c16a338bd9dfa89472bad327bd4ccb902639b1c58e237377575b9cf821dd7e',
    '@deepseek-ai/dsh-host-webserver':
      '4f44014657a503297470410b2249f9765cc4ef640541d1412e4f7eeec9997508',
    '@deepseek-ai/dsh-invariants':
      'c266007374cfd90895876c07b96dc718a1eaed1910e0b0d78c5e34b94ace29b1',
  }),
})

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

// —— 带外锚点比对：manifest 必须与 EXPECTED 完全一致 ——
if (manifest.sourceVersion !== EXPECTED.sourceVersion) {
  problems.push(`manifest 的 sourceVersion 为 ${manifest.sourceVersion}，锚点为 ${EXPECTED.sourceVersion}`)
}
if (manifest.commit !== EXPECTED.commit) {
  problems.push(`manifest 的 commit 为 ${manifest.commit}，锚点为 ${EXPECTED.commit}`)
}

const expectedNames = Object.keys(EXPECTED.packages).sort()
const manifestNames = manifest.packages.map((entry) => entry.name).sort()
if (expectedNames.join() !== manifestNames.join()) {
  problems.push(
    `包集合与锚点不符
    锚点   ${expectedNames.join(', ')}
    manifest ${manifestNames.join(', ')}`,
  )
}

for (const entry of manifest.packages) {
  const expectedSha = EXPECTED.packages[entry.name]
  if (expectedSha && expectedSha !== entry.sha256) {
    problems.push(
      `${entry.name} 的 sha256 与锚点不符
    锚点 ${expectedSha}
    manifest ${entry.sha256}`,
    )
  }
}

/**
 * 从 tarball 中读出 `package/package.json`，用于校验内容与声明是否一致。
 *
 * 用 zlib 自行解析 tar 而不调用外部 `tar`：GNU tar 会把 Windows 路径 `E:\...` 当作
 * `host:path` 远程语法而失败，且 Windows 自带的 bsdtar 与 GNU tar 参数并不完全通用。
 * npm tarball 是标准 ustar，只需读头部的文件名与大小即可，无需引入依赖。
 */
function readPackedManifest(tarballPath) {
  const tar = gunzipSync(readFileSync(tarballPath))
  const BLOCK = 512

  for (let offset = 0; offset + BLOCK <= tar.length; ) {
    const header = tar.subarray(offset, offset + BLOCK)
    // 连续的空块表示归档结束
    if (header.every((byte) => byte === 0)) break

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(sizeField, 8)
    if (!Number.isFinite(size)) {
      throw new Error(`tar 头部的 size 字段无法解析：${JSON.stringify(sizeField)}`)
    }

    const dataStart = offset + BLOCK
    if (name === 'package/package.json') {
      return JSON.parse(tar.subarray(dataStart, dataStart + size).toString('utf8'))
    }

    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }

  throw new Error('归档中没有 package/package.json')
}

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

  // tarball 内容必须自证身份：只比对外部 sha256 无法发现「文件名对、内容是另一个包」
  try {
    const packed = readPackedManifest(file)
    if (packed.name !== entry.name) {
      problems.push(`${entry.filename} 内含的包名是 ${packed.name}，manifest 声明为 ${entry.name}`)
    }
    if (packed.version !== entry.version) {
      problems.push(`${entry.filename} 内含版本 ${packed.version}，manifest 声明为 ${entry.version}`)
    }
  } catch (error) {
    problems.push(`${entry.filename} 无法读取内部 package.json：${String(error)}`)
  }

  const resolution = resolutions[entry.name]
  if (!resolution) {
    problems.push(`package.json 的 resolutions 缺少 ${entry.name}`)
  } else if (!resolution.includes(entry.filename)) {
    problems.push(`${entry.name} 的 resolution 未指向 ${entry.filename}：${resolution}`)
  }
}

// 目录中不得有 manifest 未登记的 tarball，否则「悄悄多塞一个包」不会被发现
const onDisk = readdirSync(runtimeDir).filter((name) => name.endsWith('.tgz'))
for (const filename of onDisk) {
  if (!manifest.packages.some((entry) => entry.filename === filename)) {
    problems.push(`vendor 目录中的 ${filename} 未登记在 manifest 中`)
  }
}

for (const name of Object.keys(resolutions)) {
  if (!manifest.packages.some((entry) => entry.name === name)) {
    problems.push(`resolutions 中的 ${name} 在 manifest 中没有对应条目`)
  }
}

// 各 workspace 声明的版本范围必须是精确版本。放宽成 * / latest / ^0.1.1 之类
// 才是真正会装到 npm 上错误版本的路径。
const vendored = new Set(manifest.packages.map((entry) => entry.name))
const workspaceDirs = ['packages/chat/contract', 'packages/chat/host']
for (const relative of workspaceDirs) {
  const pkgPath = join(root, relative, 'package.json')
  if (!existsSync(pkgPath)) continue
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (!vendored.has(name)) continue
      if (!/^\^?0\.1\.2-alpha\.1$/.test(range)) {
        problems.push(`${relative} 的 ${field}.${name} 范围为 ${range}，应固定到 0.1.2-alpha.1`)
      }
    }
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
