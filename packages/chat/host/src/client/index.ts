/**
 * host 包的 client 入口。
 *
 * ## 这个文件目前还没被 DSH 装载
 *
 * DSH 的约定是**一个包同时承载两侧**：`.` 导出给 Cordis 的 host 端，`./client`
 * 导出给渲染进程，并在 package.json 里用 `dsh.client` 声明后者存在。
 * profile 里的 `dshmarket` 就是这个形状。
 *
 * 我们的实现拆成了 `@dsh-chat/host` 与 `@dsh-chat/client` 两个包 —— 那对源码
 * 组织是对的（浏览器代码不该和 SQLite 混在一起），但 DSH 只认前者。这个文件
 * 补上转发，`./client` 子路径导出也已加好，**但 `dsh.client` 还没声明**。
 *
 * 原因是渲染侧的入口**必须是预打包的单文件**，不能是 `tsc` 的原始输出：
 *
 * - DSH 的客户端 bundle 是一个闭包工厂，调用 `window.__ModuleLoader__.load(...)`，
 *   外部依赖经注入的 `require` 从 loader 模块表解析，不走 import map；
 * - `.module.css` 由 lightningcss 在打包时编译成「哈希类名映射 + 运行时注入
 *   `<style>`」，因此 `tsc` 产物里那句 `import styles from './X.module.css'`
 *   在渲染进程里会直接 `ERR_MODULE_NOT_FOUND` —— 本地验证时正是这么失败的。
 *
 * 上游的构建预设 `packages/client/tsdown.client.ts` 是 monorepo 内的相对导入，
 * 没有发布；`dshmarket` 这类外部插件是自己用 tsdown + lightningcss 重新实现了
 * 那套约定。我们要做同样的事才能真正装载。
 *
 * **在那之前不声明 `dsh.client`** —— 声明了 DSH 就会去装载一个当前必然失败的
 * 入口，那比没有入口更糟。缺口登记见 `docs/_meta/implementation-log.md`。
 *
 * 本文件不含逻辑，只做转发。真正的实现在 `@dsh-chat/client`。
 */

export * from '@dsh-chat/client/client'
