[← 返回 Wiki 首页](../README.md) | **四、项目排期** · 02 最小可运行骨架 | [上一篇：关键操作状态矩阵](./01-operation-states.md) | [下一篇：迭代计划 P0–P4 →](./03-iteration-plan.md)

---

# 八、交付计划与验收（二）：最小可运行骨架

> **本文档属于排期层**。下列 14 步是 **P0 完成的判定标准**：全部通过才算 P0 完成，任何一步未通过都不得宣布交付。

## 本篇目录

- [43. 最小可运行骨架](#43-最小可运行骨架)
- [43.1 初始工程结构](#431-初始工程结构)

---

## 43. 最小可运行骨架

只有两台 DSH Web 实例和一个持久化 relay 完成以下流程时，P0 才算完成：

1. 管理员创建两个一次性注册邀请码。
2. 两位用户各注册一个设备、设置密码或设备登录方式、登记 `totp` 与一次性备用码、导出恢复包或配置恢复守护人，并经其他渠道交换公开联系人地址。
3. 用户 A 创建组织、工作区和项目，并把用户 B 以开发者角色邀请进项目。
4. 两人启动 DSH 后互相看到 `online`；用户 B 改为隐藏在线状态后，用户 A 只看到 `unknown`，但消息投递仍正常。
5. 用户 A 创建一个工作项并分派给用户 B；用户 B 在收件箱看到持久化通知。
6. 用户 A 发送联系人请求，用户 B 接受。
7. 用户 A 在用户 B 离线时发送一条中文文本消息。
8. relay 重启，队列、通知、工作项和组织切换状态不丢失。
9. 用户 B 启动 DSH，持久化消息并 ACK，重启 DSH 后仍只看到一条消息和一条已读通知。
10. 用户 A 模拟丢失唯一设备后，使用恢复包或守护人阈值注册新设备；旧设备无法继续访问，仍在保留期内的非 E2E 数据可读取。
11. 收件人队列满时，新发送被明确拒绝，已接收的早期消息不被删除。
12. 用户 A 在本地搜索到该条私聊；服务端搜索、线程与转发入口显示为未安装。
13. 用旧协议版本的 host 连接 relay 时返回 `PROTOCOL_VERSION_UNSUPPORTED` 并停止组织写入，不进入部分可用状态。
14. 上述每一步在审计表中都有对应事件，且被拒绝的越权尝试同样留下记录；审计表中不含任何消息正文。

### 43.1 初始工程结构

```text
dsh-chat/
  DESIGN.md
  packages/
    chat/
      contract/          @dsh-chat/contract：共享品牌 ID、命令、事件、错误码、schema 与 SPI
      kernel/            @dsh-chat/kernel：L1 插件 bundle 与社区默认配置
      team/              @dsh-chat/team：L2 provider 覆盖与团队 bundle
      enterprise/        @dsh-chat/enterprise：L3 provider 覆盖与企业 bundle
      host/              dsh-chat host 插件：本地数据库、relay 客户端、同源路由、事件发布
      client/            dsh-chat client 插件：DSH slot 注册、页面、store、CSS Modules
      identity/          身份、设备、恢复、会话与风险管制插件
      organization/      组织、成员、角色、ACL、项目与策略插件
      workitem/          工作项状态机、依赖、签收、评审与评论插件
      presence/          心跳、在线可见范围与订阅插件
      messaging/         私聊、群日志、编辑、撤回、ACK、游标与投递插件
      content/           附件、资源库、扫描、授权、保留与对象存储插件
      notification/      收件箱、邮件、SSE 与 outbox 消费插件
      collaboration/     共享、协作会话、执行租约与执行 provider 插件
      repository/        仓库、受控出站、webhook 与提交归因插件
      bot/               隔离群 Bot、公共工具目录与能力租约插件
      search/            索引管线、查询授权复检与设备侧索引插件
      analytics/         用量、预算、报告、排行与计费插件
      compliance/        数据导出、账号注销、组织删除与保留合规插件
      audit/             审计事件、哈希链、迁移、水位恢复、缓存失效与运维插件
  examples/
    two-users/           两个 host、一个组织、一个项目和一个 relay 配置
```

> **注**：上述结构中的 `DESIGN.md` 现已重构为 `docs/` Wiki，原文件保留为历史归档。详见[原文档映射表](../_meta/source-mapping.md)。

`@dsh-chat/contract` 是唯一的共享协议包；`kernel`、`team` 和 `enterprise` 只选择其服务提供者，不重新定义命令或权限语义。

`client` 绝不访问 relay 凭证或数据库。

`host` 是浏览器面向组织、relay、协作、Bot、插件目录、分析和账单服务的唯一入口。

> 各目录对应的插件能力与提供者，见[插件化架构 §6.1 能力与提供者矩阵](../02-architecture/02-plugin-model.md#61-能力与提供者矩阵)。

---

[← 上一篇：关键操作状态矩阵](./01-operation-states.md) | [返回 Wiki 首页](../README.md) | [下一篇：迭代计划 P0–P4 →](./03-iteration-plan.md)
