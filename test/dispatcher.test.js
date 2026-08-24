/**
 * 调度器单测：注入 fetch 的全链路（信号 → 三层路由 → 渲染 → 渠道投递）。
 * 运行：node --test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Dispatcher } from '../lib/dispatcher.js'
import { normalizeConfig } from '../lib/kernel.js'

/** 收集 HTTP 调用的 fetch mock。 */
function mockFetch(log) {
  return async (url, init) => {
    log.push({ url: String(url), body: init?.body })
    return { ok: true, json: async () => ({ errcode: 0 }) }
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('deliver 把信号渲染后投递到全部满足路由的启用渠道', async () => {
  const log = []
  const infos = []
  const dispatcher = new Dispatcher({
    config: normalizeConfig({
      channels: [
        { id: 'sc1', type: 'serverchan', enabled: true, serverchan: { sendKey: 'sctp1tK' } },
        { id: 'wh1', type: 'webhook', enabled: true, webhook: { url: 'https://hook.example/' } },
        { id: 'off', type: 'webhook', enabled: false, webhook: { url: 'https://off.example/' } },
        // 订阅矩阵退订 agent-error
        {
          id: 'muted',
          type: 'webhook',
          enabled: true,
          events: { 'agent-error': false },
          webhook: { url: 'https://muted.example/' },
        },
      ],
    }),
    hooks: { logInfo: m => infos.push(m), logWarn: () => {}, logDebug: () => {}, fetch: mockFetch(log) },
    retryBackoffMs: [10, 10],
  })
  const signal = { kind: 'agent-error', sessionId: 's', label: 'L', summary: 'S', severity: 'error' }
  await Promise.all(
    dispatcher.config.channels.map(channel =>
      channel.id === 'sc1' || channel.id === 'wh1'
        ? dispatcher.deliverToChannel(channel, renderOf(dispatcher, signal), signal.kind)
        : Promise.resolve(),
    ),
  )
  assert.deepEqual(log.map(row => new URL(row.url).host).sort(), ['1.push.ft07.com', 'hook.example'])
})

// renderMessage 直接从 kernel 引入，避免依赖私有方法
import { renderMessage } from '../lib/kernel.js'
function renderOf(dispatcher, signal) {
  return renderMessage(dispatcher.config, signal)
}

test('失败渠道自动重试，最终失败记 warn 不抛出', async () => {
  const warnings = []
  let attempts = 0
  const dispatcher = new Dispatcher({
    config: normalizeConfig({
      channels: [{ id: 'bad', type: 'webhook', enabled: true, webhook: { url: 'https://bad.example/' } }],
    }),
    hooks: {
      logWarn: m => warnings.push(m),
      logInfo: () => {},
      logDebug: () => {},
      fetch: async () => {
        attempts += 1
        return { ok: false, status: 500, text: async () => 'boom' }
      },
    },
    retryBackoffMs: [10, 10],
  })
  await dispatcher.deliverToChannel(
    dispatcher.config.channels[0],
    { title: 't', body: 'b' },
    'agent-error',
  )
  await sleep(80)
  assert.ok(attempts >= 2, `应至少重试一次（实际 ${attempts} 次）`)
  assert.equal(warnings.length, 1, '重试耗尽后恰好一条告警')
})

test('windows-toast 失败不重试（环境性错误）', async () => {
  let attempts = 0
  const dispatcher = new Dispatcher({
    config: normalizeConfig({
      channels: [{ id: 't1', type: 'windows-toast', enabled: true, windowsToast: { mode: 'native' } }],
    }),
    hooks: {
      logWarn: () => {},
      logInfo: () => {},
      logDebug: () => {},
      exec: async () => {
        attempts += 1
        throw new Error('no interop')
      },
    },
    retryBackoffMs: [10, 10],
  })
  await dispatcher.deliverToChannel(
    dispatcher.config.channels[0],
    { title: 't', body: 'b' },
    'agent-error',
  )
  await sleep(40)
  assert.equal(attempts, 1)
})

test('submit 全链路：冷却内第二条被跳过；未知类型只告警', async () => {
  const log = []
  const warnings = []
  const dispatcher = new Dispatcher({
    config: normalizeConfig({
      channels: [
        { id: 'sc1', type: 'serverchan', enabled: true, serverchan: { sendKey: 'sctp1tK' } },
        { id: 'ghost', type: 'pigeon', enabled: true },
      ],
    }),
    hooks: { logWarn: m => warnings.push(m), logInfo: () => {}, logDebug: () => {}, fetch: mockFetch(log) },
    retryBackoffMs: [10, 10],
  })
  const signal = () => ({ kind: 'approval-pending', sessionId: 's', label: 'L', summary: 'S', severity: 'warn' })
  dispatcher.submit(signal())
  await sleep(20)
  assert.equal(log.length, 1)
  dispatcher.submit(signal()) // 冷却中
  await sleep(20)
  assert.equal(log.length, 1)
  assert.equal(warnings.filter(row => row.includes('ghost')).length, 1)
})
