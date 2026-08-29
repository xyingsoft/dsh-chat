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

## 未验证的部分

- **界面**。客户端组件已实现但尚未注册到 slot，原因见 [TODO](../../TODO.md) 的阶段 10。
  因此 DSH 界面上目前看不到 dsh-chat 的任何 UI。
- **端到端聊天**。host 侧的命令路由未接通，消息收发目前只在
  [骨架走查](./skeleton-walkthrough.md)中以库调用的形式验证，未经过 HTTP。

---

[← 上一篇：骨架走查记录](./skeleton-walkthrough.md) | [返回 Wiki 首页](../README.md)
