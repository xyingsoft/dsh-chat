# 参与贡献

[English](./CONTRIBUTING.en.md)

感谢你考虑为 dsh-chat 出一份力。本文说明不同角色可以怎样参与，以及提交代码前必须遵守的流程。

---

## 最重要的一条：文档先行

> **任何涉及需求变更或架构调整的修改，必须首先更新相关文档，然后再进行代码编写。**

这不是建议，是本仓库的强制流程。[`docs/`](./docs/README.md) 是实现、评审与验收的**唯一依据**；当代码与文档冲突时，不是「以代码为准、事后补文档」，而是先判定哪一方正确，再修正对应的一方。

**「先写代码、以后补文档」被视为流程缺陷，与漏写测试同级。**

完整流程、变更分类表与评审清单见[文档维护规范](./docs/archive/_meta/documentation-workflow.md)。提 PR 前请对照该文档第 2 节的表格，确认已更新的文档范围。

---

## 普通用户：反馈与传播

- 用 [Issue](https://github.com/xyingsoft/dsh-chat/issues) 报告缺陷或提出需求。请使用对应的模板，缺陷请附可复现步骤、期望行为与实际行为。
- 安全问题**不要**提 Issue，见 [SECURITY.md](./SECURITY.md)。
- 项目尚未发布，暂不接受使用类问题；实现阶段的进度见 [README 的状态表](./README.md#当前状态)。

## 插件作者：扩展生态

dsh-chat 自身就是一组 DSH 插件。若你要做与之协作的插件：

- 只依赖 `@dsh-chat/contract` 暴露的类型、命令、事件与错误码，**不要**导入任何服务提供者的内部实现或数据库模型。
- 消费能力通过服务接口调用（`ChatIdentity`、`ChatOrganization`、`ChatMessaging` 等），能力矩阵见[插件化架构](./docs/archive/02-architecture/02-plugin-model.md)。
- 组织公共插件始终运行在能力租约与成员 ACL 内，**不能**替换身份、授权、审计、出站或密钥插件。

## 开发者：贡献代码

### 开发环境

| 依赖 | 版本 |
|---|---|
| Node | `^22.19.0 \|\| >=24.0.0` |
| 包管理器 | Yarn 4（由根 `package.json` 的 `packageManager` 字段固定，经 corepack 启用） |

```bash
corepack enable
yarn install --immutable
yarn check
```

> **工程尚未初始化。** 仓库当前只有文档，没有 `package.json`，上述命令要等工程骨架合入后才可用。
> 在那之前，文档类 PR 的检查由 CI 的「文档一致性」job 完成，本地可跑 `bash scripts/check-links.sh`。
>
> 注意 `corepack enable` 本身不决定 Yarn 版本 —— 没有 `packageManager` 字段时它会回落到 Yarn 1.x，而 `--immutable` 在 1.x 中不是合法参数。该字段随工程骨架一并落地。

### 仓库边界（开始前务必了解）

这几条边界写在架构文档里，违反即为缺陷，评审会直接打回：

- **`@dsh-chat/contract` 是唯一的共享协议包**，且不携带数据库驱动、HTTP 框架或任何业务副作用。错误码目录、`AuditEvent` 结构、`ProtocolVersion` 与术语表都只在这里定义，插件**不得**自定义同名概念或私有错误码。
- **`client` 绝不访问 relay 凭证或数据库**，也不在浏览器中重算权限。界面可用操作来自 host 返回的能力描述。
- **`host` 是浏览器面向组织与 relay 的唯一入口**，浏览器不直接与 relay 通信。
- **`kernel` / `team` / `enterprise` 只是 bundle**，只排列插件、提供默认配置并选择提供者，**不承载业务单例**。
- **部署可变值必须从配置读取**：限流、配额、保留期、心跳阈值、排名权重都是经 schema 校验的组织配置，**不得写成代码常量**。
- **所有 Cordis 注册通过 `ctx.effect()` 或 `ctx.on()` 完成并返回 disposer**。插件卸载后不得残留路由、后台任务或事件监听。

### 提交与 PR

- 分支从 `main` 切出，命名 `feat/...`、`fix/...`、`docs/...`、`chore/...`。
- **`main` 一律通过 PR 合入，不直接推送。**（分支保护规则待开启；在此之前本条靠自觉遵守，不由服务端强制。）
- 提交信息使用 [conventional commits](https://www.conventionalcommits.org/) 风格，带 scope，例如 `feat(messaging): ...`、`fix(identity): ...`、`docs: ...`。
- 文档改动请**中英同步**（`CONTRIBUTING.md` / `CONTRIBUTING.en.md` 这类成对文件）。
- 提交前运行 `yarn check` 并保证全绿。
- **文档变更与代码变更分开提交**，便于回溯。
- PR 描述说明改动内容、动机与验证方式；CI 通过后再合并。

### 测试要求

- 每个状态转换都要有聚焦的单元测试；封闭联合类型用 `assertNever` 保证穷尽。
- **触及授权、内容授权、出站或执行路径的改动，必须同时补充[§39 安全规范清单](./docs/archive/03-details/04-security-compliance.md#39-安全规范清单)对应条目与拒绝用例才能合入。** 安全用例断言的是拒绝行为与错误码，而不仅是「未崩溃」。
- 测试数据**不得**包含真实凭证、真实组织数据或可用密钥。

分层测试策略见[测试与验收策略](./docs/archive/04-roadmap/04-test-strategy.md)。

---

## 行为准则

参与本项目即表示你同意遵守[行为准则](./CODE_OF_CONDUCT.md)。
