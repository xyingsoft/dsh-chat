/**
 * 限流测试。
 *
 * §44.1.2 把「**限流在各维度按最严格者生效**」列为 `P0-a` 的验收项，
 * 所以多维度那组用例是这里的重点。
 */

import { describe, expect, it } from 'vitest'

import { BASELINE_LIMITS, RateLimiter, type LimitRule } from './rate-limit.js'

const T0 = new Date('2026-08-30T12:00:00Z')
const at = (ms: number): Date => new Date(T0.getTime() + ms)

const perMinute = (limit: number, burst?: number): LimitRule => ({
  dimension: 'account',
  limit,
  windowMs: 60_000,
  ...(burst === undefined ? {} : { burst }),
})

describe('滑动窗口', () => {
  it('限额内放行', () => {
    const limiter = new RateLimiter()
    const rules = [perMinute(3)]
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check(rules, { account: 'jia' }, at(i)).allowed).toBe(true)
    }
  })

  it('超限拒绝', () => {
    const limiter = new RateLimiter()
    const rules = [perMinute(3)]
    for (let i = 0; i < 3; i += 1) limiter.check(rules, { account: 'jia' }, at(i))
    expect(limiter.check(rules, { account: 'jia' }, at(4)).allowed).toBe(false)
  })

  it('窗口滑过后恢复', () => {
    const limiter = new RateLimiter()
    const rules = [perMinute(2)]
    limiter.check(rules, { account: 'jia' }, at(0))
    limiter.check(rules, { account: 'jia' }, at(1000))
    expect(limiter.check(rules, { account: 'jia' }, at(2000)).allowed).toBe(false)
    // 第一次命中滑出窗口
    expect(limiter.check(rules, { account: 'jia' }, at(60_001)).allowed).toBe(true)
  })

  it('retryAfter 指向额度真正恢复的时刻', () => {
    const limiter = new RateLimiter()
    const rules = [perMinute(1)]
    limiter.check(rules, { account: 'jia' }, at(0))
    const denied = limiter.check(rules, { account: 'jia' }, at(10_000))
    expect(denied.retryAfterMs).toBe(50_000)
    // 按建议等待后确实能通过
    expect(limiter.check(rules, { account: 'jia' }, at(10_000 + 50_000)).allowed).toBe(true)
  })

  it('被拒时不记命中，重试不会把窗口越推越远', () => {
    // 否则一个被限流的调用方疯狂重试会形成事实上的永久封禁，
    // 而 §30.1 的限流是保护措施不是处罚
    const limiter = new RateLimiter()
    const rules = [perMinute(1)]
    limiter.check(rules, { account: 'jia' }, at(0))
    for (let i = 1; i <= 20; i += 1) limiter.check(rules, { account: 'jia' }, at(i * 1000))
    // 首次命中 60 秒后就该恢复，不受这 20 次被拒的重试影响
    expect(limiter.check(rules, { account: 'jia' }, at(60_001)).allowed).toBe(true)
  })

  it('突发额度让正常连发通过', () => {
    // 不设突发的话，正常使用中的一次连发就会被拒 ——
    // 限流本意是防滥用，不是防手快
    const limiter = new RateLimiter()
    const rules = [perMinute(3, 2)]
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.check(rules, { account: 'jia' }, at(i)).allowed, `第 ${i + 1} 次`).toBe(true)
    }
    expect(limiter.check(rules, { account: 'jia' }, at(6)).allowed).toBe(false)
  })
})

describe('维度隔离', () => {
  it('不同账号互不影响', () => {
    const limiter = new RateLimiter()
    const rules = [perMinute(1)]
    limiter.check(rules, { account: 'jia' }, at(0))
    expect(limiter.check(rules, { account: 'yi' }, at(1)).allowed).toBe(true)
  })

  it('同一账号在不同规则下是独立的桶', () => {
    // 否则发消息会消耗搜索额度
    const limiter = new RateLimiter()
    const send: LimitRule[] = [{ dimension: 'account', limit: 1, windowMs: 60_000 }]
    const search: LimitRule[] = [{ dimension: 'account', limit: 1, windowMs: 10_000 }]
    limiter.check(send, { account: 'jia' }, at(0))
    expect(limiter.check(search, { account: 'jia' }, at(1)).allowed).toBe(true)
  })

  it('没有对应取值的维度被跳过', () => {
    // §30.1 说的是「relay **能可靠识别的** IP」。识别不了就不该按它限流，
    // 否则所有识别不出 IP 的请求会共用一个桶，互相拖累
    const limiter = new RateLimiter()
    const rules: LimitRule[] = [
      { dimension: 'account', limit: 10, windowMs: 60_000 },
      { dimension: 'ip', limit: 1, windowMs: 60_000 },
    ]
    limiter.check(rules, { account: 'jia' }, at(0))
    expect(limiter.check(rules, { account: 'jia' }, at(1)).allowed).toBe(true)
  })
})

describe('多维度按最严格者生效（§44.1.2 验收项）', () => {
  const rules: LimitRule[] = [
    { dimension: 'account', limit: 10, windowMs: 60_000 },
    { dimension: 'device', limit: 2, windowMs: 60_000 },
  ]
  const keys = { account: 'jia', device: 'jia-laptop' }

  it('任一维度超限即拒绝', () => {
    const limiter = new RateLimiter()
    limiter.check(rules, keys, at(0))
    limiter.check(rules, keys, at(1))
    // 账号维度还有 8 次额度，但设备维度已满
    expect(limiter.check(rules, keys, at(2)).allowed).toBe(false)
  })

  it('换一台设备时账号维度仍在计量', () => {
    // 「最严格者」不是「只看最严的那一维」—— 宽的那一维照样要累加，
    // 否则换设备就能绕过账号级限额
    const limiter = new RateLimiter()
    for (let device = 0; device < 5; device += 1) {
      for (let i = 0; i < 2; i += 1) {
        limiter.check(rules, { account: 'jia', device: `d-${device}` }, at(device * 10 + i))
      }
    }
    // 账号维度已累计 10 次
    expect(limiter.check(rules, { account: 'jia', device: 'd-new' }, at(100)).allowed).toBe(false)
  })

  it('retryAfter 取最晚恢复的维度', () => {
    // 报最早的话，用户按提示重试仍然被拒 —— 那比不给建议更糟，
    // 因为它把「还要等」说成了「可以试了」
    const limiter = new RateLimiter()
    const mixed: LimitRule[] = [
      { dimension: 'account', limit: 1, windowMs: 10_000 },
      { dimension: 'device', limit: 1, windowMs: 60_000 },
    ]
    limiter.check(mixed, keys, at(0))
    const denied = limiter.check(mixed, keys, at(1000))
    expect(denied.retryAfterMs).toBe(59_000)
    // 按建议等待后确实通过
    expect(limiter.check(mixed, keys, at(1000 + 59_000)).allowed).toBe(true)
  })

  it('某一维度拒绝时其他维度不白扣额度', () => {
    // 逐个维度边判边记的话，后面的维度拒绝了，前面的已经白扣一次
    const limiter = new RateLimiter()
    const mixed: LimitRule[] = [
      { dimension: 'account', limit: 5, windowMs: 60_000 },
      { dimension: 'device', limit: 1, windowMs: 60_000 },
    ]
    limiter.check(mixed, keys, at(0))
    for (let i = 0; i < 3; i += 1) limiter.check(mixed, keys, at(1000 + i))
    // 换设备后账号维度应该只用掉 1 次，还剩 4 次
    for (let i = 0; i < 4; i += 1) {
      expect(
        limiter.check(mixed, { account: 'jia', device: 'other' }, at(10_000 + i)).allowed,
        `换设备后第 ${i + 1} 次`,
      ).toBe(i < 1)
    }
  })
})

describe('限流不是授权判定（§30.1）', () => {
  it('判定结果里没有任何授权信息', () => {
    // 一个「限流通过就放行」的中间件看起来很自然，但它把两件事绑在一起，
    // 日后放宽限流就会意外放宽授权
    const decision = new RateLimiter().check([perMinute(1)], { account: 'jia' }, T0)
    expect(Object.keys(decision).sort()).toEqual(['allowed', 'diagnostic', 'retryAfterMs'])
  })

  it('维度名只进诊断，不返回给用户', () => {
    // 告诉用户「你在 IP 维度超限了」等于泄露同 IP 其他人的用量（§46）
    const limiter = new RateLimiter()
    const rules: LimitRule[] = [{ dimension: 'ip', limit: 1, windowMs: 60_000 }]
    limiter.check(rules, { ip: '203.0.113.0/24' }, at(0))
    const denied = limiter.check(rules, { ip: '203.0.113.0/24' }, at(1))
    expect(denied.diagnostic).toContain('ip')
    // 诊断字段是给服务端日志的，用户可见的只有 allowed 与 retryAfterMs
    expect(denied.retryAfterMs).toBeDefined()
  })
})

describe('基线来自配置而非硬编码', () => {
  it('BASELINE_LIMITS 与 §30.1 表一致', () => {
    const send = BASELINE_LIMITS['message.send']?.[0]
    expect(send?.limit).toBe(30)
    expect(send?.burst).toBe(10)
    expect(send?.windowMs).toBe(60_000)
    expect(BASELINE_LIMITS['search.query']?.[0]?.limit).toBe(10)
    expect(BASELINE_LIMITS['contact.request']?.[0]?.limit).toBe(20)
    expect(BASELINE_LIMITS['export.request']?.[0]?.limit).toBe(2)
  })

  it('check 接受任意规则，不引用 BASELINE_LIMITS', () => {
    // §30.1：「实现必须从配置读取」。基线只是配置缺失时的起点
    const limiter = new RateLimiter()
    const custom: LimitRule[] = [{ dimension: 'account', limit: 1, windowMs: 1000 }]
    limiter.check(custom, { account: 'jia' }, at(0))
    expect(limiter.check(custom, { account: 'jia' }, at(1)).allowed).toBe(false)
  })
})

describe('生命周期', () => {
  it('过期的桶被清理，Map 不无限增长', () => {
    const limiter = new RateLimiter()
    const rules = [perMinute(10)]
    for (let i = 0; i < 100; i += 1) limiter.check(rules, { account: `a-${i}` }, at(i))
    expect(limiter.size).toBe(100)
    expect(limiter.prune(at(200_000), 60_000)).toBe(100)
    expect(limiter.size).toBe(0)
  })

  it('清理不影响窗口内仍有效的桶', () => {
    const limiter = new RateLimiter()
    const rules = [perMinute(1)]
    limiter.check(rules, { account: 'old' }, at(0))
    limiter.check(rules, { account: 'fresh' }, at(120_000))
    limiter.prune(at(130_000), 60_000)
    expect(limiter.check(rules, { account: 'fresh' }, at(130_001)).allowed).toBe(false)
  })

  it('clear 清空全部状态', () => {
    const limiter = new RateLimiter()
    limiter.check([perMinute(1)], { account: 'jia' }, at(0))
    limiter.clear()
    expect(limiter.size).toBe(0)
    expect(limiter.check([perMinute(1)], { account: 'jia' }, at(1)).allowed).toBe(true)
  })
})
