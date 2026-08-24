/**
 * lib/routes.js 纯函数单测：密钥合并语义 + 同源校验。
 *
 * 运行：node --test test/routes.test.js
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildSectionOps, isTrustedHost, mergeChannelSecrets, sameOrigin } from '../lib/routes.js'

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

/** 键序不同的深比较辅助：验证 buildSectionOps 不因键序误判。 */
const sortDeep = value => {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortDeep(value[k])]))
  }
  return value
}

describe('buildSectionOps', () => {
  it('值相等但键序不同（密钥合并追加到桶尾）→ 零 ops，不冗余重写', () => {
    const current = { events: {}, dedup: {}, message: {}, channels: [{ id: 'c1', type: 'serverchan', enabled: true, serverchan: { sendKey: 'K', apiUrl: 'https://x' } }] }
    // 模拟合并结果：apiUrl 在前、sendKey 追加在尾（与 schema 声明序相反）
    const next = { events: {}, dedup: {}, message: {}, channels: [{ id: 'c1', type: 'serverchan', enabled: true, serverchan: { apiUrl: 'https://x', sendKey: 'K' } }] }
    assert.deepEqual(buildSectionOps(current, next), [])
  })

  it('真实变化 → 对应段下发 set op', () => {
    const current = { events: { a: true }, dedup: {}, message: {}, channels: [] }
    const ops = buildSectionOps(current, { ...current, events: { a: false }, channels: [{ id: 'n' }] })
    assert.equal(ops.length, 2)
    assert.deepEqual(ops.map(op => op.path), [['events'], ['channels']])
  })

  it('回归：改渠道 type 后旧类型桶不残留', () => {
    const current = { channels: [] }
    const incoming = { channels: [{ id: 'c1', type: 'wecom', enabled: true, wecom: {} }] }
    const merged = mergeChannelSecrets(incoming, current)
    assert.equal('serverchan' in merged.channels[0], false)
  })

  it('非字符串 provided 视同未提供 → 继承已存密钥（直连 API 写垃圾类型不致损毁）', () => {
    const current = { channels: [{ id: 'c1', type: 'wecom', enabled: true, wecom: { secret: 'REAL' } }] }
    const incoming = { channels: [{ id: 'c1', type: 'wecom', enabled: true, wecom: { secret: 42 } }] }
    const merged = mergeChannelSecrets(incoming, current)
    assert.equal(merged.channels[0].wecom.secret, 'REAL')
  })

  it('重复渠道 id：按首个匹配合并（手工构造 POST 的边界行为钉住）', () => {
    const current = { channels: [{ id: 'dup', type: 'wecom', enabled: true, wecom: { secret: 'S' } }] }
    const incoming = { channels: [
      { id: 'dup', type: 'wecom', enabled: true, wecom: {} },
      { id: 'dup', type: 'wecom', enabled: true, wecom: {} },
    ] }
    const merged = mergeChannelSecrets(incoming, current)
    assert.equal(merged.channels[0].wecom.secret, 'S')
    assert.equal(merged.channels[1].wecom.secret, 'S')
  })
})

describe('isTrustedHost', () => {
  it('localhost/127.0.0.1/[::1] 任意端口放行', () => {
    for (const host of ['localhost:3080', '127.0.0.1:3080', '[::1]:3080', 'localhost']) {
      assert.equal(isTrustedHost(host), true, host)
    }
  })

  it('外部域名（含解析到本机的 rebinding 域）拒绝', () => {
    for (const host of ['evil.example:3080', '192.168.1.5:3080', 'localhost.evil.com', '', undefined]) {
      assert.equal(isTrustedHost(host), false, String(host))
    }
  })

  it('畸形 IPv6 拒绝', () => {
    assert.equal(isTrustedHost('[::1'), false)
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

  it('有 Origin 无 Host 拒绝；Referer 与 Host 不匹配拒绝；端口不同拒绝', () => {
    assert.equal(sameOrigin(requestWith({ origin: 'http://127.0.0.1:3080' }), true), false)
    assert.equal(sameOrigin(requestWith({ host: '127.0.0.1:3080', referer: 'http://127.0.0.1:9999/x' }), true), false)
    assert.equal(sameOrigin(requestWith({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' }), true), false)
  })
})
