/**
 * 呈现约定测试。
 *
 * §5 的约束大多是禁止事项，靠代码审查很难保证不被违反。这些用例把其中可判定的
 * 几条钉住，让违反在 CI 阶段就暴露。
 */

import { describe, expect, it } from 'vitest'

import { ERROR_CATALOGUE, type ErrorCode } from '@dsh-chat/contract'

import {
  LOCAL_DELIVERY_STATES,
  presentDeliveryState,
  presentError,
  presentStreamState,
  STREAM_STATES,
} from './presentation.js'

describe('离线三态绝不可混淆', () => {
  it('三态各有不同的标签', () => {
    const labels = LOCAL_DELIVERY_STATES.map((s) => presentDeliveryState(s).label)
    expect(new Set(labels).size, '三态标签不可重复').toBe(3)
  })

  it('没有任何一态可以声称已送达', () => {
    // §28 第 4 步：发送方 host 把记录改为 accepted 后，
    // **不能声称消息已送达或已读**
    for (const state of LOCAL_DELIVERY_STATES) {
      expect(presentDeliveryState(state).claimsDelivered, `${state} 不得声称已送达`).toBe(false)
    }
  })

  it('accepted 的措辞是「服务器已接收」而不是「已送达」', () => {
    const presentation = presentDeliveryState('accepted')
    expect(presentation.label).toBe('服务器已接收')
    expect(presentation.label).not.toContain('已送达')
    expect(presentation.label).not.toContain('已读')
  })

  it('只有终态失败提供重试入口', () => {
    expect(presentDeliveryState('pending').offersRetry).toBe(false)
    expect(presentDeliveryState('accepted').offersRetry).toBe(false)
    expect(presentDeliveryState('failed').offersRetry).toBe(true)
  })
})

describe('错误按可重试性分级（§5）', () => {
  it('terminal 错误不提供重试按钮', () => {
    const terminalCodes = (Object.keys(ERROR_CATALOGUE) as ErrorCode[]).filter(
      (code) => ERROR_CATALOGUE[code].retryability === 'terminal',
    )
    expect(terminalCodes.length).toBeGreaterThan(0)
    for (const code of terminalCodes) {
      expect(presentError(code).offersRetry, `${code} 是 terminal，不应提供重试`).toBe(false)
    }
  })

  it('retryable 错误提供重试入口', () => {
    const retryableCodes = (Object.keys(ERROR_CATALOGUE) as ErrorCode[]).filter(
      (code) => ERROR_CATALOGUE[code].retryability === 'retryable',
    )
    expect(retryableCodes.length).toBeGreaterThan(0)
    for (const code of retryableCodes) {
      expect(presentError(code).offersRetry, `${code} 是 retryable，应提供重试`).toBe(true)
    }
  })

  it('conditional 错误要求先满足前置条件', () => {
    expect(presentError('VERSION_CONFLICT').requiresPrecondition).toBe(true)
    expect(presentError('RECIPIENT_QUEUE_FULL').requiresPrecondition).toBe(true)
  })

  it('可重试性取自错误码目录而非客户端猜测', () => {
    // §46：可重试性是错误码的固有属性，不由调用方猜测
    for (const code of Object.keys(ERROR_CATALOGUE) as ErrorCode[]) {
      expect(presentError(code).retryability).toBe(ERROR_CATALOGUE[code].retryability)
    }
  })
})

describe('不做推断性描述（§5）', () => {
  it('NOT_FOUND_OR_FORBIDDEN 不渲染为「不存在」或「无权限」', () => {
    // 服务端刻意不区分两者；客户端替它猜一个就把这层保护抹掉了
    const message = presentError('NOT_FOUND_OR_FORBIDDEN').message
    expect(message).not.toContain('不存在')
    expect(message).not.toContain('没有权限')
    expect(message).not.toContain('无权限')
  })

  it('RECIPIENT_QUEUE_FULL 的措辞体现「发送未被接收」', () => {
    // 该错误码的幂等语义是「发送未被接收」，用户据此知道可以安全重试
    const message = presentError('RECIPIENT_QUEUE_FULL').message
    expect(message).toContain('未被接收')
  })

  it('每个错误码都有面向用户的措辞，不泄露内部细节', () => {
    for (const code of Object.keys(ERROR_CATALOGUE) as ErrorCode[]) {
      const message = presentError(code).message
      expect(message.length, `${code} 缺少措辞`).toBeGreaterThan(0)
      // 不把错误码原文抛给用户
      expect(message).not.toContain(code)
    }
  })
})

describe('事件流状态必须显式呈现（§5）', () => {
  it('除已连接外的状态都必须对用户可见', () => {
    // §5：不得把事件流断开等状态表现为静默停止刷新
    for (const state of STREAM_STATES) {
      const presentation = presentStreamState(state)
      if (state === 'connected') {
        expect(presentation.mustBeVisible).toBe(false)
      } else {
        expect(presentation.mustBeVisible, `${state} 必须显式呈现`).toBe(true)
      }
    }
  })

  it('sync_diverged 时停止自动重发', () => {
    // §28.1：进入 sync_diverged 后 host 停止 ACK、自动重发与新的组织写入
    expect(presentStreamState('sync_diverged').haltsAutoResend).toBe(true)
    expect(presentStreamState('disconnected').haltsAutoResend).toBe(false)
  })

  it('每个状态都有可读标签', () => {
    for (const state of STREAM_STATES) {
      expect(presentStreamState(state).label.length).toBeGreaterThan(0)
    }
  })
})
