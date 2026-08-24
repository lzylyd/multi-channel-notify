/**
 * 渠道适配器注册表。
 *
 * 新增渠道只需：写一个 `lib/channels/<type>.js`（导出 send，可选导出
 * buildRequest 等纯函数），然后在此登记 `{ type, send }`。
 */

import * as serverchan from './serverchan.js'
import * as windowsToast from './windows-toast.js'
import * as wecom from './wecom.js'
import * as webhook from './webhook.js'

/** type → adapter。 */
export const ADAPTERS = Object.freeze({
  serverchan,
  'windows-toast': windowsToast,
  wecom,
  webhook,
})

/** 设置页可选的渠道类型清单。 */
export const CHANNEL_TYPES = Object.freeze([
  { type: 'serverchan', label: 'Server酱³' },
  { type: 'windows-toast', label: 'Windows Toast（原生 / WSL→宿主）' },
  { type: 'wecom', label: '企业微信机器人' },
  { type: 'webhook', label: '自定义 Webhook' },
])

/** 按渠道实例取发送器；未知类型返回 undefined。 */
export function adapterOf(channel) {
  return ADAPTERS[channel?.type]
}
