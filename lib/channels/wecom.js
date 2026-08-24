/**
 * 企业微信群机器人渠道适配器。
 *
 * API：POST webhookUrl，msgtype=markdown。
 * 可选加签（机器人安全设置-加签）：
 *   sign = base64(hmac_sha256(key = secret, message = `${timestamp}\n${secret}`))
 *   追加到 webhookUrl：`&timestamp=${timestamp}&sign=${sign}`
 */

import { createHmac } from 'node:crypto'

/**
 * 计算企业微信加签参数（纯函数）。
 * @returns {{ timestamp: number, sign: string }}
 */
export function signatureOf(secret, timestamp = Date.now()) {
  const stringToSign = `${timestamp}\n${secret}`
  const hmac = createHmac('sha256', secret).update(stringToSign).digest('base64')
  return { timestamp, sign: hmac }
}

/** 求最终请求 URL（含可选加签 query）。 */
export function urlOf(channel, now = Date.now()) {
  const raw = String(channel.wecom?.webhookUrl ?? '').trim()
  if (raw === '') throw new Error('wecom: 缺少 webhookUrl 配置')
  const secret = channel.wecom?.secret
  if (typeof secret !== 'string' || secret === '') return raw
  const { timestamp, sign } = signatureOf(secret, now)
  const joiner = raw.includes('?') ? '&' : '?'
  return `${raw}${joiner}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
}

/** 把消息体转义为 markdown 安全文本（去 markdown 控制字符的朴素处理）。 */
function markdownSafe(text) {
  return String(text)
}

/**
 * 构造请求（纯函数）。
 */
export function buildRequest(channel, message, now = Date.now()) {
  return {
    url: urlOf(channel, now),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: {
          content: `**${markdownSafe(message.title)}**\n${markdownSafe(message.body)}`,
        },
      }),
    },
  }
}

/** 发送；非 2xx 或业务 errcode!=0 抛错。 */
export async function send(channel, message, deps) {
  const fetchImpl = deps?.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('wecom: 运行环境无 fetch')
  const { url, init } = buildRequest(channel, message)
  const response = await fetchImpl(url, init)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`wecom: HTTP ${response.status} ${text.slice(0, 120)}`)
  }
  const result = await response.json().catch(() => undefined)
  if (result && typeof result.errcode === 'number' && result.errcode !== 0) {
    throw new Error(`wecom: errcode=${result.errcode} ${String(result.errmsg ?? '').slice(0, 120)}`)
  }
}
