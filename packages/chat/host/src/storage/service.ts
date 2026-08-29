/**
 * 把本地数据库以 Cordis 服务的形式提供给领域插件。
 *
 * §6 的三角色划分：host 在这里是**服务提供者**，identity / organization / messaging
 * 等是**消费者**。消费者只通过本服务的接口访问数据，**不得导入某个提供者的数据库
 * 模型或绕过服务调用**。
 */

import { Service, type Context } from '@deepseek-ai/cordis'

import { ChatDatabase, type DatabaseOptions } from './database.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatDatabase: ChatDatabaseService
  }
}

export class ChatDatabaseService extends Service {
  readonly #database: ChatDatabase

  constructor(ctx: Context, options: DatabaseOptions) {
    super(ctx, 'chatDatabase')
    this.#database = ChatDatabase.open(options)

    // Cordis 没有 Service.stop；清理一律经 ctx.effect() 的 disposer 级联。
    // 不这样做，插件卸载后数据库文件句柄会残留（§48：卸载时关闭连接）。
    ctx.effect(() => () => this.#database.close(), 'chatDatabase: close connection')
  }

  /** 在一个事务中执行；领域写入、outbox 与审计必须共用同一事务（§26）。 */
  transaction<T>(body: Parameters<ChatDatabase['transaction']>[0]): T {
    return this.#database.transaction(body) as T
  }

  get readonlyHandle(): ChatDatabase['readonlyHandle'] {
    return this.#database.readonlyHandle
  }

  get schemaVersion(): number {
    return this.#database.schemaVersion
  }
}
