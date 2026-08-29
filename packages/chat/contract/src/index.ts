/**
 * `@dsh-chat/contract` —— dsh-chat 的唯一共享协议包。
 *
 * 边界（见 docs/03-details/06-contracts-and-conventions.md §48 编码规范）：
 * 本包只定义类型、schema 与服务接口，不携带数据库驱动、HTTP 框架或任何业务副作用，
 * 浏览器与 Node 均可引用。错误码目录、`AuditEvent` 结构、`ProtocolVersion` 与术语表
 * 都只在这里定义，其他插件不得自定义同名概念或私有错误码。
 *
 * 本文件当前只包含品牌化标识符的基础设施与协议版本；命令、事件、错误码目录与状态机
 * 随对应实现阶段逐步加入。
 */

declare const brand: unique symbol

/**
 * 品牌化不透明标识符。
 *
 * 术语表要求组织、工作区、项目、账号、设备等标识符是「服务端生成的品牌化不透明 ID」。
 * 用品牌类型可以让 `OrganizationId` 与 `ProjectId` 在类型层面互不兼容，避免传参错位。
 */
export type Branded<T, TBrand extends string> = T & { readonly [brand]: TBrand }

export type OrganizationId = Branded<string, 'OrganizationId'>
export type WorkspaceId = Branded<string, 'WorkspaceId'>
export type ProjectId = Branded<string, 'ProjectId'>
export type AccountId = Branded<string, 'AccountId'>
export type DeviceId = Branded<string, 'DeviceId'>

/** host 与 relay 在建立设备会话时协商的协议版本。 */
export type ProtocolVersion = Branded<string, 'ProtocolVersion'>

/**
 * 穷尽性检查。
 *
 * 编码规范要求「对封闭的消息和命令类型使用 `assertNever`」—— 当联合类型新增分支而
 * 某个 switch 未处理时，编译期即报错，而不是运行时落到默认分支。
 */
export function assertNever(value: never, message = '未处理的分支'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`)
}

/**
 * host 健康检查的响应。
 *
 * 放在 contract 而不是 host，是为了让浏览器端与 host 端共用同一个定义 —— 编码规范
 * 要求协议 schema 只放在本包，其他插件不得各自定义同名结构。
 */
export interface HealthResponse {
  readonly status: 'ok'
  /** 应答的插件名，便于在多插件环境下定位是谁在提供该路由。 */
  readonly plugin: string
}

export * from './errors.js'
