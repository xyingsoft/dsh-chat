[← 返回 Wiki 首页](../README.md) | **元文档** · DSH 装载验证 | [上一篇：骨架走查记录](./skeleton-walkthrough.md)

---

# DSH 装载验证

本文件记录 dsh-chat 被真实 DSH 装载的验证过程与结果。

> **为什么是文本而不是截图。** 验证在开发者本机的 DSH 实例上进行，其界面包含
> 该开发者的会话标题、工作区路径等个人数据。截图会把这些带进公开仓库，因此
> 这里保留 `--dump-config` 的输出 —— 它更精确（能证明条目进入了插件树的哪个位置），
> 且不含任何个人信息。截图留在本地 `build/evidence/`，该目录已被 gitignore。

## 环境

| 项 | 值 |
|---|---|
| DSH Desktop | `v2.0.4` |
| DSH 运行时 | `0.1.2-alpha.1` |
| 装载方式 | `link:` 到本仓库的 `packages/chat/kernel` |
| profile | `desktop` |

## 验证一：bundle 进入插件树

`dsh --profile desktop --dump-config` 输出组合后的完整插件树。dsh-chat 的条目出现在其中：

```yaml
# == @dsh-chat/kernel
- id: chat-host
  name: '@dsh-chat/host'
  config: {}
```

整棵树共 **149 个条目**，dsh-chat 是其中之一。这证明：

1. `@dsh-chat/kernel` 被 profile 的 `dsh.profile.bundles` 登记并识别为 bundle；
2. 它的 `cordis.patch.yml` 被解析，条目被插入组合结果；
3. `@dsh-chat/host` 这个包名从 profile 的位置可解析。

## 验证二：启动无错误

```
$ node lib/bin.js
{"level":"info","msg":"config-manager 已挂载", ... "dshVersion":"0.1.2-alpha.1"}
```

启动日志中错误数为 0，窗口标题为 `DeepSeek Harness Desktop`（非 `Recovery`）。

对照：在装入 dsh-chat 之前，同一环境下曾因两个第三方插件的版本错配而进入
Recovery 模式，日志中分别是 `failed to apply loader entry include` 与
`renderer boot failed`。两者处置记录在[实现记录](./implementation-log.md)。

## 验证三：路由注册

host 插件注册的 `/api/chat/health` 在 DSH 的 web server 上存在，但**无法用裸
`curl` 验证** —— DSH 的边缘层在路由匹配之前就对未认证请求返回 403：

```
$ curl -i http://127.0.0.1:43120/api/chat/health
HTTP 403 forbidden

$ curl -i http://127.0.0.1:43120/api/chat/health/不存在的路径
HTTP 403 forbidden
```

两个路径返回相同状态，说明 403 来自鉴权而非路由缺失。路由本身的行为由
`packages/chat/host/src/index.host.spec.ts` 在真实的 `WebServer` 服务上验证：
装载后返回 200、卸载后返回 404、连续装卸 3 轮不因路由冲突抛错。

## 验证四：客户端入口的模块解析（2026-08-30 补）

上面三项验证做完之后，界面一直没有出现。追查下来发现**客户端插件从未被装载**，
而此前的记录把它写成了「组件尚未注册到 slot」—— 那个描述是错的，slot 注册的代码
早已写好并有单元测试。真正的原因有两层。

### 第一层：DSH 不知道这个插件存在

从 profile 目录复现 DSH 的模块解析：

```
$ cd ~/.dsh/profiles/desktop && node verify-client-entry.mjs
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]:
  Package subpath './package.json' is not defined by "exports" in
  .../node_modules/@dsh-chat/host/package.json
```

两个问题：`./package.json` 没有导出（DSH 工具链要读它，`dshmarket` 也显式导出了
这一条）；更重要的是 bundle 的 `cordis.patch.yml` 里只有 `@dsh-chat/host`，
而客户端插件在独立的 `@dsh-chat/client` 包里，**没有任何声明指向它**。

DSH 的约定是一个包同时承载两侧：`.` 给 host 端，`./client` 给渲染进程，
并用 `dsh.client` 声明后者存在。profile 里的 `dshmarket` 就是这个形状。
已补上 `./client` 子路径导出与转发模块。

### 第二层：渲染侧入口必须是预打包的单文件

补完导出后再解析，暴露出下一个问题：

```
Error [ERR_MODULE_NOT_FOUND]:
  file:///.../packages/chat/client/dist/client/StatusSection.module.css
```

`tsc` 不会处理 `.module.css`。查上游的构建预设
（`deepseek-harness/packages/client/tsdown.client.ts`）后确认，DSH 的客户端 bundle 是
**闭包工厂**：调 `window.__ModuleLoader__.load({id, factory})`，外部依赖经注入的
`require` 从 loader 模块表解析（不走 import map）；`.module.css` 由 lightningcss
在打包时编译成哈希类名映射，并生成一段运行时注入 `<style>` 的代码。

已发布的 `dshmarket` 的 `client/client.js` 印证了这一点 —— 487 KB 单文件，
CSS 以字符串内联在 `NUL 前缀的 dsh-css:` 区段里。

那个预设是 monorepo 内的相对导入，**没有发布**；`dshmarket` 是自己用
tsdown + lightningcss 重新实现了同一套约定。我们要做同样的事。

### 结论：暂不声明 `dsh.client`

声明了 DSH 就会去装载一个当前必然失败的入口，那比没有入口更糟。
缺口登记在 [TODO 的「已知未完成项」](../../TODO.md#已知未完成项)。

## 未验证的部分

- **界面**。见上方验证四。DSH 界面上目前看不到 dsh-chat 的任何 UI，
  且这一点在插件自己的能力表里如实标为 `not_implemented`。
- **经 DSH 的端到端聊天**。host 的命令路由已接通并有 HTTP 端点测试
  （发送、拉取、ACK、编辑、撤回、组织、工作项、通知、SSE），
  但那些测试起的是独立的 `WebServer` 实例，不是 DSH 进程内的那一个。
  跨进程投递另有[三进程验收](../../packages/chat/kernel/src/multi-process.host.spec.ts)。

---

[← 上一篇：骨架走查记录](./skeleton-walkthrough.md) | [返回 Wiki 首页](../README.md)
