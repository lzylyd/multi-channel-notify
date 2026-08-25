/**
 * Server酱·Turbo —— 微信推送渠道适配器。
 *
 * 官方文档：https://sct.ftqq.com（Server酱·Turbo版 / 微信推送 API）
 * - SendKey 页面：https://sct.ftqq.com/sendkey ，密钥形如 `SCT…`；
 * - 接口：`https://sctapi.ftqq.com/<sendkey>.send`，GET（query 参数）与
 *   POST (application/x-www-form-urlencoded) 均支持；
 * - 参数：title（必填）、desp（可选，markdown）；
 * - 响应：成功 `{"code":0,...}`；失败 HTTP 400 + `{"code":<err>,"message":…}`。
 *
 * 注意：Server酱³（sctp…，推自家 APP）与 Server酱 Turbo（SCT…，推微信）
 * 是两个产品、两种 SendKey，互不通用。
 */

/** 由 sendKey 求出接口 URL；缺省返回 undefined。 */
export function endpointOf(turbo) {
  const sendKey = String(turbo?.sendKey ?? '').trim()
  if (sendKey === '') return undefined
  return `https://sctapi.ftqq.com/${sendKey}.send`
}

/** 构造请求（纯函数，便于单测）。桶名与 type 一致（serverchan-turbo）。 */
export function buildRequest(channel, message) {
  const url = endpointOf(channel['serverchan-turbo'])
  if (url === undefined) throw new Error('serverchan-turbo: 缺少 SendKey（sct.ftqq.com/sendkey 页获取）')
  const body = new URLSearchParams()
  body.set('title', message.title)
  if (typeof message.body === 'string' && message.body !== '') body.set('desp', message.body)
  return {
    url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
  }
}

/** 发送；失败（HTTP 非 2xx 或 code 非 0）抛出带真实原因的错误。 */
export async function send(channel, message, deps) {
  const fetchImpl = deps?.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('serverchan-turbo: 运行环境无 fetch')
  const { url, init } = buildRequest(channel, message)
  // 网络类渠道统一带超时，防止挂死占用调度器重试链
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) })
  const text = typeof response.text === 'function' ? await response.text().catch(() => '') : ''
  if (!response.ok) throw new Error(`serverchan-turbo: HTTP ${response.status} ${text.slice(0, 120)}`)
  // 官方失败也可能返回 HTTP 200 + 非零 code（如配额问题），不能只看状态码
  if (text !== '') {
    try {
      const json = JSON.parse(text)
      const code = typeof json.code === 'number' ? json.code : 0
      if (code !== 0) throw new Error(`serverchan-turbo: ${json.message ?? json.info ?? text.slice(0, 120)}`)
    } catch (parseError) {
      if (parseError instanceof SyntaxError) return // 非 JSON 响应视为成功
      throw parseError
    }
  }
}
