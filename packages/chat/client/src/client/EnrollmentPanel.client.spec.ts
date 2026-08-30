/**
 * 开户面板测试。
 *
 * 用 `renderToStaticMarkup`（理由同 `Composer.client.spec.ts`：组件有 hooks，
 * 当普通函数调会触发 Invalid hook call；这个仓库也没有 jsdom）。静态渲染摸不到
 * 键盘与提交流程，所以能抽成纯函数的判定都抽出来单独验。
 *
 * 盯得最紧的一条是**界面上任何地方都不出现私钥** —— 那是 §7 在用户可见层面的
 * 落点。让用户复制粘贴一段私钥，就是把它送进剪贴板、输入历史和截图里。
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  EnrollmentPanel,
  guessDeviceName,
  isSubmittable,
  normalizeEnrollment,
  type EnrollmentInput,
} from './EnrollmentPanel.js'

function render(): string {
  return renderToStaticMarkup(createElement(EnrollmentPanel, { onEnrolled: () => {} }))
}

const FILLED: EnrollmentInput = {
  inviteCode: 'invite-123',
  displayName: '甲',
  deviceName: '甲的笔记本',
}

describe('表单长什么样', () => {
  it('三个输入框：邀请码、名字、设备名称', () => {
    const html = render()
    expect([...html.matchAll(/<input/g)]).toHaveLength(3)
    expect(html).toContain('邀请码')
    expect(html).toContain('你的名字')
    expect(html).toContain('这台设备的名称')
  })

  it('没有让用户输入密钥的地方', () => {
    // 让用户复制粘贴一段私钥，就是把它送进剪贴板、输入历史和截图里。
    // 注意这里查的是**输入控件**，不是「私钥」这两个字 —— 下一条恰恰要求
    // 界面上写明私钥留在本机
    const html = render()
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('<textarea')
    for (const forbidden of ['PRIVATE KEY', 'privateKey', 'signingPrivateKey']) {
      expect(html, `界面上出现了「${forbidden}」`).not.toContain(forbidden)
    }
    // 三个输入框就是全部，多一个都说明有别的东西被收进来了
    expect([...html.matchAll(/<input/g)]).toHaveLength(3)
  })

  it('明说私钥不离开本机 —— 用户有权知道密钥去了哪', () => {
    expect(render()).toContain('私钥不会离开本机')
  })

  it('空表单时提交按钮是灰的', () => {
    // 灰掉而不是隐藏：按钮消失会让人以为界面坏了，灰着至少说明「还差点什么」
    expect(render()).toContain('disabled=""')
  })

  it('设备名称有个默认值，不用用户从零打', () => {
    // 三个字段里恰好有两个是空的（邀请码、名字），设备名称必须已经填好
    const html = render()
    expect(html).toContain(`value="${guessDeviceName()}"`)
    expect([...html.matchAll(/value=""/g)]).toHaveLength(2)
  })
})

describe('可提交判定', () => {
  it('三个都填了才行', () => {
    expect(isSubmittable(FILLED)).toBe(true)
    for (const key of ['inviteCode', 'displayName', 'deviceName'] as const) {
      expect(isSubmittable({ ...FILLED, [key]: '' }), `缺 ${key} 时不该可提交`).toBe(false)
    }
  })

  it('只填空格不算填了', () => {
    expect(isSubmittable({ ...FILLED, inviteCode: '   ' })).toBe(false)
  })
})

describe('归一化', () => {
  it('去掉首尾空格', () => {
    // 从聊天软件里复制邀请码常常会带上一个空格，带着提交必然失败，
    // 而失败提示说的是「这张码无法使用」—— 用户会去找管理员而不是看空格
    expect(normalizeEnrollment({ ...FILLED, inviteCode: '  invite-123 \n' }).inviteCode).toBe(
      'invite-123',
    )
  })

  it('中间的空格保留 —— 名字里有空格是正常的', () => {
    expect(normalizeEnrollment({ ...FILLED, displayName: '张 三' }).displayName).toBe('张 三')
  })
})

describe('设备名称的默认值', () => {
  it('按平台给不同的默认名', () => {
    expect(guessDeviceName('Win32')).toContain('Windows')
    expect(guessDeviceName('MacIntel')).toContain('Mac')
    expect(guessDeviceName('Linux x86_64')).toContain('Linux')
  })

  it('认不出的平台也给一个能用的名字，不留空', () => {
    // 留空的话按钮是灰的，用户得先猜出「这里要填点什么」
    expect(guessDeviceName('SomethingElse').length).toBeGreaterThan(0)
  })
})
