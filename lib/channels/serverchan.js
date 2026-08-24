/**
 * Server酱³ 渠道适配器。
 *
 * API：`https://<uid>.push.ft07.com/send/<sendkey>.send`
 * - uid 可从 sendkey 提取（`/^sctp(\d+)t/`），也可由用户直接填完整 apiUrl；
 * - POST application/json：{ title, desp(markdown), short?, tags? }。
 * 文档：https://github.com/easychen/serverchan3-doc
 */

/**
 * 从 SendKey 提取 uid（`sctp123tXXX` → `123`）；提取失败返回 undefined。
 */
export function uidOfSendKey(sendKey) {
  const match = /^sctp(\d+)t/.exec(String(sendKey ?? ''))
  return match === null ? undefined : match[1]
}

/** 由 sendkey 或 apiUrl 求出最终请求 URL；两者都缺失返回 undefined。 */
export function endpointOf(channel) {
  const raw = String(channel.serverchan?.apiUrl ?? '').trim()
  if (raw !== '') {
    // 用户直接从 SendKey 页复制的完整 API URL（允许带或不带 .send 后缀）。
    // 后缀只看 pathname：带 query（?xxx=…）的 URL 不能用 endsWith 判断，
    // 否则会把 .send 追加到查询串末尾导致请求路径损坏。
    try {
      const parsed = new URL(raw)
      if (!parsed.pathname.endsWith('.send')) parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}.send`
      return parsed.toString()
    } catch {
      // 非合法 URL 时退回朴素处理，交由 fetch 报错
      return raw.endsWith('.send') ? raw : `${raw.replace(/\/$/, '')}.send`
    }
  }
  const sendKey = String(channel.serverchan?.sendKey ?? '').trim()
  if (sendKey === '') return undefined
  const uid = uidOfSendKey(sendKey)
  if (uid !== undefined) return `https://${uid}.push.ft07.com/send/${sendKey}.send`
  // 新版 sendkey 不含 uid 时，官方兼容域名
  return `https://sc3.ft07.com/send/${sendKey}.send`
}

/**
 * 构造请求（纯函数，便于单测）。
 * @returns {{ url: string, init: object }} fetch 参数
 */
export function buildRequest(channel, message) {
  const url = endpointOf(channel)
  if (url === undefined) throw new Error('serverchan: 缺少 sendKey 或 apiUrl 配置')
  const body = { title: message.title, desp: message.body }
  const short = channel.serverchan?.short
  if (typeof short === 'string' && short !== '') body.short = short
  const tags = channel.serverchan?.tags
  if (typeof tags === 'string' && tags !== '') body.tags = tags
  return {
    url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  }
}

/**
 * 发送。deps.fetch 可注入（默认全局 fetch）。
 * @returns {Promise<void>} 非 2xx 或网络错误抛出，由调度器统一重试/记日志。
 */
export async function send(channel, message, deps) {
  const fetchImpl = deps?.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('serverchan: 运行环境无 fetch')
  const { url, init } = buildRequest(channel, message)
  // 网络类渠道统一带超时，防止挂死占用调度器重试链
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`serverchan: HTTP ${response.status} ${text.slice(0, 120)}`)
  }
}
