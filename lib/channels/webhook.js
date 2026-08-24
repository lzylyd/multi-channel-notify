/**
 * 自定义 URL 推送渠道（通用 Webhook）。
 *
 * method / headers / bodyTemplate 全部可配：
 * - `{{json}}`  —— 整体替换为 JSON.stringify({ event, title, body, sessionId, time })
 * - `{{title}}` —— 替换为消息标题（不做转义，模板作者自行决定包裹方式）
 * - `{{body}}`  —— 替换为正文文本
 *
 * bodyTemplate 为空且方法非 GET 时，默认发送 `{title, body}` JSON，
 * Content-Type 自动补 application/json——开箱兼容 ntfy/bark 等简单端点。
 */

/**
 * 展开模板占位符（纯函数）。
 */
export function renderTemplate(template, vars) {
  return String(template ?? '')
    .replaceAll('{{json}}', JSON.stringify(vars))
    .replaceAll('{{title}}', String(vars.title ?? ''))
    .replaceAll('{{body}}', String(vars.body ?? ''))
}

/**
 * 构造请求（纯函数）。
 */
export function buildRequest(channel, message, extraVars = {}) {
  const hook = channel.webhook ?? {}
  const url = String(hook.url ?? '').trim()
  if (url === '') throw new Error('webhook: 缺少 url 配置')
  const method = String(hook.method ?? 'POST').toUpperCase()
  const headers = {}
  for (const [key, value] of Object.entries(hook.headers ?? {})) {
    if (typeof key === 'string' && key !== '' && value !== undefined && value !== null) {
      headers[key] = String(value)
    }
  }
  const vars = {
    title: message.title,
    body: message.body,
    ...extraVars,
  }
  let body
  if (method === 'GET' || method === 'HEAD') {
    body = undefined
  } else if (typeof hook.bodyTemplate === 'string' && hook.bodyTemplate !== '') {
    body = renderTemplate(hook.bodyTemplate, vars)
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/json'
  } else {
    body = JSON.stringify({ title: message.title, body: message.body })
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/json'
  }
  return { url, init: { method, headers, ...(body === undefined ? {} : { body }) } }
}

/** 发送；非 2xx 抛错（由调度器统一重试/记日志）。 */
export async function send(channel, message, deps) {
  const fetchImpl = deps?.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('webhook: 运行环境无 fetch')
  const timeoutMs = Number(channel.webhook?.timeoutMs) > 0 ? Number(channel.webhook.timeoutMs) : 5000
  const { url, init } = buildRequest(channel, message)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`webhook: HTTP ${response.status} ${text.slice(0, 120)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}
