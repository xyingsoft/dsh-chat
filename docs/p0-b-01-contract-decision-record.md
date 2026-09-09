# P0-b-01：TOTP 业务契约决策记录

> 状态：待安全评审。本文是决策输入，不代表尚未批准的方案已经成为运行时契约。
> 日期：2026-09-07

## 已确认事实

- 现有 `packages/chat/host/src/storage/migrations.ts` 只有 `recovery_kits`，没有第二因素持久化表。
- 共享契约的错误码、审计输入和状态集合已经有统一入口。
- `SecondFactorState` 已定义 `pending_verification`、`active`、`suspended`、`revoked`，但转换边和 API 字段尚未定义。
- 请求签名的 nonce 账本证明：成功条件检查、去重记录和最终接受必须位于同一事务边界；错误请求不能抢先占用账本。

## 决策项 A：TOTP secret envelope

| 方案 | 描述 | 结论 |
|---|---|---|
| A1 | relay 保存明文 secret | 拒绝：违反“明文秘密不进入可直接读取存储”的安全边界 |
| A2 | host 保存 secret，relay 只存验证结果 | 不足：多设备/组织策略路径无法统一，且 host 备份边界未定义 |
| A3 | relay 保存由部署密钥封装的 secret（AEAD），应用层只在验证瞬间解封 | **推荐评审方向**：集中验证、可轮换、数据库泄露不直接暴露 secret；需补密钥来源、nonce、AAD、轮换和擦除规范 |
| A4 | 仅保存 secret 的不可逆哈希 | 拒绝：TOTP 是可验证但不可从哈希重建的共享秘密，无法生成验证码校验所需 HMAC |

A3 仍不是批准的实现。至少必须冻结：AEAD 算法与版本、封装格式、密钥来源/标识、nonce 长度、AAD 字段、解封失败行为、备份/迁移、内存擦除边界。

## 决策项 B：P0 API 最小范围

建议将 API 分为四个独立操作，并全部携带调用方生成的 `OperationId`：

1. `beginTotpEnrollment`：创建 `pending_verification` 因素，返回一次性展示所需材料；不返回已保存因素的 secret。
2. `confirmTotpEnrollment`：提交验证码与 `ConfirmationChallenge`，成功后原子变为 `active`，并同事务签发备用码哈希。
3. `verifyTotp`：提交验证码，先通过统一失败响应和限流，再做时间步验证与原子重放门禁。
4. `revokeTotp`：提交确认挑战；若删除最后一个强制因素则返回 `FORBIDDEN`，否则原子变为 `revoked`。

上述命名是工单级建议，不应在 contract 冻结前被视为最终 wire API。替换语义、备用码消费和设备确认仍需单独决策。

## 决策项 C：重放记录粒度

推荐以 `(factor_id, accepted_step)` 建立唯一约束，并在同一验证事务中执行“验证结果 → 严格新 step 检查 → 写入 accepted_step”。如果产品要求同一时间步跨设备只允许一次，则改为 `(account_id, accepted_step)`；该选择会改变用户体验和并发语义，必须显式决定，不能由实现隐含。

## 已落地的 contract 边界

`packages/chat/contract/src/totp.ts` 现已定义：

- P0 默认 profile、`TotpFactorId` 与 `ConfirmationChallengeId`
- 版本化 `TotpSecretEnvelope` 元数据；API 响应不含明文 secret
- 登记开始/确认、验证、撤销的最小请求/响应类型
- 验证失败统一为 `authentication_failed`，不暴露因素是否存在
- 验证成功返回 `acceptedStep`，供事务层执行重放门禁
- `packages/chat/contract/src/confirmation.ts` 定义挑战绑定账号、设备、操作 ID、操作摘要和有效期；proof 必须携带同一绑定
- `packages/chat/contract/src/key-management.ts` 定义 opaque secret-key provider 边界，业务 handler 不接触原始密钥
- 错误码目录新增 `TOTP_AUTHENTICATION_FAILED` 与 `TOTP_REPLAY_DETECTED`

这些类型只定义数据边界，不代表 HTTP 路由、密钥解封或数据库事务已经实现。`packages/chat/identity/src/totp-envelope.ts` 另提供 AES-256-GCM 纯函数封装/解封：密钥由调用方注入，AAD 必须匹配，认证失败统一拒绝；密钥来源、轮换和持久化仍由 relay 契约决定。

## 需要冻结的 contract 产物

- `TotpFactorId`、`TotpEnrollment`、`TotpVerificationRequest/Result`、`TotpRevokeRequest` 的字段和品牌 ID。
- secret envelope 版本化结构（不含明文 secret 的普通响应类型）。
- `SECOND_FACTOR_*` 错误码的 HTTP 映射、重试属性、幂等语义和统一失败文案。
- `totp_enrollment_started/confirmed/failed/replayed/revoked` 等审计事件是否采用这些名称，以及事件目标引用格式。
- 迁移编号、因素表字段、唯一约束、`last_accepted_step` 的存储方式和并发更新策略。

## 数据库迁移边界

migration 009 新增账号级 `totp_factors` 表，保存 `TotpSecretEnvelope` 的 key id、nonce、AAD、ciphertext、auth tag，以及 profile 参数和 `last_accepted_step`。表结构不含 `secret` 列；因素 ID 主键、账号索引和状态字段为后续登记/验证/撤销事务提供基础。该迁移只完成 schema 扩展，不代表业务写入路径已接通。

## 当前结论

在上述 contract 产物冻结前，继续写 HTTP handler 或数据库迁移会把 A3、重放粒度和替换语义变成不可逆事实。本轮先完成决策记录与工单拆分；可继续安全推进的代码仅限 RFC 6238 验证器和纯函数重放门禁。
