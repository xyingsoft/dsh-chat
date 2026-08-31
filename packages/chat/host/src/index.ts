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
  changeMemberRoleHandler,
  createOrganizationHandler,
  createProjectHandler,
  createWorkspaceHandler,
  inviteMemberHandler,
  listMembersHandler,
  myMembershipsHandler,
  removeMemberHandler,
  type OrganizationCommandDeps,
} from './routes/organization-commands.js'
import {
  addDependencyHandler,
  assignWorkItemHandler,
  createWorkItemHandler,
  inboxHandler,
  type WorkspaceCommandDeps,
} from './routes/workspace-commands.js'
import {
  enrollHandler,
  enrollmentStatusHandler,
  signOutHandler as identitySignOutHandler,
  type IdentityRouteDeps,
} from './routes/identity-commands.js'
import { EventStreamHub, eventStreamHandler } from './routes/event-stream.js'
import {
  acceptContactHandler,
  directoryHandler,
  listContactsHandler,
  rejectContactHandler,
  removeContactHandler,
  requestContactHandler,
  type ContactCommandDeps,
} from './routes/contact-commands.js'
import {
  getVisibilityHandler,
  heartbeatHandler,
  presenceQueryHandler,
  setVisibilityHandler,
  type PresenceCommandDeps,
} from './routes/presence-commands.js'
import { CredentialStore } from './identity/credentials.js'
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
  /**
   * 期望的 relay TLS 公钥指纹（SHA-256 十六进制）。**带外配置。**
   *
   * 配了才防中间人：relay 在协商时报的指纹对不上就拒绝连接，等价于 SSH 的
   * known_hosts 钉法。不配时签名仍防篡改与重放，但换不来通道绑定 ——
   * 中间人当然会报自己的指纹。
   */
  relayFingerprint?: string
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
  relayFingerprint: Schema.string(),
})

/**
 * 从请求解析调用者。
 *
 * 两个来源，**开过户的以凭据为准**：
 *
 * 1. **本机凭据**（relay 模式下开过户）。账号与设备来自注册时 relay 签发的
 *    那一份，与 relay 那边认的是同一个身份。
 * 2. **配置里的本地身份**（单机模式，或还没开户）。桌面端是单用户本机进程，
 *    浏览器就是本机的渲染进程，所以直接信配置。
 *
 * 顺序不能反。反过来的话，配置里写的 `localAccountId` 会盖掉真实账号 ——
 * relay 那边按 token 判定，host 这边按配置判定，两边对同一个请求得出不同的
 * 「谁」。不是安全漏洞（relay 不信 host 的声明），但 host 的判定还参与本地
 * 缓存的分区，足以让缓存串号。
 *
 * 组织仍然只来自配置：一个账号可属多个组织（§9），当前在哪个组织下工作是
 * 部署的选择，凭据里没有也不该有这个信息。
 *
 * **两个来源都没有就一律未认证** —— 默认拒绝，不是默认放行。
 *
 * §7.1 的请求签名管的是 **host → relay** 那一跳，已经接上（见
 * `identity/request-proof.ts`）。**browser → host 这一跳仍然没有签名**：
 * 凭据只回答「是谁」，不回答「这个请求是不是真的来自那个渲染进程」。
 *
 * 桌面端 host 与浏览器同机同源，跨源写请求已被 `isSameOriginWrite` 挡掉，
 * 所以这一层缺口的实际暴露面比 relay 那边小 —— 但它仍然是缺口，别把
 * 「远端那一跳签了」当成「整条链路都签了」。
 */
function authenticateFrom(
  config: Config,
  credentials?: CredentialStore,
): (request: IncomingMessage) => Principal | undefined {
  const { organizationId, localAccountId } = config
  const fallbackDeviceId = config.localDeviceId ?? 'local-device'
  return () => {
    if (organizationId === undefined) return undefined
    // 每次请求都读一遍：开户和注销都会在进程存续期间改变这个答案，
    // 缓存住的话，刚开完户的第一批请求还会用旧身份
    const enrolled = credentials?.read()
    if (enrolled !== undefined) {
      return { accountId: enrolled.accountId, deviceId: enrolled.deviceId, organizationId }
    }
    if (localAccountId === undefined) return undefined
    return { accountId: localAccountId, deviceId: fallbackDeviceId, organizationId }
  }
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
  `${CHAT_API_PREFIX}/events`,
  `${CHAT_API_PREFIX}/presence`,
  `${CHAT_API_PREFIX}/presence/heartbeat`,
  `${CHAT_API_PREFIX}/presence/visibility`,
  `${CHAT_API_PREFIX}/presence/visibility/set`,
  `${CHAT_API_PREFIX}/contacts`,
  `${CHAT_API_PREFIX}/contacts/request`,
  `${CHAT_API_PREFIX}/contacts/accept`,
  `${CHAT_API_PREFIX}/contacts/reject`,
  `${CHAT_API_PREFIX}/contacts/remove`,
  // 身份三件套。**始终由本地处理，永不转发** —— 见 apply 里的说明
  `${CHAT_API_PREFIX}/identity/status`,
  `${CHAT_API_PREFIX}/identity/enroll`,
  `${CHAT_API_PREFIX}/identity/sign-out`,
  ORGANIZATION_API_PREFIX,
  `${ORGANIZATION_API_PREFIX}/workspaces`,
  `${ORGANIZATION_API_PREFIX}/projects`,
  `${ORGANIZATION_API_PREFIX}/members/invite`,
  `${ORGANIZATION_API_PREFIX}/members/accept`,
  `${ORGANIZATION_API_PREFIX}/members/me`,
  `${ORGANIZATION_API_PREFIX}/members`,
  `${ORGANIZATION_API_PREFIX}/members/role`,
  `${ORGANIZATION_API_PREFIX}/members/remove`,
  `${ORGANIZATION_API_PREFIX}/directory`,
]

/**
 * 即使配了 relay 也**不转发**的路径。
 *
 * - `/health` 报的是「这个插件活着」，不是「relay 活着」。混为一谈会让 relay
 *   挂掉时健康检查也跟着挂，分不清是插件问题还是后端问题。
 * - 身份三件套本身就是**为了建立与 relay 的会话**而存在的。把它们转发出去
 *   等于要求「先有会话才能建会话」；而且转发会原样透传 relay 的应答，
 *   token 就跟着回到浏览器了 —— 那正是这几个端点存在的原因的反面。
 */
const LOCAL_ONLY_PATHS: ReadonlySet<string> = new Set([
  `${CHAT_API_PREFIX}/health`,
  // SSE 是一条长连接，`relayProxyHandler` 那套「转发一次请求、读完整个应答」
  // 的模型套不上去 —— 套上去会一直挂到超时。relay 侧的事件推送要等 outbox
  // 消费接通，那时候这里换成一条 host↔relay 的长连接，而不是逐请求转发
  `${CHAT_API_PREFIX}/events`,
  `${CHAT_API_PREFIX}/identity/status`,
  `${CHAT_API_PREFIX}/identity/enroll`,
  `${CHAT_API_PREFIX}/identity/sign-out`,
])

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
  // 凭据文件放在库文件旁边但**是另一个文件** —— 清缓存不该把设备身份一起清掉
  const credentials = CredentialStore.beside(
    config.databasePath ?? join(process.cwd(), 'dsh-chat.db'),
  )
  const authenticate = authenticateFrom(config, credentials)
  const now = (): Date => new Date()
  let idCounter = 0
  const newId = (prefix: string): string => `${prefix}-${Date.now()}-${(idCounter += 1)}`

  // SSE 连接不是持久状态：进程重启后为空，客户端重连并从游标补拉
  const events = new EventStreamHub()
  // §48：卸载后不得残留后台任务或连接。不关的话，重载插件会留下一批
  // 永远不会被写入的 ServerResponse，浏览器那边表现为流卡住不动
  ctx.effect(() => () => events.closeAll(), `${name}: event stream hub`)

  const messageDeps: MessageCommandDeps = {
    database,
    expectedOrigin,
    authenticate,
    // 队列容量属版本化的 PlanLimits，此处取基线；组织策略化属 P0-b（§30.1）
    queueCapacity: 1000,
    leaseMs: 60_000,
    now,
    events,
  }
  const shared = { database, expectedOrigin, authenticate, now, newId }
  const presenceDeps: PresenceCommandDeps = { database, expectedOrigin, authenticate, now }
  const contactDeps: ContactCommandDeps = { database, expectedOrigin, authenticate, now, newId }
  const workspaceDeps: WorkspaceCommandDeps = shared
  const organizationDeps: OrganizationCommandDeps = shared

  // relay 客户端要在路由表之前建好：身份端点持有它，而它们不走转发
  const relay = createRelayClient(config, credentials)
  const identityDeps: IdentityRouteDeps = {
    expectedOrigin,
    authenticate,
    ...(relay === undefined ? {} : { relay }),
  }

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
    [`${CHAT_API_PREFIX}/presence`]: presenceQueryHandler(presenceDeps),
    [`${CHAT_API_PREFIX}/presence/heartbeat`]: heartbeatHandler(presenceDeps),
    [`${CHAT_API_PREFIX}/presence/visibility`]: getVisibilityHandler(presenceDeps),
    [`${CHAT_API_PREFIX}/presence/visibility/set`]: setVisibilityHandler(presenceDeps),
    [`${CHAT_API_PREFIX}/contacts`]: listContactsHandler(contactDeps),
    [`${CHAT_API_PREFIX}/contacts/request`]: requestContactHandler(contactDeps),
    [`${CHAT_API_PREFIX}/contacts/accept`]: acceptContactHandler(contactDeps),
    [`${CHAT_API_PREFIX}/contacts/reject`]: rejectContactHandler(contactDeps),
    [`${CHAT_API_PREFIX}/contacts/remove`]: removeContactHandler(contactDeps),
    [`${CHAT_API_PREFIX}/events`]: eventStreamHandler({
      hub: events,
      authenticate,
      // 游标目前恒为 '0'：收件箱游标属 §17.1 的补拉机制，那一块还没接。
      // 发一个恒定值而不是省略这个字段 —— 客户端的契约里它是必有的，
      // 少一个字段会让客户端走到「应答形状不对」那条分支
      cursorOf: () => '0',
      now,
    }),
    [`${CHAT_API_PREFIX}/identity/status`]: enrollmentStatusHandler(identityDeps),
    [`${CHAT_API_PREFIX}/identity/enroll`]: enrollHandler(identityDeps),
    [`${CHAT_API_PREFIX}/identity/sign-out`]: identitySignOutHandler(identityDeps),
    [ORGANIZATION_API_PREFIX]: createOrganizationHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/workspaces`]: createWorkspaceHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/projects`]: createProjectHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/members/invite`]: inviteMemberHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/members/accept`]: acceptMembershipHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/members/me`]: myMembershipsHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/members`]: listMembersHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/members/role`]: changeMemberRoleHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/members/remove`]: removeMemberHandler(organizationDeps),
    [`${ORGANIZATION_API_PREFIX}/directory`]: directoryHandler(contactDeps),
  }

  // relay 模式：配了地址就把业务路由换成转发。转发的例外见 LOCAL_ONLY_PATHS。
  if (relay !== undefined) {
    // 装载时协商一次。不 await —— relay 慢或不可达不该阻塞插件装载，
    // 那会让用户连设置面板都打不开。未协商完成前的调用会拿到可重试的 503
    void relay.connect()
  }

  // 所有 Cordis 注册通过 ctx.effect() 完成并返回 disposer；插件卸载后不得残留
  // 路由、后台任务或事件监听（§48 编码规范）。
  for (const path of ROUTE_PATHS) {
    const handler =
      relay !== undefined && !LOCAL_ONLY_PATHS.has(path)
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
function createRelayClient(
  config: Config,
  credentials: CredentialStore,
): RelayClient | undefined {
  const { relayUrl, relaySharedSecret } = config
  if (relayUrl === undefined || relayUrl.length === 0) return undefined
  if (relaySharedSecret === undefined || relaySharedSecret.length === 0) return undefined
  return new RelayClient({
    baseUrl: relayUrl.replace(/\/$/, ''),
    sharedSecret: relaySharedSecret,
    credentials,
    ...(config.relayFingerprint === undefined || config.relayFingerprint.length === 0
      ? {}
      : { expectedRelayFingerprint: config.relayFingerprint }),
  })
}

export { RelayClient } from './relay/client.js'
export type { RelayState } from './relay/client.js'
export * from './rate-limit.js'
