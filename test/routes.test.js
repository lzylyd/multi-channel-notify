/**
 * lib/routes.js 纯函数单测：密钥合并语义 + 同源校验。
 *
 * 运行：node --test test/routes.test.js
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mergeChannelSecrets, sameOrigin } from '../lib/routes.js'

/** 构造最小渠道对象。 */
const channelOf = (id, type, bucket = {}) => ({ id, type, enabled: true, [type]: bucket })

describe('mergeChannelSecrets', () => {
  const current = {
    channels: [
      channelOf('sc-keep', 'serverchan', { sendKey: 'OLD_KEY', apiUrl: 'https://x' }),
      channelOf('wecom-keep', 'wecom', { secret: 'OLD_SECRET' }),
    ],
  }

  it('留空密钥 → 继承已存值（防脱敏回写清空）', () => {
    const incoming = {
      channels: [
        // sendKey 缺失（GET 脱敏视图里本来就没有）
        { id: 'sc-keep', type: 'serverchan', enabled: true, serverchan: { apiUrl: 'https://y' } },
      ],
    }
    const merged = mergeChannelSecrets(incoming, current)
    assert.equal(merged.channels[0].serverchan.sendKey, 'OLD_KEY')
    assert.equal(merged.channels[0].serverchan.apiUrl, 'https://y')
  })

  it('输入新密钥 → 覆盖（轮换场景）', () => {
    const incoming = {
      channels: [{ id: 'wecom-keep', type: 'wecom', enabled: true, wecom: { secret: 'NEW_SECRET' } }],
    }
    const merged = mergeChannelSecrets(incoming, current)
    assert.equal(merged.channels[0].wecom.secret, 'NEW_SECRET')
  })

  it('空白字符串视同未提供（不覆盖为空）', () => {
    const incoming = {
      channels: [{ id: 'sc-keep', type: 'serverchan', enabled: true, serverchan: { sendKey: '   ' } }],
    }
    const merged = mergeChannelSecrets(incoming, current)
    assert.equal(merged.channels[0].serverchan.sendKey, 'OLD_KEY')
  })

  it('删除的渠道连同密钥消失；新增渠道原样保留', () => {
    const incoming = {
      channels: [
        channelOf('brand-new', 'serverchan', { sendKey: 'FRESH' }),
        channelOf('wecom-keep', 'wecom', {}),
      ],
    }
    const merged = mergeChannelSecrets(incoming, current)
    assert.deepEqual(merged.channels.map(c => c.id), ['brand-new', 'wecom-keep'])
    assert.equal(merged.channels[0].serverchan.sendKey, 'FRESH')
    assert.equal(merged.channels[1].wecom.secret, 'OLD_SECRET')
  })

  it('非密钥字段以编辑态为准（即使与现值不同）', () => {
    const incoming = {
      channels: [{ id: 'sc-keep', type: 'serverchan', enabled: false, serverchan: {} }],
    }
    const merged = mergeChannelSecrets(incoming, current)
    assert.equal(merged.channels[0].enabled, false)
    assert.equal(merged.channels[0].serverchan.apiUrl, undefined)
    assert.equal(merged.channels[0].serverchan.sendKey, 'OLD_KEY')
  })
})

describe('sameOrigin', () => {
  const requestWith = headers => ({ headers })

  it('写请求缺 Origin/Referer 一律拒绝；读请求放行', () => {
    assert.equal(sameOrigin(requestWith({}), true), false)
    assert.equal(sameOrigin(requestWith({}), false), true)
  })

  it('Origin 与 Host 匹配才放行', () => {
    const ok = requestWith({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })
    const evil = requestWith({ host: '127.0.0.1:3080', origin: 'http://evil.example' })
    assert.equal(sameOrigin(ok, true), true)
    assert.equal(sameOrigin(evil, true), false)
  })

  it('Referer 亦可作为来源依据', () => {
    const req = requestWith({ host: '127.0.0.1:3080', referer: 'http://127.0.0.1:3080/settings' })
    assert.equal(sameOrigin(req, true), true)
  })

  it('畸形 Origin 拒绝', () => {
    assert.equal(sameOrigin(requestWith({ host: 'h', origin: '::not-a-url' }), true), false)
  })
})
