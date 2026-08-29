/**
 * SQLite schema 与迁移。
 *
 * §29.1 的约束：schema 版本**单调递增**；迁移分五步（扩展 → 双读/双写 → 回填校验
 * → 切换读取 → 收缩）；**禁止把生产升级设计为长时间锁表的整表 `ALTER TABLE`**。
 *
 * 本文件只承载「扩展」这一步所需的 DDL —— 每次迁移只增加可空字段、新表或新索引，
 * 从不就地改列或删列。收缩步骤（删除旧字段）另行安排，且要等所有部署版本与备份
 * 恢复窗口都越过兼容期。
 *
 * ## 为什么第一版就有这么多字段
 *
 * §27 要求 L1 的 schema 从第一版起就包含 `OrganizationId`、事件 ID、操作 ID、
 * 策略修订、账户同步序列、加密元数据和恢复水位。这些字段在 P0 大多恒为默认值，
 * 但**先占位比后加列便宜得多** —— 否则 P4 引入 E2EE 时要重写消息主表。
 */

/** 一次迁移：单调递增的版本号 + 只做扩展的 DDL。 */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly statements: readonly string[]
}

/**
 * 版本 1：P0-a 的完整表结构。
 *
 * 每张业务表都带 `organization_id` —— §48 要求「缓存键、数据库查询、对象存储路径、
 * 队列分区和异步任务都必须携带 `OrganizationId`」，从 schema 层强制比在查询层
 * 靠自觉可靠。
 */
const migration001: Migration = {
  version: 1,
  name: 'p0a-initial',
  statements: [
    // ── 账号与设备 ────────────────────────────────────────────────
    `CREATE TABLE accounts (
       account_id        TEXT PRIMARY KEY,
       display_name      TEXT NOT NULL,
       email             TEXT,
       -- relay 只保存 Argon2id 验证值，绝不保存明文；P0 允许为空（设备密钥登录）
       password_verifier TEXT,
       created_at        TEXT NOT NULL,
       -- 账户级状态变更流序列，用于跨设备已读与偏好同步（§10）
       account_state_seq INTEGER NOT NULL DEFAULT 0,
       -- 注销后保留协作事实的不可逆匿名标识（§38.2），P0 恒为空
       tombstone_id      TEXT
     ) STRICT`,

    `CREATE TABLE devices (
       device_id        TEXT PRIMARY KEY,
       account_id       TEXT NOT NULL REFERENCES accounts(account_id),
       -- Ed25519 签名公钥；私钥永不上传（§7）
       signing_public_key TEXT NOT NULL,
       -- X25519 密钥协商公钥，为 P4 的 E2EE 预留
       agreement_public_key TEXT,
       key_fingerprint  TEXT NOT NULL,
       -- 取值见 contract 的设备状态；P0 使用 active / restricted / revoked
       state            TEXT NOT NULL,
       first_seen_at    TEXT NOT NULL,
       last_seen_at     TEXT NOT NULL,
       -- 设备级同步状态（§10），P0 即建立
       seen_account_state_seq INTEGER NOT NULL DEFAULT 0
     ) STRICT`,
    `CREATE INDEX idx_devices_account ON devices(account_id)`,

    // 恢复材料：relay 只保存恢复公钥与守护人策略，绝不保存可直接恢复账号的明文秘密（§7.2）
    `CREATE TABLE recovery_kits (
       account_id          TEXT PRIMARY KEY REFERENCES accounts(account_id),
       recovery_public_key TEXT NOT NULL,
       -- 守护人阈值策略，如 2/3；形状由 contract 定义
       threshold_policy    TEXT NOT NULL,
       created_at          TEXT NOT NULL
     ) STRICT`,

    // ── 邀请码（骨架第 1 步）─────────────────────────────────────
    `CREATE TABLE invite_codes (
       code             TEXT PRIMARY KEY,
       organization_id  TEXT NOT NULL,
       created_by       TEXT NOT NULL REFERENCES accounts(account_id),
       created_at       TEXT NOT NULL,
       expires_at       TEXT NOT NULL,
       -- 一次性：消费后写入使用者与时间，不删除记录（审计需要）
       consumed_by      TEXT REFERENCES accounts(account_id),
       consumed_at      TEXT
     ) STRICT`,

    // ── 组织三级层次 ──────────────────────────────────────────────
    `CREATE TABLE organizations (
       organization_id TEXT PRIMARY KEY,
       name            TEXT NOT NULL,
       -- active / suspended / archived
       state           TEXT NOT NULL,
       created_by      TEXT NOT NULL REFERENCES accounts(account_id),
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       -- 并发控制：所有变更携带版本号，冲突返回 VERSION_CONFLICT（§11.2）
       version         INTEGER NOT NULL DEFAULT 1,
       -- 策略修订号，写入审计以便复算（§48）
       policy_revision INTEGER NOT NULL DEFAULT 1
     ) STRICT`,

    `CREATE TABLE workspaces (
       workspace_id    TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
       name            TEXT NOT NULL,
       state           TEXT NOT NULL,
       created_by      TEXT NOT NULL REFERENCES accounts(account_id),
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       version         INTEGER NOT NULL DEFAULT 1
     ) STRICT`,
    `CREATE INDEX idx_workspaces_org ON workspaces(organization_id)`,

    `CREATE TABLE projects (
       project_id      TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
       workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id),
       name            TEXT NOT NULL,
       state           TEXT NOT NULL,
       created_by      TEXT NOT NULL REFERENCES accounts(account_id),
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       version         INTEGER NOT NULL DEFAULT 1
     ) STRICT`,
    `CREATE INDEX idx_projects_org ON projects(organization_id)`,

    // 成员关系：角色给出默认能力，资源 ACL 决定实际操作（§11）
    `CREATE TABLE memberships (
       membership_id   TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
       account_id      TEXT NOT NULL REFERENCES accounts(account_id),
       -- 授权作用域：organization / workspace / project
       scope_kind      TEXT NOT NULL,
       scope_id        TEXT NOT NULL,
       role            TEXT NOT NULL,
       -- invited / active / suspended / removed
       state           TEXT NOT NULL,
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       version         INTEGER NOT NULL DEFAULT 1,
       policy_revision INTEGER NOT NULL DEFAULT 1
     ) STRICT`,
    `CREATE UNIQUE INDEX idx_memberships_unique
       ON memberships(organization_id, account_id, scope_kind, scope_id)`,
    `CREATE INDEX idx_memberships_account ON memberships(organization_id, account_id)`,

    // ── 联系人与拉黑 ──────────────────────────────────────────────
    `CREATE TABLE contact_requests (
       request_id      TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL,
       requester_id    TEXT NOT NULL REFERENCES accounts(account_id),
       target_id       TEXT NOT NULL REFERENCES accounts(account_id),
       -- pending / accepted / rejected / expired
       state           TEXT NOT NULL,
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       expires_at      TEXT NOT NULL
     ) STRICT`,
    `CREATE INDEX idx_contact_requests_target
       ON contact_requests(organization_id, target_id, state)`,

    // 拉黑不是联系人状态，而是有向记录（§13）
    `CREATE TABLE blocks (
       organization_id  TEXT NOT NULL,
       actor_account_id TEXT NOT NULL REFERENCES accounts(account_id),
       subject_account_id TEXT NOT NULL REFERENCES accounts(account_id),
       created_at       TEXT NOT NULL,
       PRIMARY KEY (organization_id, actor_account_id, subject_account_id)
     ) STRICT`,

    // ── 消息与投递 ────────────────────────────────────────────────
    `CREATE TABLE messages (
       -- 客户端生成的 UUIDv7（§14）
       message_id       TEXT NOT NULL,
       organization_id  TEXT NOT NULL,
       sender_id        TEXT NOT NULL REFERENCES accounts(account_id),
       recipient_id     TEXT NOT NULL REFERENCES accounts(account_id),
       -- P0 只有 text
       kind             TEXT NOT NULL,
       body             TEXT NOT NULL,
       -- 单调递增；编辑追加事件而非覆盖，初始为 1（§14.1）
       revision         INTEGER NOT NULL DEFAULT 1,
       created_at       TEXT NOT NULL,
       received_at      TEXT NOT NULL,
       -- 幂等键与事件格式版本
       operation_id     TEXT NOT NULL,
       event_format_version INTEGER NOT NULL,
       -- P0 恒为 {"scheme":"none","keyEpoch":0,"formatVersion":1}，为 P4 预留
       encryption_meta  TEXT NOT NULL,
       -- (senderAccountId, MessageId) 是幂等键（§14）
       PRIMARY KEY (sender_id, message_id)
     ) STRICT`,
    `CREATE INDEX idx_messages_recipient
       ON messages(organization_id, recipient_id, received_at)`,

    // 收件人队列：relay 为每个队列项分配单调 DeliverySeq，按接收人分区（§28）
    `CREATE TABLE delivery_queue (
       organization_id TEXT NOT NULL,
       recipient_id    TEXT NOT NULL REFERENCES accounts(account_id),
       delivery_seq    INTEGER NOT NULL,
       sender_id       TEXT NOT NULL,
       message_id      TEXT NOT NULL,
       created_at      TEXT NOT NULL,
       -- 租约：每个设备同时只允许一个有效的拉取批次（§28）
       lease_device_id TEXT,
       lease_expires_at TEXT,
       -- ACK 后置位；不删除记录，保留期内可复查
       acked_at        TEXT,
       acked_device_id TEXT,
       PRIMARY KEY (organization_id, recipient_id, delivery_seq)
     ) STRICT`,
    `CREATE INDEX idx_delivery_pending
       ON delivery_queue(organization_id, recipient_id, acked_at)`,

    // 每个私聊队列分区的流代次与高水位，不可回退（§28.1）
    `CREATE TABLE stream_state (
       organization_id TEXT NOT NULL,
       partition_key   TEXT NOT NULL,
       stream_epoch    INTEGER NOT NULL DEFAULT 1,
       high_watermark  INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (organization_id, partition_key)
     ) STRICT`,

    // ── 工作项 ────────────────────────────────────────────────────
    `CREATE TABLE work_items (
       work_item_id    TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
       project_id      TEXT NOT NULL REFERENCES projects(project_id),
       title           TEXT NOT NULL,
       description     TEXT NOT NULL DEFAULT '',
       priority        TEXT NOT NULL,
       assignee_id     TEXT REFERENCES accounts(account_id),
       -- draft / open / assigned / in_progress / blocked / in_review / done / cancelled / archived
       state           TEXT NOT NULL,
       -- 独立于工作项状态的签收状态机（§17）
       acknowledgement_state TEXT,
       due_at          TEXT,
       created_by      TEXT NOT NULL REFERENCES accounts(account_id),
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL,
       version         INTEGER NOT NULL DEFAULT 1
     ) STRICT`,
    `CREATE INDEX idx_work_items_project ON work_items(organization_id, project_id)`,
    `CREATE INDEX idx_work_items_assignee ON work_items(organization_id, assignee_id)`,

    // 依赖是同项目内的显式引用，创建时校验不成环（§17）
    `CREATE TABLE work_item_dependencies (
       organization_id TEXT NOT NULL,
       from_id         TEXT NOT NULL REFERENCES work_items(work_item_id),
       to_id           TEXT NOT NULL REFERENCES work_items(work_item_id),
       -- blocks / depends_on
       kind            TEXT NOT NULL,
       created_at      TEXT NOT NULL,
       PRIMARY KEY (organization_id, from_id, to_id, kind)
     ) STRICT`,

    // ── 通知 ──────────────────────────────────────────────────────
    // 持久化收件箱记录，不是 SSE 推送本身（§17.1）
    `CREATE TABLE notifications (
       notification_id TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL,
       recipient_id    TEXT NOT NULL REFERENCES accounts(account_id),
       event_type      TEXT NOT NULL,
       resource_ref    TEXT NOT NULL,
       actor_id        TEXT REFERENCES accounts(account_id),
       summary         TEXT NOT NULL,
       priority        TEXT NOT NULL,
       -- queued / delivered / seen / read / dismissed / expired / failed
       state           TEXT NOT NULL,
       created_at      TEXT NOT NULL,
       -- 去重键防止同一领域事件重复投递产生多条记录（§17.1）
       dedupe_key      TEXT NOT NULL
     ) STRICT`,
    `CREATE UNIQUE INDEX idx_notifications_dedupe
       ON notifications(organization_id, recipient_id, dedupe_key)`,
    `CREATE INDEX idx_notifications_inbox
       ON notifications(organization_id, recipient_id, state, created_at)`,

    // ── 审计 ──────────────────────────────────────────────────────
    // 仅追加。§37 的字段清单；审计表中不含任何消息正文（§43 第 14 步）
    `CREATE TABLE audit_events (
       audit_event_id  TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL,
       event_type      TEXT NOT NULL,
       occurred_at     TEXT NOT NULL,
       -- 服务端序列号，单调递增
       server_seq      INTEGER NOT NULL,
       actor_account_id TEXT,
       device_id       TEXT,
       source_ip_prefix TEXT,
       coarse_region   TEXT,
       target_ref      TEXT NOT NULL,
       -- 成功或被拒绝；被拒绝的越权尝试同样留下记录（§43 第 14 步）
       outcome         TEXT NOT NULL,
       error_code      TEXT,
       policy_revision INTEGER NOT NULL,
       operation_id    TEXT,
       related_event_id TEXT,
       trace_id        TEXT
     ) STRICT`,
    `CREATE UNIQUE INDEX idx_audit_seq ON audit_events(organization_id, server_seq)`,
    `CREATE INDEX idx_audit_lookup ON audit_events(organization_id, occurred_at)`,

    // ── 事务 outbox ───────────────────────────────────────────────
    // §26：领域对象与 outbox 在同一事务写入，提交后异步投递；
    // outbox 任务可以重复执行，消费方以事件 ID 去重
    `CREATE TABLE outbox (
       event_id        TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL,
       event_type      TEXT NOT NULL,
       payload         TEXT NOT NULL,
       event_format_version INTEGER NOT NULL,
       created_at      TEXT NOT NULL,
       -- queued / running / retrying / succeeded / failed / cancelled / dead_letter
       task_state      TEXT NOT NULL DEFAULT 'queued',
       attempts        INTEGER NOT NULL DEFAULT 0,
       next_attempt_at TEXT,
       last_error      TEXT
     ) STRICT`,
    `CREATE INDEX idx_outbox_pending ON outbox(task_state, next_attempt_at)`,
  ],
}

/**
 * 版本 2：请求签名的 nonce 账本。
 *
 * §7.1 要求 relay「拒绝过期时间戳、**重复 nonce**、未注册或被限制设备」。
 * 拒绝重复 nonce 需要记住已见过的 nonce —— 这是唯一必须新增的状态。
 *
 * 按 §29.1 只做扩展：新表，不动既有列。
 */
const migration002: Migration = {
  version: 2,
  name: 'request-signing-nonces',
  statements: [
    // 主键是 (device_id, nonce) 而不是 nonce 单列：nonce 由各设备自行生成，
    // 两台设备偶然生成同一个值不该让后者的请求被判为重放。
    //
    // seen_at 用于按容忍窗口清理 —— 账本无限增长的话，一台设备跑一年就是
    // 几千万行，而窗口外的 nonce 早已因时间戳检查而无法使用，留着没有意义。
    `CREATE TABLE request_nonces (
       device_id TEXT NOT NULL,
       nonce     TEXT NOT NULL,
       seen_at   TEXT NOT NULL,
       PRIMARY KEY (device_id, nonce)
     ) STRICT`,
    `CREATE INDEX idx_request_nonces_expiry ON request_nonces(seen_at)`,
  ],
}

/** 全部迁移，按版本升序。新增迁移只能追加，不能修改既有条目。 */
export const MIGRATIONS: readonly Migration[] = [migration001, migration002]
