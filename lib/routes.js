/**
 * dsh-notify webServer 路由（host 端）：
 *
 * - GET  /dsh-notify/config —— settings 命名空间脱敏视图（value/user/base/writable/revision）
 * - POST /dsh-notify/config —— 逐字段 ops 落库（settings.mutate），同源校验
 * - POST /dsh-notify/test   —— 向指定渠道（或全部启用渠道）发送测试消息，返回逐渠道结果
 *
 * 安全：POST 要求同源（Origin/Referer 与 Host 匹配）；响应不带 CORS 头；
 * GET 只读无副作用；密钥经 describe({ redactSecrets: true }) 自动脱敏。
 */

import { ADAPTERS } from './channels/index.js'

/** 构造全部路由；返回卸载函数。 */
export function mountRoutes(webServer, { settings, namespace, dispatcher }) {
  const handlers = [
    {
      kind: 'exact',
      path: '/dsh-notify/config',
      handler: (request, response) => {
        if (request.method === 'GET') {
          sendJson(response, 200, configViewOf(settings, namespace))
          return
        }
        if (request.method === 'POST') {
          return void handleConfigPost(settings, namespace, request, response)
        }
        response.writeHead(405, { allow: 'GET, POST' })
        response.end()
      },
    },
    {
      kind: 'exact',
      path: '/dsh-notify/test',
      handler: (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        return void handleTestPost({ request, response, dispatcher })
      },
    },
  ]
  const disposers = handlers.map(route => webServer.register(route))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

// ---- 配置视图与写入 ----

/** settings 描述符 → client 视图。 */
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
  if (!Array.isArray(body?.ops)) {
    sendJson(response, 400, { ok: false, error: 'invalid ops' })
    return
  }
  try {
    await settings.mutate(namespace, body.ops, typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined)
    sendJson(response, 200, { ok: true })
  } catch (error) {
    sendJson(response, 409, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

// ---- 测试推送 ----

const TEST_SIGNAL = Object.freeze({
  kind: 'loop-completed',
  label: '测试会话',
  summary: '这是一条 dsh-notify 测试通知：如果你看到它，说明该渠道链路正常。',
  detail: '',
  severity: 'info',
})

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
    '这是一条 dsh-notify 测试通知。',
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
      `[dsh-notify] 测试失败 ${channel.id}：${error instanceof Error ? error.message : String(error)}`,
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
