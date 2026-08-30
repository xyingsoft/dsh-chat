/**
 * 构建 DSH 渲染进程的客户端 bundle。
 *
 * ## 为什么需要这一步
 *
 * DSH 的渲染进程**不接受 `tsc` 的原始输出**。它按包取 `client.js`，那个文件必须是
 * 一个闭包工厂：
 *
 * ```js
 * window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => {
 *   var module = { exports: {} }; var exports = module.exports;
 *   // ...CJS bundle...
 *   return module.exports; } });
 * ```
 *
 * 外部依赖经注入的 `require` 从 loader 模块表解析 —— **不走 import map，也没有
 * 全局变量**。模块表答不上来的 `require()` 是必然的运行时抛错，所以规则很硬：
 * 在表里的保持 import，其余一律打进 bundle。
 *
 * `.module.css` 也必须在打包时处理成「哈希类名映射 + 运行时注入 `<style>`」——
 * `tsc` 会把 `import styles from './X.module.css'` 原样留下，渲染进程里就是
 * `ERR_MODULE_NOT_FOUND`。这正是本项目此前界面出不来的直接原因。
 *
 * ## 为什么不用上游的预设
 *
 * 上游的 `deepseek-harness/packages/client/tsdown.client.ts` 是 monorepo 内的
 * 相对导入，**没有发布**，外部插件用不了。`dshmarket` 这类外部插件是自己重新
 * 实现同一套约定的，本文件做的是同一件事。
 *
 * 约定的取值（banner/intro/footer、模块表清单）逐条抄自上游那份预设，
 * 出处标在下面各常量处。上游改了这里就得跟着改 —— 这是真实的耦合，
 * 写清楚比假装没有好。
 *
 * ## 依赖
 *
 * 只用 `rolldown` 与 `lightningcss`，两者都是上游预设用的东西（tsdown 是
 * rolldown 的薄封装）。没有引入新的构建工具链。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { transform } from 'lightningcss'
import { rolldown } from 'rolldown'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * loader 模块表里的条目。逐字取自上游
 * `deepseek-harness/packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES`。
 *
 * 这些由宿主提供，**必须保持 `require()`**：打进 bundle 会让插件持有一份自己的
 * React / cordis 副本，与宿主的那份不是同一个运行时身份 —— hooks 会报错，
 * 服务注入会拿到空的容器。
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** 承载渲染侧入口的包。DSH 按包取 `client.js`，所以 id 必须是它的包名。 */
const PLUGIN_PACKAGE = '@dsh-chat/host'
const ENTRY = resolve(repoRoot, 'packages/chat/client/src/client/index.ts')
const OUT_FILE = resolve(repoRoot, 'packages/chat/host/dist/client.js')

/** 该插件额外向宿主请求的服务，取自 host 包的 `dsh.client.inject`。 */
async function requestedExternals() {
  const manifest = JSON.parse(
    await readFile(resolve(repoRoot, 'packages/chat/host/package.json'), 'utf8'),
  )
  return manifest.dsh?.client?.inject ?? []
}

/**
 * 把一个 `.module.css` 编译成「类名映射 + 注入 `<style>`」的模块。
 *
 * `data-plugin-css` 标记用于去重：同一张表被两个入口引用时只注入一次。
 * 标记里带包名，避免与别的插件的同名文件相撞。
 */
function styleInjectionModule(fileId, css, classMap) {
  const tagId = `${PLUGIN_PACKAGE}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_PACKAGE)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/**
 * CSS Modules 插件。
 *
 * 用虚拟 id 把它挡在 rolldown 自己的 css 管线之外 —— 后者会把 `.css` 当作资源
 * 产出独立文件，而我们要的是内联。虚拟 id 的后缀不能是 `.css`，否则仍会被
 * 那条管线认领（上游预设踩过同一个坑，注释里写了）。
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function cssModulesPlugin() {
  return {
    name: 'dsh-css-modules',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer === undefined ? source : resolve(dirname(importer), source)
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(id) {
      if (!id.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = id.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const source = await readFile(fileId)
      const { code, exports } = transform({
        filename: fileId,
        code: source,
        cssModules: true,
        minify: true,
      })
      // lightningcss 的 exports 是 { 原类名: { name: 哈希类名, ... } }，
      // 组件侧要的是 { 原类名: 哈希类名 }
      const classMap = {}
      for (const [original, mapped] of Object.entries(exports ?? {})) {
        classMap[original] = mapped.name
      }
      return styleInjectionModule(fileId, code.toString(), classMap)
    },
  }
}

async function main() {
  if (!existsSync(ENTRY)) throw new Error(`找不到入口：${ENTRY}`)

  const externals = new Set([...PLATFORM_MODULES, ...(await requestedExternals())])
  // 表里的保持 import，其余一律打进 bundle。模块表答不上来的 require()
  // 是必然的运行时抛错，所以这条规则不能是「大概齐」
  const isExternal = (specifier) =>
    externals.has(specifier) ||
    [...externals].some((entry) => specifier.startsWith(`${entry}/`))

  const build = await rolldown({
    input: ENTRY,
    platform: 'browser',
    external: isExternal,
    plugins: [cssModulesPlugin()],
    // 渲染进程里没有 process；zustand 一类库会读它。不 define 的话工厂
    // 一执行就 ReferenceError。
    //
    // 这个选项在 rolldown 里属于 `transform` 而不是顶层 —— 放顶层它只会
    // 警告 "Invalid key" 然后**静默忽略**，产物照样生成。第一版就是这么过的。
    transform: {
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      },
    },
  })

  await mkdir(dirname(OUT_FILE), { recursive: true })
  const { output } = await build.write({
    file: OUT_FILE,
    format: 'cjs',
    sourcemap: true,
    // 逐字取自上游预设的 outputOptions
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_PACKAGE)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  })
  await build.close()

  const bytes = Buffer.byteLength(output[0].code, 'utf8')
  console.log(`客户端 bundle 已生成：${OUT_FILE}（${(bytes / 1024).toFixed(1)} KB）`)

  await verify(OUT_FILE, externals)
}

/**
 * 校验产物符合约定。
 *
 * 这一步不是形式主义：产物是给另一个进程加载的，构建成功不等于它能跑。
 * 上一轮界面出不来，正是因为没有人检查过产物长什么样。
 */
async function verify(file, externals) {
  const raw = await readFile(file, 'utf8')
  // 去掉末尾的 sourceMappingURL 注释再判尾。打包器还会给 footer 重新缩进换行，
  // 所以不能按字面比对整段 —— 第一版就是这么误报的
  const code = raw.replace(/\n*\/\/# sourceMappingURL=.*$/s, '')
  const problems = []

  if (!code.startsWith('window.__ModuleLoader__.load({')) {
    problems.push('产物不是以 __ModuleLoader__.load 开头 —— DSH 不会注册它')
  }
  if (!/return\s+module\.exports;\s*\}\s*\)?\s*;?\s*\}?\s*\)\s*;?\s*$/.test(code)) {
    problems.push('产物结尾不是闭包工厂的 return —— 工厂不会返回任何导出')
  }
  // 残留的 .css import 意味着 CSS 插件没接上，渲染进程会 ERR_MODULE_NOT_FOUND
  if (/require\(["'][^"']*\.css["']\)/.test(code)) {
    problems.push('产物里仍有对 .css 的 require —— CSS Modules 没有被内联')
  }
  // 每个 require() 的目标都必须在模块表里，否则运行时必抛
  for (const m of code.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const specifier = m[1]
    const known =
      externals.has(specifier) ||
      [...externals].some((entry) => specifier.startsWith(`${entry}/`))
    if (!known) problems.push(`require('${specifier}') 不在 loader 模块表里 —— 运行时必抛`)
  }
  // 类名注入是否真的进去了
  if (!code.includes('data-plugin-css') && !code.includes('dataset.pluginCss')) {
    problems.push('产物里没有样式注入代码 —— 界面会没有样式')
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(`  ✗ ${p}`)
    throw new Error(`客户端 bundle 不符合 DSH 的装载约定（${problems.length} 项）`)
  }
  console.log('产物校验通过：闭包工厂形态、无残留 CSS import、require 目标全部在模块表内')
}

await main()
