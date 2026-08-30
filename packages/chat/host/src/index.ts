/**
 * dsh-chat host 插件。
 *
 * 职责（见 docs/02-architecture/01-overall-architecture.md §4）：host 是浏览器访问组织
 * 与 relay 的唯一入口，负责本地持久化缓存、保存设备凭证、运行 relay 客户端、发送在线
 * 心跳，并向浏览器提供同源 API。浏览器不直接与 relay 通信。
 *
 * ## 这里注册的路由才是真正生效的那一份
 *
 * 各端点的测试自己起 `WebServer` 并注册路由 —— 那验证的是**处理器的行为**。
 * 处理器写好了不等于插件把它挂上去了：这个文件长期只注册了 `/health`，
 * 于是浏览器端一调 `/api/chat/conversations` 就拿不到东西，界面白屏。
 *
 * 所以路由表在下面集中列出，并由 `ROUTE_PATHS` 导出供测试逐条核对。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

// `ctx.webServer` 由 dsh-host-webserver 通过 `declare module '@deepseek-ai/cordis'`
// 增强到 Context 上。这里必须引入该包才能让增强生效 —— 只 import cordis 是拿不到的。
import type {} from '@deepseek-ai/dsh-host-webserver'

import type { HealthResponse } from '@dsh-chat/contract'

import {
  ackMessagesHandler,
  conversationsHandler,
  editMessageHandler,
  markReadHandler,
  messageHistoryHandler,
  pullMessagesHandler,
  revokeMessageHandler,
  sendMessageHandler,
  type MessageCommandDeps,
  type Principal,
} from './routes/message-commands.js'
import {
  acceptMembershipHandler,
  createOrganizationHandler,
  createProjectHandler,
  createWorkspaceHandler,
  inviteMemberHandler,
  myMembershipsHandler,
  type OrganizationCommandDeps,
} from './routes/organization-commands.js'
import {
  addDependencyHandler,
  assignWorkItemHandler,
  createWorkItemHandler,
  inboxHandler,
  type WorkspaceCommandDeps,
} from './routes/workspace-commands.js'
import { RelayClient } from './relay/client.js'
import { relayProxyHandler } from './relay/proxy.js'
import { ChatDatabaseService } from './storage/service.js'

/** host 路由的同源前缀。§4 规定浏览器只与 `/api/chat` 和 `/api/organization` 通信。 */
export const CHAT_API_PREFIX = '/api/chat'
export const ORGANIZATION_API_PREFIX = '/api/organization'

export const name = 'dsh-chat-host'

/**
 * 声明所需服务。缺少必需提供者时 profile 加载失败，不允许静默降级
 * （见 docs/02-architecture/02-plugin-model.md §6）。
 *
 * 用普通数组而非 `as const`：Cordis 的 `Inject` 类型是 `(keyof M)[] | {...}`，
 * readonly 元组不满足数组分支，只是靠落入对象分支才通过类型检查，且无法赋给
 * 生态中普遍使用的 `string[]`。
 */
export const inject = ['webServer']

export interface Config {
  /**
   * L1 只服务一个由部署明确指定的组织。
   * 见 docs/04-roadmap/03-iteration-plan.md §44.1。
   */
  organizationId?: string
  /** 本地数据库路径。缺省落在进程工作目录下。 */
  databasePath?: string
  /**
   * 单机模式下的本地身份。
   *
   * `P0-a` 还没有设备会话与 token（属 `P0-b`），因此这里用配置里的账号直接充当
   * 已认证主体。**这是一个明确的临时口子**，边界写在 `authenticateFrom` 上。
   */
  localAccountId?: string
  localDeviceId?: string
  /**
   * relay 基地址。**配了就走 relay，不配就走本地库。**
   *
   * 不做成「配了也优先本地、失败再回落 relay」那种自动降级 —— §41 明确禁止
   * 静默降级，而「有时读本地有时读远端」正是最难排查的那一类不一致。
   */
  relayUrl?: string
  /** relay 的部署期共享密钥。见 `RelayClient` 上关于它不是设备身份的说明。 */
  relaySharedSecret?: string
}

/**
 * 与 `Config` 接口同名的运行时 schema。
 *
 * 两者必须成对导出：类型给调用方，schema 给 Cordis 做校验与填默认值。缺少 schema 时
 * Cordis 会原样透传未经校验的配置，这与「不允许静默降级」相冲突。
 */
export const Config: Schema<Config> = Schema.object({
  organizationId: Schema.string(),
  databasePath: Schema.string(),
  localAccountId: Schema.string(),
  localDeviceId: Schema.string(),
  relayUrl: Schema.string(),
  relaySharedSecret: Schema.string(),
})

/**
 * 从请求解析调用者。
 *
 * **`P0-a` 的临时实现**：桌面端是单用户本机进程，浏览器就是本机的渲染进程，
 * 所以这里直接返回配置里的本地身份。真正的设备会话（access token 加 §7.1 的
 * 请求签名）属 `P0-b` —— 校验侧已经在 `request-signing.ts` 实现，缺的是会话
 * 建立与 token 下发。
 *
 * 之所以不先接一个「假 token」：假 token 会让调用方以为认证已经存在，而它挡不住
 * 任何人。写成显式的本地身份，边界一眼可见。
 *
 * **没配就一律未认证** —— 默认拒绝，不是默认放行。
 */
function authenticateFrom(config: Config): (request: IncomingMessage) => Principal | undefined {
  const { organizationId, localAccountId } = config
  const deviceId = config.localDeviceId ?? 'local-device'
  if (organizationId === undefined || localAccountId === undefined) return () => undefined
  return () => ({ accountId: localAccountId, deviceId, organizationId })
}

/** 路由清单。与 `apply` 中注册的集合由 `buildRoutes` 保证一致。 */
export const ROUTE_PATHS: readonly string[] = [
  `${CHAT_API_PREFIX}/health`,
  `${CHAT_API_PREFIX}/messages`,
  `${CHAT_API_PREFIX}/messages/pull`,
  `${CHAT_API_PREFIX}/messages/ack`,
  `${CHAT_API_PREFIX}/messages/edit`,
  `${CHAT_API_PREFIX}/messages/revoke`,
  `${CHAT_API_PREFIX}/messages/history`,
  `${CHAT_API_PREFIX}/conversations`,
  `${CHAT_API_PREFIX}/conversations/read`,
  `${CHAT_API_PREFIX}/work-items`,
  `${CHAT_API_PREFIX}/work-items/assign`,
  `${CHAT_API_PREFIX}/work-items/dependencies`,
  `${CHAT_API_PREFIX}/notifications`,
  ORGANIZATION_API_PREFIX,
  `${ORGANIZATION_API_PREFIX}/workspaces`,
  `${ORGANIZATION_API_PREFIX}/projects`,
  `${ORGANIZATION_API_PREFIX}/members/invite`,
  `${ORGANIZATION_API_PREFIX}/members/accept`,
  `${ORGANIZATION_API_PREFIX}/members/me`,
]

type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void

function healthHandler(_request: IncomingMessage, response: ServerResponse): void {
  const body: HealthResponse = { status: 'ok', plugin: name }
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

export function apply(ctx: Context, config: Config = {}): void {
  const database = new ChatDatabaseService(ctx, {
    location: config.databasePath ?? join(process.cwd(), 'dsh-chat.db'),
  })

  // 同源判定用 web server 自己的地址。写死或从配置读都会让「同源」这个词失去
  // 意义 —— 它必须就是浏览器实际访问的那个 origin
  const expectedOrigin = `http://127.0.0.1:${ctx.webServer.port}`
  const authenticate = authenticateFrom(config)
  const now = (): Date => new Date()
  let idCounter = 0
  const newId = (prefix: string): string => `${prefix}-${Date.now()}-${(idCounter += 1)}`

  const messageDeps: MessageCommandDeps = {
    database,
    expectedOrigin,
    authenticate,
    // 队列容量属版本化的 PlanLimits，此处取基线；组织策略化属 P0-b（§30.1）
    queueCapacity: 1000,
    leaseMs: 60_000,
    now,
  }
  const shared = { database, expectedOrigin, authenticate, now, newId }
  const workspaceDeps: WorkspaceCommandDeps = shared
  const organizationDeps: OrganizationCommandDeps = shared

  const handlers: Readonly<Record<string, RouteHandler>> = {
    [`${CHAT_API_PREFIX}/health`]: healthHandler,
    [`${CHAT_API_PREFIX}/messages`]: sendMessageHandler(messageDeps),
    [`${CHAT_API_PREFIX}/messages/pull`]: pullMessagesHandler(messageDeps),
    [`${CHAT_API_PREFIX}/messages/ack`]: ackMessagesHandler(messageDeps),
    [`${CHAT_API_PREFIX}/messages/edit`]: editMessageHandler(messageDeps),
    [`${CHAT_API_PREFIX}/messages/revoke`]: revokeMessageHandler(messageDeps),
    [`${CHAT_API_PREFIX}/messages/history`]: messageHistoryHandler(messageDeps),
    [`${CHAT_API_PREFIX}/conversations`]: conversationsHandler(messageDeps),
    [`${CHAT_API_PREFIX}/conversations/read`]: markReadHandler(messageDeps),
    [`${CHAT_API_PREFIX}/work-items`]: createWorkItemHandler(workspaceDeps),
    [`${CHAT_API_PREFIX}/work-items/assign`]: assignWorkItemHandler(workspaceDeps),
    [`${CHAT_API_PREFIX}/work-items/dependencies`]: addDependencyHandler(workspaceDeps),
    [`${CHAT_API_PREFIX}/notifications`]: inboxHandler(workspaceDeps),
    [ORGANIZATION_API_PREFIX]: createOrganizationHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/workspaces`]: createWorkspaceHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/projects`]: createProjectHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/members/invite`]: inviteMemberHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/members/accept`]: acceptMembershipHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/members/me`]: myMembershipsHandler(organizationDeps),
  }

  // relay 模式：配了地址就把业务路由换成转发。
  //
  // 只换业务路由，`/health` 仍由本地应答 —— 它报的是「这个插件活着」，
  // 不是「relay 活着」，混为一谈会让 relay 挂掉时健康检查也跟着挂，
  // 分不清是插件问题还是后端问题。
  const relay = createRelayClient(config)
  if (relay !== undefined) {
    // 装载时协商一次。不 await —— relay 慢或不可达不该阻塞插件装载，
    // 那会让用户连设置面板都打不开。未协商完成前的调用会拿到可重试的 503
    void relay.connect()
  }

  // 所有 Cordis 注册通过 ctx.effect() 完成并返回 disposer；插件卸载后不得残留
  // 路由、后台任务或事件监听（§48 编码规范）。
  for (const path of ROUTE_PATHS) {
    const handler =
      relay !== undefined && path !== `${CHAT_API_PREFIX}/health`
        ? relayProxyHandler({ relay, expectedOrigin, authenticate }, path)
        : handlers[path]
    // ROUTE_PATHS 与 handlers 必须一一对应。少一个就静默不注册，
    // 而那正是这次白屏的成因 —— 宁可启动失败
    if (handler === undefined) throw new Error(`路由 ${path} 没有对应的处理器`)
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path, handler }),
      `${name}: route ${path}`,
    )
  }
}

/**
 * 按配置决定要不要走 relay。
 *
 * 地址与密钥**必须成对出现**：只配地址就连不上（relay 不配密钥拒绝一切请求），
 * 只配密钥没有意义。缺一个就当没配 relay，走本地库 —— 而不是带着半份配置
 * 去连一个必然失败的地址。
 */
function createRelayClient(config: Config): RelayClient | undefined {
  const { relayUrl, relaySharedSecret } = config
  if (relayUrl === undefined || relayUrl.length === 0) return undefined
  if (relaySharedSecret === undefined || relaySharedSecret.length === 0) return undefined
  return new RelayClient({ baseUrl: relayUrl.replace(/\/$/, ''), sharedSecret: relaySharedSecret })
}

export { RelayClient } from './relay/client.js'
export type { RelayState } from './relay/client.js'
export * from './rate-limit.js'
