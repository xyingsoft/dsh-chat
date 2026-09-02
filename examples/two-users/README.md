# 双用户联调环境

单机 local 模式下，聊天 UI 的会话列表永远是空的——没有第二个账号，就没有
会话可显示。本目录补齐那一半：起一个本地 relay，并播种一个固定账号「乙」
作为测试对手方。甲（DSH Desktop）在 UI 里操作，乙由 `bob.mjs` 扮演。

## 前置条件

- `dsh-chat-relay` 已构建（仓库与 `dsh-chat` 同级，`yarn build` 产出 `dist/`）。
- DSH Desktop 可启动（`packages/chat/kernel` 所在的 L1 bundle）。

## 使用步骤

### 1. 启动 relay

```sh
node examples/two-users/start-relay.mjs
```

脚本会：

1. 在 `examples/two-users/data/` 下创建 SQLite 库（已列入 .gitignore）；
2. 起 relay（`http://127.0.0.1:8787`，共享密钥 `examples-two-users-secret`）；
3. 等端口就绪后播种账号「乙」（ID 固定为 `yi`，幂等，重启不换 ID）；
4. 打印下一步要填的 config。

### 2. 接线 Desktop 侧的 chat-host

把 `packages/chat/kernel/cordis.patch.yml` 里 chat-host 条目的 `config: {}`
替换为：

```yaml
- id: chat-host
  name: '@dsh-chat/host'
  config:
    organizationId: org-bootstrap
    relayUrl: http://127.0.0.1:8787
    relaySharedSecret: examples-two-users-secret
```

然后重启 DSH Desktop。

### 3. 甲开户

在 Desktop 的聊天面板完成开户，邀请码填 `two-users-invite`
（引导码只在库里还没有真实账号时有效，甲用掉后即失效——这正是乙要
直写库的原因，见下文设计说明）。

### 4. 乙与甲建立联系人并发消息

甲的账号 ID 在 Desktop 设置面板的「账号 ID」里（可复制）。然后：

```sh
node examples/two-users/bob.mjs contact <甲的账号ID>
```

乙会与甲建立联系人关系（request + accept 一次完成）并发来第一条消息。
之后甲的会话列表就有了内容，可以双向收发。

## bob.mjs 命令

| 命令 | 作用 |
| --- | --- |
| `contact <甲的账号ID> [欢迎消息]` | 建立联系人（幂等）并发第一条消息 |
| `send <甲的账号ID> <消息文本>` | 以乙的身份发一条直发消息 |
| `log <甲的账号ID>` | 打印双向消息历史（只读，不消费投递队列） |

## 重置

删除 `examples/two-users/data/` 目录，重新跑 `start-relay.mjs`。
乙的账号 ID 固定为 `yi`，甲的账号 ID 每次开户都会变——重置后需要重新
`contact` 一次。

## 设计说明

**乙为什么直写 relay 的 SQLite，而不是走 HTTP？**

relay 只在库为空时签发一张引导邀请码，一码一户（见 dsh-chat-relay 的
`bootstrap.ts`）。甲（Desktop UI）要用掉这张码，乙就没有了；relay 也没有
「已开户者再签码」的 HTTP 端点。而乙是本机测试进程，与 relay 共享同一个
SQLite 文件——直写领域函数（`acceptDirectMessage` 等）与 relay 进程处理
HTTP 后走的是同一段代码。这个模式在 kernel 的多进程验收
（`multi-process.host.spec.ts`）里已经跑通。

**为什么不设 TLS 指纹？**

`DSH_CHAT_RELAY_TLS_FINGERPRINT` 是给「relay 在反代后面」的部署防中间人
用的。这里 relay 与 host 都在本机回环上，配了只会在两条签名实现之间引入
与测试目标无关的失败面。
