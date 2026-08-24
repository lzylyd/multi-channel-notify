/**
 * multi-channel-notify webServer 路由（host 端）：
 *
 * - GET  /multi-channel-notify/config —— settings 命名空间脱敏视图（value/user/base/writable/revision）
 * - POST /multi-channel-notify/config —— 逐字段 ops 落库（settings.mutate），同源校验
 * - POST /multi-channel-notify/test   —— 向指定渠道（或全部启用渠道）发送测试消息，返回逐渠道结果
 *
 * 安全：POST 要求同源（Origin/Referer 与 Host 匹配）；响应不带 CORS 头；
 * GET 只读无副作用；密钥经 describe({ redactSecrets: true }) 自动脱敏。
 */

import { ADAPTERS } from './channels/index.js'

/** 构造全部路由；返回卸载函数。 */
export function mountRoutes(webServer, { settings, namespace, dispatcher }) {
  /** 端点统一入口：本地主机围栏（防 DNS rebinding 读配置/写配置）+ 分发。 */
  const guarded = (handler) => (request, response) => {
    if (!isTrustedHost(request.headers?.host)) {
      sendJson(response, 403, { ok: false, error: 'untrusted host' })
      return
    }
    handler(request, response)
  }
  const handlers = [
    {
      kind: 'exact',
      path: '/multi-channel-notify/config',
      handler: guarded((request, response) => {
        if (request.method === 'GET') {
          sendJson(response, 200, configViewOf(settings, namespace))
          return
        }
        if (request.method === 'POST') {
          return void handleConfigPost(settings, namespace, request, response)
        }
        response.writeHead(405, { allow: 'GET, POST' })
        response.end()
      }),
    },
    {
      kind: 'exact',
      path: '/multi-channel-notify/test',
      handler: guarded((request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        return void handleTestPost({ request, response, dispatcher })
      }),
    },
  ]
  const disposers = handlers.map(route => webServer.register(route))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

// ---- 主机围栏 ----

/**
 * 本地主机白名单：Host 头的 hostname 必须是 localhost/127.0.0.1/[::1]（端口不限）。
 * 防御 DNS rebinding——攻击者域名解析到 127.0.0.1 时其 Origin 与自带 Host 头相等，
 * 仅靠 sameOrigin 可被整体绕过；本围栏以固定白名单为基准，不信任请求自证。
 * GET 也拦截：配置视图含 webhookUrl/apiUrl 等 URL 内嵌凭据（明文）。
 * 远程管理场景走 SSH 隧道（浏览器侧仍是 localhost）不受影响。
 */
export function isTrustedHost(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false
  let hostname = hostHeader
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    if (end === -1) return false
    hostname = hostname.slice(1, end)
  } else {
    const colon = hostname.lastIndexOf(':')
    if (colon !== -1) hostname = hostname.slice(0, colon)
  }
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

// ---- 配置视图与写入 ----

/** settings 描述符 → client 视图。secrets sidecar 告知表单哪些密钥位已存值。 */
function configViewOf(settings, namespace) {
  const descriptor = (settings.describe({ redactSecrets: true }) ?? [])
    .find(candidate => candidate.ns === namespace)
  if (descriptor === undefined) {
    return { status: 'unavailable', writable: settings.writable }
  }
  return {
    status: 'ready',
    value: descriptor.value,
    user: descriptor.user,
    base: descriptor.base,
    secrets: descriptor.secrets ?? [],
    writable: settings.writable,
    revision: descriptor.revision,
  }
}

async function handleConfigPost(settings, namespace, request, response) {
  if (!sameOrigin(request, true)) {
    sendJson(response, 403, { ok: false, error: 'untrusted origin' })
    return
  }
  let body
  try {
    body = JSON.parse(await readBody(request))
  } catch {
    sendJson(response, 400, { ok: false, error: 'invalid JSON body' })
    return
  }
  // 协议：{ config: 编辑态全文, expectedRevision? }
  // 密钥语义：GET 视图本就剔除已存密钥；客户端只携带「新输入」的密钥，
  // 宿主按渠道 id 把未改动渠道的已存密钥合并回来后整体落库（防脱敏回写清空）。
  const incoming = body?.config
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    sendJson(response, 400, { ok: false, error: 'invalid config' })
    return
  }
  if (typeof body.expectedRevision !== 'number') {
    // 协议必填：缺失即退化为无冲突检测的 last-writer-wins，直接拒绝
    sendJson(response, 400, { ok: false, error: 'expectedRevision (number) required' })
    return
  }
  try {
    // 必须按 ns 查找：宿主里注册顺序不定，describe() 首项几乎总是别的插件
    const current = (settings.describe() ?? []).find(candidate => candidate.ns === namespace)
    if (current === undefined) {
      sendJson(response, 503, { ok: false, error: 'namespace not registered' })
      return
    }
    const merged = mergeChannelSecrets(incoming, current.value)
    const ops = buildSectionOps(current.value, merged)
    await settings.mutate(namespace, ops, body.expectedRevision)
    sendJson(response, 200, { ok: true })
  } catch (error) {
    if (error instanceof Error && error.name === 'SettingsConflictError') {
      sendJson(response, 409, { ok: false, error: error.message })
      return
    }
    // schemastery 校验失败以 TypeError 表态（写前校验、不落盘）→ 客户端输入问题归 400
    const badRequest = error instanceof TypeError
    sendJson(response, badRequest ? 400 : 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * 按渠道 id 把「当前生效配置里的真实密钥」合并回编辑态：
 * - 编辑态该字段留空/缺省 → 继承现值（客户端拿不到明文，天然防脱敏回写清空）；
 * - 编辑态填了新值 → 覆盖（轮换密钥）；
 * - 渠道被删除 → 连同密钥一起消失；新渠道 → 只用输入值。
 * 纯函数，便于单测。
 */
export function mergeChannelSecrets(incomingConfig, currentConfig) {
  const currentChannels = Array.isArray(currentConfig?.channels) ? currentConfig.channels : []
  const incomingChannels = Array.isArray(incomingConfig?.channels) ? incomingConfig.channels : []
  const currentById = new Map(currentChannels.map(channel => [channel.id, channel]))
  const channels = incomingChannels.map(channel => {
    const existing = currentById.get(channel.id)
    if (existing === undefined) return channel
    const merged = { ...channel }
    for (const key of SECRET_FIELDS[channel.type] ?? []) {
      const provided = channel[channel.type]?.[key]
      const hasProvided = typeof provided === 'string' && provided.trim() !== ''
      if (!hasProvided) {
        const inherited = existing[channel.type]?.[key]
        if (inherited !== undefined) {
          merged[channel.type] = { ...(channel[channel.type] ?? {}), [key]: inherited }
        }
      } else {
        merged[channel.type] = { ...(channel[channel.type] ?? {}), [key]: provided }
      }
    }
    return merged
  })
  return { ...incomingConfig, channels }
}

/** settings.schema 已声明的密钥字段（与 config-schema.js 的 role('secret') 对应）。 */
const SECRET_FIELDS = {
  serverchan: ['sendKey'],
  wecom: ['secret'],
}

/** 全深度键排序稳定序列化（仅用于相等性比较）。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const entries = Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
  return `{${entries.join(',')}}`
}

/**
 * 顶层键差分：只对发生变化的段下发 set op（channels 整组替换是唯一可行写法）。
 * 比较用键序无关深比较——密钥合并会把 sendKey 追加到桶尾，JSON.stringify 直比
 * 会因键序不同而每次保存都冗余重写 channels。
 */
export function buildSectionOps(current, next) {
  const ops = []
  for (const key of ['events', 'dedup', 'message', 'channels']) {
    if (stableStringify(current?.[key]) !== stableStringify(next[key])) {
      ops.push({ op: 'set', path: [key], value: next[key] })
    }
  }
  return ops
}

// ---- 测试推送 ----

async function handleTestPost({ request, response, dispatcher }) {
  if (!sameOrigin(request, true)) {
    sendJson(response, 403, { ok: false, error: 'untrusted origin' })
    return
  }
  let body = {}
  try {
    body = JSON.parse((await readBody(request)) || '{}')
  } catch {
    sendJson(response, 400, { ok: false, error: 'invalid JSON body' })
    return
  }
  const requestedId = typeof body.channelId === 'string' ? body.channelId : undefined
  const config = dispatcher.config
  const channels = config.channels.filter(channel =>
    channel.enabled && (requestedId === undefined || channel.id === requestedId))
  if (channels.length === 0) {
    sendJson(response, 200, { ok: true, results: [], note: '没有启用的渠道可测试' })
    return
  }
  const message = renderTestMessage(config)
  const results = await Promise.all(
    channels.map(async channel => ({
      id: channel.id,
      type: channel.type,
      ok: await deliverOnce(dispatcher, channel, message),
    })),
  )
  sendJson(response, 200, { ok: results.every(row => row.ok), results })
}

function renderTestMessage(config) {
  // 延迟 import 规避循环依赖（dispatcher → kernel）
  const title = `${config.message.titlePrefix}🔔 测试通知`
  const lines = [
    '这是一条 multi-channel-notify 测试通知。',
    `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
  ]
  if (config.message.guiUrl) lines.push(`打开 DSH：${config.message.guiUrl}`)
  return { title, body: lines.join('\n') }
}

/** 单渠道一次投递（不重试），成功/失败都返回布尔。 */
async function deliverOnce(dispatcher, channel, message) {
  try {
    const adapter = ADAPTERS[channel.type]
    if (adapter === undefined) return false
    await adapter.send(channel, message, {
      exec: dispatcher.hooks.exec,
      fetch: dispatcher.hooks.fetch,
      versionText: dispatcher.hooks.versionText,
    })
    return true
  } catch (error) {
    dispatcher.hooks.logWarn?.(
      `[multi-channel-notify] 测试失败 ${channel.id}：${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}

// ---- HTTP 基础设施 ----

function sendJson(response, status, value) {
  const payload = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(payload)
}

function readBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    request.on('data', chunk => {
      total += chunk.length
      if (total > limit) {
        reject(new Error('payload too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** 同源校验：存在 Origin/Referer 时必须与请求 Host 匹配；POST 无来源头一律拒绝。 */
export function sameOrigin(request, requireOrigin) {
  const host = request.headers?.host
  const origin = request.headers?.origin ?? request.headers?.referer
  if (origin === undefined) return !requireOrigin
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
