/**
 * 渠道适配器单测：请求构造纯函数 + 注入 mock 的端到端 send。
 * 运行：node --test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as serverchan from '../lib/channels/serverchan.js'
import * as wecom from '../lib/channels/wecom.js'
import * as windowsToast from '../lib/channels/windows-toast.js'
import * as webhook from '../lib/channels/webhook.js'
import { ADAPTERS, CHANNEL_TYPES, adapterOf } from '../lib/channels/index.js'
import { normalizeChannel } from '../lib/kernel.js'

const MESSAGE = { title: '标题 T', body: '正文 B' }

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

test('注册表覆盖四类渠道，类型清单一致', () => {
  for (const row of CHANNEL_TYPES) {
    assert.ok(ADAPTERS[row.type], `缺少适配器 ${row.type}`)
    assert.equal(typeof ADAPTERS[row.type].send, 'function')
  }
  assert.equal(adapterOf({ type: 'nope' }), undefined)
})

// ---------------------------------------------------------------------------
// serverchan
// ---------------------------------------------------------------------------

test('serverchan：从 SendKey 提取 uid 构造 URL', () => {
  assert.equal(serverchan.uidOfSendKey('sctp123tAbCdEf'), '123')
  assert.equal(serverchan.uidOfSendKey('SCT8tX'), undefined)
  const channel = normalizeChannel({ type: 'serverchan', enabled: true, serverchan: { sendKey: 'sctp42tKEY' } })
  const { url, init } = serverchan.buildRequest(channel, MESSAGE)
  assert.equal(url, 'https://42.push.ft07.com/send/sctp42tKEY.send')
  assert.equal(init.method, 'POST')
  const body = JSON.parse(init.body)
  assert.deepEqual(body, { title: '标题 T', desp: '正文 B' })
})

test('serverchan：apiUrl 优先且自动补 .send 后缀；short/tags 生效', () => {
  const channel = normalizeChannel({
    type: 'serverchan',
    enabled: true,
    serverchan: { apiUrl: 'https://example.custom/send/xyz', sendKey: 'ignored', short: '卡片', tags: 'a|b' },
  })
  const { url, init } = serverchan.buildRequest(channel, MESSAGE)
  assert.equal(url, 'https://example.custom/send/xyz.send')
  const body = JSON.parse(init.body)
  assert.equal(body.short, '卡片')
  assert.equal(body.tags, 'a|b')
})

test('回归：apiUrl 带 query 时 .send 只补到 pathname，查询串原样保留', () => {
  const channel = normalizeChannel({
    type: 'serverchan',
    enabled: true,
    serverchan: { apiUrl: 'https://example.custom/send/xyz?key=K&page=1' },
  })
  const { url } = serverchan.buildRequest(channel, MESSAGE)
  const parsed = new URL(url)
  assert.equal(parsed.pathname, '/send/xyz.send')
  assert.equal(parsed.searchParams.get('key'), 'K')
  assert.equal(parsed.searchParams.get('page'), '1')
})

test('serverchan：缺配置抛错；send 走注入的 fetch 且非 2xx 抛错', async () => {
  const empty = normalizeChannel({ type: 'serverchan', enabled: true })
  assert.throws(() => serverchan.buildRequest(empty, MESSAGE))
  const channel = normalizeChannel({ type: 'serverchan', enabled: true, serverchan: { sendKey: 'sctp1tK' } })
  const calls = []
  await serverchan.send(channel, MESSAGE, {
    fetch: async (url, init) => {
      calls.push({ url, init })
      return { ok: true }
    },
  })
  assert.equal(calls.length, 1)
  await assert.rejects(
    serverchan.send(channel, MESSAGE, { fetch: async () => ({ ok: false, status: 403, text: async () => 'denied' }) }),
    /HTTP 403/,
  )
})

// ---------------------------------------------------------------------------
// wecom
// ---------------------------------------------------------------------------

test('wecom：加签参数确定性 + 官方黄金向量（key=整串、msg 空）', () => {
  const { timestamp, sign } = wecom.signatureOf('mysecret', 1_700_000_000_000)
  assert.equal(timestamp, 1_700_000_000_000)
  assert.match(sign, /^[A-Za-z0-9+/=]+$/)
  // 黄金向量由独立实现（python hmac.new(string_to_sign, digestmod=sha256)）计算，
  // 锁定官方「整串作 key、消息为空」的加签方向，防止回退成 key=secret 的钉钉式写法
  assert.equal(sign, 'HRiyltD8KQSp0mWexCskOhD/1F1HDSpwjuNY4CYxZZI=')
})

test('wecom：无签直连 URL；有签追加 timestamp+sign query', () => {
  const plain = normalizeChannel({ type: 'wecom', enabled: true, wecom: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K' } })
  assert.equal(wecom.urlOf(plain, 111), 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K')
  const signed = normalizeChannel({ type: 'wecom', enabled: true, wecom: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K', secret: 'S' } })
  const url = wecom.urlOf(signed, 222)
  assert.ok(url.startsWith('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K&'))
  const params = new URL(url).searchParams
  assert.equal(params.get('timestamp'), '222')
  assert.ok(params.get('sign').length > 8)
})

test('wecom：markdown 消息体与 errcode 校验', async () => {
  const channel = normalizeChannel({ type: 'wecom', enabled: true, wecom: { webhookUrl: 'https://h/send?key=K' } })
  const { init } = wecom.buildRequest(channel, MESSAGE)
  const body = JSON.parse(init.body)
  assert.equal(body.msgtype, 'markdown')
  assert.ok(body.markdown.content.includes('**标题 T**'))
  let payload
  await wecom.send(channel, MESSAGE, {
    fetch: async (url, options) => {
      payload = options
      return { ok: true, json: async () => ({ errcode: 0 }) }
    },
  })
  assert.equal(payload.method, 'POST')
  await assert.rejects(
    wecom.send(channel, MESSAGE, {
      fetch: async () => ({ ok: true, json: async () => ({ errcode: 93000, errmsg: 'invalid webhook' }) }),
    }),
    /errcode=93000/,
  )
})

// ---------------------------------------------------------------------------
// windows-toast
// ---------------------------------------------------------------------------

test('windows-toast：WSL 环境判定', () => {
  assert.equal(windowsToast.isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, ''), true)
  assert.equal(windowsToast.isWsl({}, '#1 SMP ... Microsoft'), true)
  assert.equal(windowsToast.isWsl({}, ''), false)
})

test('windows-toast：模式解析 auto/native/wsl', () => {
  assert.equal(windowsToast.resolveMode({ windowsToast: { mode: 'native' } }, {}, 'linux'), 'native')
  assert.equal(windowsToast.resolveMode({ windowsToast: {} }, { WSL_DISTRO_NAME: 'U' }, 'linux'), 'wsl')
  assert.equal(windowsToast.resolveMode({ windowsToast: {} }, {}, 'win32'), 'native')
  assert.throws(() => windowsToast.resolveMode({ windowsToast: {} }, {}, 'linux'))
})

test('windows-toast：interop 探测（PATH 命中 / 兜底路径 / 缺失报错）', () => {
  // PATH 中有 powershell.exe
  const onPath = windowsToast.powershellCommand('wsl', {
    existsSync: path => path.endsWith('/usr/bin/powershell.exe'),
    pathEnv: '/usr/bin',
  })
  assert.deepEqual(onPath, { command: 'powershell.exe', args: [] })
  // 兜底 /mnt/c 全路径
  const fallback = windowsToast.powershellCommand('wsl', {
    existsSync: path => path === '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    pathEnv: '/bin',
  })
  assert.equal(fallback.command, '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
  // 完全缺失
  assert.throws(() => windowsToast.powershellCommand('wsl', { existsSync: () => false, pathEnv: '' }), /interop/)
})

test('windows-toast：单引号 here-string 字面化 + XML 实体转义 + 换行压平', () => {
  const script = windowsToast.buildScript({
    title: "It's & <b>bold</b>",
    body: 'line1\nline2\r\nline3\rlast $(calc) & "q"',
  })
  // 单引号 here-string：内容完全字面化，$() 不被求值（无需也不应做 '' 翻倍）
  assert.ok(script.includes("$template = @'"))
  assert.ok(script.includes("It's"))
  assert.ok(script.includes('$(calc)'))
  assert.ok(!script.includes('"@'))
  // XML 特殊字符必须转义，否则 XmlDocument.LoadXml 解析失败
  assert.ok(script.includes('&amp;'))
  assert.ok(script.includes('&lt;b&gt;bold&lt;/b&gt;'))
  assert.ok(script.includes('&quot;q&quot;'))
  // 换行压平必须覆盖 \n、\r\n、孤立 \r 三种形态——PowerShell tokenizer 把
  // 孤立 CR 也当换行并在其后检查 here-string 收尾符，漏掉即注入面回归
  assert.ok(!script.includes('\r'), '脚本不得包含任何 CR')
  assert.ok(!/\nline2|\nline3|\nlast/.test(script))
  assert.ok(script.includes('ToastGeneric'))
  assert.ok(script.includes('ToastNotificationManager'))
})

test('windows-toast：buildSpawn 参数形状 + exec 注入发送', async () => {
  const channel = normalizeChannel({ type: 'windows-toast', enabled: true, windowsToast: { mode: 'native' } })
  const spawn = windowsToast.buildSpawn(channel, MESSAGE, { platform: 'win32', env: {} })
  assert.equal(spawn.command, 'powershell.exe')
  assert.deepEqual(spawn.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command'])
  let received
  await windowsToast.send(channel, MESSAGE, {
    platform: 'win32',
    env: {},
    exec: async spec => {
      received = spec
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(received.command, 'powershell.exe')
})

// ---------------------------------------------------------------------------
// webhook
// ---------------------------------------------------------------------------

test('webhook：默认 POST JSON {title,body} 并补 content-type', () => {
  const channel = normalizeChannel({ type: 'webhook', enabled: true, webhook: { url: 'https://ntfy.sh/mytopic' } })
  const { url, init } = webhook.buildRequest(channel, MESSAGE)
  assert.equal(url, 'https://ntfy.sh/mytopic')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(init.body), { title: '标题 T', body: '正文 B' })
})

test('webhook：模板占位符 {{json}}/{{title}}/{{body}} 与自定义 headers/method', () => {
  const channel = normalizeChannel({
    type: 'webhook',
    enabled: true,
    webhook: {
      url: 'https://x/hook',
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'text/plain' },
      bodyTemplate: 't={{title}};b={{body}};j={{json}}',
    },
  })
  const { init } = webhook.buildRequest(channel, MESSAGE, { sessionId: 's9' })
  assert.equal(init.method, 'PUT')
  assert.equal(init.headers.authorization, 'Bearer tok')
  const body = String(init.body)
  assert.ok(body.startsWith('t=标题 T;b=正文 B;j={'))
  assert.ok(body.includes('"sessionId":"s9"'))
})

test('webhook：GET 无 body；send 非 2xx 抛错', async () => {
  const channel = normalizeChannel({ type: 'webhook', enabled: true, webhook: { url: 'https://x/', method: 'GET' } })
  const { init } = webhook.buildRequest(channel, MESSAGE)
  assert.equal(init.body, undefined)
  await assert.rejects(
    webhook.send(channel, MESSAGE, { fetch: async () => ({ ok: false, status: 500, text: async () => 'boom' }) }),
    /HTTP 500/,
  )
})

test('serverchan：HTTP 200 + errno 0 视为成功；errno 非零抛出真实原因', async () => {
  const channel = normalizeChannel({ type: 'serverchan', enabled: true, serverchan: { sendKey: 'sctp21599tabc' } })
  // 成功：code0/errno0
  await serverchan.send(channel, MESSAGE, {
    fetch: async () => ({ ok: true, text: async () => '{"code":0,"errno":0,"message":"SUCCESS"}' }),
  })
  // 失败：HTTP 200 但 errno 非零（如配额/密钥问题）
  await assert.rejects(
    serverchan.send(channel, MESSAGE, {
      fetch: async () => ({ ok: true, text: async () => '{"code":422,"errno":422,"message":"daily limit"}' }),
    }),
    /daily limit/,
  )
})
