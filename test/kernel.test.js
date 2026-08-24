/**
 * lib/kernel.js 单元测试：配置归一化、路由真值表、Gatekeeper 状态机、消息渲染。
 *
 * 运行：node --test test/kernel.test.js
 * 说明：防抖/冷却用真实短定时器（10–60ms），避免 mock 时钟的脆弱性。
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  EVENT_KINDS,
  Gatekeeper,
  formatTime,
  normalizeChannel,
  normalizeConfig,
  renderMessage,
  routeTargets,
  shouldRoute,
  truncate,
} from '../lib/kernel.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const baseChannel = overrides => ({
  type: 'serverchan',
  enabled: true,
  serverchan: { sendKey: 'sctp123tTESTKEY' },
  ...overrides,
})

describe('EVENT_KINDS', () => {
  it('包含全部七类事件', () => {
    assert.deepEqual([...EVENT_KINDS], [
      'plan-completed',
      'loop-completed',
      'subagent-completed',
      'approval-pending',
      'agent-error',
      'workflow-completed',
      'goal-completed',
    ])
  })
})

describe('normalizeConfig', () => {
  it('空输入返回全默认值', () => {
    const config = normalizeConfig(undefined)
    assert.equal(typeof config.events['loop-completed'], 'boolean')
    assert.equal(config.dedup.cooldownMs > 0, true)
    assert.equal(config.dedup.completedDebounceMs > 0, true)
    assert.equal(config.dedup.perChannelPerMinute >= 1, true)
    assert.deepEqual(config.channels, [])
  })

  it('布尔事件开关被采纳，未知键被忽略', () => {
    const config = normalizeConfig({ events: { 'plan-completed': false, unknown: true } })
    assert.equal(config.events['plan-completed'], false)
  })

  it('非有限的去重参数回退默认值', () => {
    const config = normalizeConfig({ dedup: { cooldownMs: 'abc', perChannelPerMinute: NaN } })
    assert.equal(config.dedup.cooldownMs, 10_000)
    assert.equal(config.dedup.perChannelPerMinute, 20)
  })

  it('负数与零的去重参数被钳制到安全范围（回归：负 cooldown 曾导致永久放行语义混乱）', () => {
    const config = normalizeConfig({ dedup: { cooldownMs: -5, completedDebounceMs: -1, perChannelPerMinute: 0 } })
    assert.equal(config.dedup.cooldownMs, 0)
    assert.equal(config.dedup.completedDebounceMs, 0)
    assert.equal(config.dedup.perChannelPerMinute, 20)
  })

  it('过滤非法渠道条目', () => {
    const config = normalizeConfig({ channels: [null, { type: 42 }, baseChannel()] })
    assert.equal(config.channels.length, 1)
    assert.equal(config.channels[0].type, 'serverchan')
  })
})

describe('normalizeChannel 自动 id', () => {
  it('显式 id 原样保留', () => {
    const channel = normalizeChannel(baseChannel({ id: 'my-chan' }))
    assert.equal(channel.id, 'my-chan')
  })

  it('同配置生成确定且相同的自动 id', () => {
    const a = normalizeChannel(baseChannel())
    const b = normalizeChannel(baseChannel())
    assert.equal(a.id, b.id)
    assert.match(a.id, /^serverchan-/)
  })

  it('回归：未设 id 的同类型不同配置渠道 id 必须不同（replacer 数组哈希曾使嵌套字段丢失导致碰撞）', () => {
    const a = normalizeChannel(baseChannel({ serverchan: { sendKey: 'sctp111tAAAAAAAA' } }))
    const b = normalizeChannel(baseChannel({ serverchan: { sendKey: 'sctp222tBBBBBBBB' } }))
    assert.notEqual(a.id, b.id)
    const c = normalizeChannel({ type: 'webhook', enabled: true, webhook: { url: 'https://a.example/hook' } })
    const d = normalizeChannel({ type: 'webhook', enabled: true, webhook: { url: 'https://b.example/hook' } })
    assert.notEqual(c.id, d.id)
  })
})

describe('shouldRoute 三层开关', () => {
  const config = normalizeConfig({
    events: { 'goal-completed': false },
    channels: [baseChannel({ id: 'c1', events: { 'agent-error': false } })],
  })

  it('全局关 → 不路由（即使渠道订阅）', () => {
    assert.equal(shouldRoute(config, config.channels[0], 'goal-completed'), false)
  })

  it('渠道级关 → 不路由（即使全局开）', () => {
    assert.equal(shouldRoute(config, config.channels[0], 'agent-error'), false)
  })

  it('两层都开 → 路由；禁用渠道不路由', () => {
    assert.equal(shouldRoute(config, config.channels[0], 'plan-completed'), true)
    assert.equal(shouldRoute(config, { ...config.channels[0], enabled: false }, 'plan-completed'), false)
  })
})

describe('routeTargets', () => {
  it('只返回启用且订阅该事件的渠道', () => {
    const config = normalizeConfig({
      events: { 'agent-error': false },
      channels: [
        baseChannel({ id: 'on' }),
        baseChannel({ id: 'off', enabled: false }),
        baseChannel({ id: 'muted', events: { 'plan-completed': false } }),
      ],
    })
    const targets = routeTargets(config, 'plan-completed').map(row => row.id)
    assert.deepEqual(targets, ['on'])
  })
})

describe('Gatekeeper', () => {
  let gatekeeper

  beforeEach(() => {
    gatekeeper = new Gatekeeper(normalizeConfig({
      dedup: { cooldownMs: 60, completedDebounceMs: 20, perChannelPerMinute: 3 },
    }))
  })

  afterEach(() => {
    gatekeeper.dispose()
  })

  it('审批请求去重：重复 ask 拒绝，decided 后可再次 ask', () => {
    assert.equal(gatekeeper.noteApprovalAsked('req-1'), true)
    assert.equal(gatekeeper.noteApprovalAsked('req-1'), false)
    gatekeeper.noteApprovalDecided('req-1')
    assert.equal(gatekeeper.noteApprovalAsked('req-1'), true)
  })

  it('admit 冷却期内跳过，窗口过后放行', async () => {
    const signal = { kind: 'subagent-completed', sessionId: 's1' }
    assert.equal(gatekeeper.admit(signal).action, 'deliver')
    assert.equal(gatekeeper.admit(signal).action, 'skip')
    await sleep(80)
    assert.equal(gatekeeper.admit(signal).action, 'deliver')
  })

  it('不同会话互不共享冷却键', () => {
    assert.equal(gatekeeper.admit({ kind: 'subagent-completed', sessionId: 'a' }).action, 'deliver')
    assert.equal(gatekeeper.admit({ kind: 'subagent-completed', sessionId: 'b' }).action, 'deliver')
  })

  it('loop-completed 防抖合并：窗口内多次只交还最新信号一次', async () => {
    const received = []
    const first = gatekeeper.admit(
      { kind: 'loop-completed', sessionId: 'd1', label: 'first' },
      signal => received.push(signal),
    )
    const second = gatekeeper.admit(
      { kind: 'loop-completed', sessionId: 'd1', label: 'second' },
      signal => received.push(signal),
    )
    assert.equal(first.action, 'debounce')
    assert.equal(second.action, 'debounce')
    await sleep(60)
    assert.equal(received.length, 1)
    assert.equal(received[0].label, 'second')
  })

  it('防抖期间新信号重置计时器（旧 timer 被清除，不会提前触发）', async () => {
    const received = []
    gatekeeper.admit({ kind: 'loop-completed', sessionId: 'd2', label: 'a' }, s => received.push(s))
    await sleep(12) // 小于窗口的一半，确保仍在第一轮窗口内重置
    gatekeeper.admit({ kind: 'loop-completed', sessionId: 'd2', label: 'b' }, s => received.push(s))
    await sleep(12) // 若旧 timer 未清除，此刻已应触发一次
    assert.equal(received.length, 0)
    await sleep(40)
    assert.equal(received.length, 1)
  })

  it('dispose 后防抖回调不再触发', async () => {
    const received = []
    gatekeeper.admit({ kind: 'loop-completed', sessionId: 'd3' }, s => received.push(s))
    gatekeeper.dispose()
    await sleep(50)
    assert.equal(received.length, 0)
  })

  it('渠道限流：超过每分钟上限后拒绝', () => {
    const id = 'rate-limited'
    for (let i = 0; i < 3; i += 1) assert.equal(gatekeeper.allowChannel(id), true)
    assert.equal(gatekeeper.allowChannel(id), false)
    // 其他渠道不受影响
    assert.equal(gatekeeper.allowChannel('other'), true)
  })

  it('审批占位容量有界（异常流下 decided 丢失也不无界增长）', () => {
    for (let i = 0; i < 1200; i += 1) gatekeeper.noteApprovalAsked(`req-${i}`)
    assert.equal(gatekeeper.pendingApprovals.size <= 1000, true)
  })
})

describe('renderMessage / truncate / formatTime', () => {
  const config = normalizeConfig({ message: { titlePrefix: '[DSH]', guiUrl: 'http://127.0.0.1:3080' } })

  it('标题含前缀/严重度标记/事件中文标签/会话标签', () => {
    const { title } = renderMessage(config, { kind: 'agent-error', severity: 'error', label: '我的会话', summary: 'boom' })
    assert.match(title, /^\[DSH\]/)
    assert.match(title, /运行出错/)
    assert.match(title, /我的会话/)
  })

  it('正文包含 summary/detail/guiUrl', () => {
    const { body } = renderMessage(config, { kind: 'plan-completed', label: 'l', summary: '完成', detail: '细节' })
    assert.match(body, /完成/)
    assert.match(body, /细节/)
    assert.match(body, /http:\/\/127\.0\.0\.1:3080/)
  })

  it('超长 detail 被截断', () => {
    const { body } = renderMessage(config, { kind: 'plan-completed', label: 'l', summary: 's', detail: 'x'.repeat(2000) })
    assert.ok(body.length < 1000)
  })

  it('truncate 保留尾部省略号', () => {
    assert.equal(truncate('abcdef', 4), 'abcd…')
    assert.equal(truncate('ab', 4), 'ab')
  })

  it('formatTime 接受缺省时间戳', () => {
    assert.equal(typeof formatTime(), 'string')
    assert.equal(typeof formatTime(Date.UTC(2026, 7, 25)), 'string')
  })
})
