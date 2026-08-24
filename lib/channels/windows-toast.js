/**
 * Windows Toast 渠道适配器（原生 win32 与 WSL→宿主机两种路径）。
 *
 * - mode `native`：DSH 直接跑在 Windows 上，spawn 本机 powershell.exe；
 * - mode `wsl`：DSH 跑在 WSL 里，经 interop 调用宿主机 powershell.exe 弹宿主 Toast；
 * - mode `auto`：按运行环境自动判定（win32 → native；WSL 特征 → wsl）。
 *
 * Toast 通过 WinRT `Windows.UI.Notifications.ToastNotificationManager` 发出，
 * AUMID 复用 PowerShell 的，免注册 AppId、无需任何第三方依赖。
 */

import { existsSync } from 'node:fs'

/** /mnt/c 下的 PowerShell 兜底路径（interop PATH 未含 Windows 目录时使用）。 */
const WSL_POWERSHELL_FALLBACK = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

/**
 * 判定当前是否运行在 WSL（纯函数，env/versionText 可注入便于测试）。
 */
export function isWsl(env = process.env, versionText = '') {
  if (typeof env.WSL_DISTRO_NAME === 'string' && env.WSL_DISTRO_NAME !== '') return true
  if (typeof env.WSL_INTEROP === 'string' && env.WSL_INTEROP !== '') return true
  return /microsoft/i.test(versionText)
}

/**
 * 解析生效模式。返回 'native' | 'wsl'。
 */
export function resolveMode(channel, env = process.env, platform = process.platform, versionText = '') {
  const requested = channel.windowsToast?.mode
  if (requested === 'native') return 'native'
  if (requested === 'wsl') return 'wsl'
  if (platform === 'win32') return 'native'
  if (isWsl(env, versionText)) return 'wsl'
  throw new Error('windows-toast: 当前环境既非 Windows 也非 WSL，无法弹宿主通知（可用 webhook/serverchan 渠道替代）')
}

/**
 * 求宿主 powershell.exe 的调用参数前缀（wsl 模式下先探测 interop 可执行文件）。
 * deps.existsSync 可注入测试。
 */
export function powershellCommand(mode, deps = {}) {
  const exists = deps.existsSync ?? existsSync
  if (mode === 'native') return { command: 'powershell.exe', args: [] }
  // wsl：优先 PATH 直接可用的 powershell.exe（binfmt 已注册），否则退回 /mnt/c 全路径
  const pathEnv = typeof deps.pathEnv === 'string' ? deps.pathEnv : process.env.PATH ?? ''
  const hasInteropOnPath =
    pathEnv.split(':').some(dir => exists(`${dir}/powershell.exe`))
  if (hasInteropOnPath) return { command: 'powershell.exe', args: [] }
  if (exists(WSL_POWERSHELL_FALLBACK)) return { command: WSL_POWERSHELL_FALLBACK, args: [] }
  throw new Error(
    'windows-toast: 未找到宿主机 powershell.exe —— 请确认 WSL interop 已启用（/etc/wsl.conf 未禁用 binfmt），或改用其他渠道',
  )
}

/**
 * XML 实体转义——Toast 模板经 XmlDocument.LoadXml 解析，& < > " 必须转义，
 * 否则含 URL/比较符的正文会让 LoadXml 直接失败。
 */
function xmlEscape(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Toast 文本净化：压平换行（here-string 以行首 '@ 终止，换行内容有提前终止
 * 与语句注入风险），再做 XML 转义。
 */
function toastText(text) {
  return xmlEscape(String(text).replace(/\r?\n/g, ' '))
}

/**
 * 构造 WinRT Toast 的 PowerShell 脚本（纯函数）。
 *
 * 使用单引号 here-string @'...'@：内容完全字面化（$、反引号、双引号都不求值），
 * 杜绝双引号 here-string 的插值/提前终止注入面；XML 特殊字符由 toastText 转义。
 */
export function buildScript(message) {
  const title = toastText(message.title)
  const body = toastText(message.body)
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    "$template = @'",
    '<toast><visual><binding template="ToastGeneric">',
    `<text>${title}</text>`,
    `<text>${body}</text>`,
    '</binding></visual></toast>',
    "'@",
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml($template)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
  ].join('\n')
}

/**
 * 构造 spawn 参数（纯函数，便于单测断言）。
 * @returns {{ command: string, args: string[] }}
 */
export function buildSpawn(channel, message, deps = {}) {
  const mode = resolveMode(channel, deps.env, deps.platform, deps.versionText)
  const { command, args } = powershellCommand(mode, deps)
  return {
    command,
    args: [
      ...args,
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      buildScript(message),
    ],
  }
}

/**
 * 发送（fire-and-forget 友好：10s 超时）。deps.exec 可注入测试。
 * @param {({command,args,timeoutMs}) => Promise<{stdout,stderr}>} deps.exec
 */
export async function send(channel, message, deps = {}) {
  const exec = deps.exec
  if (typeof exec !== 'function') throw new Error('windows-toast: 缺少 exec 执行器')
  const { command, args } = buildSpawn(channel, message, deps)
  const result = await exec({ command, args, timeoutMs: 10_000 })
  // Toast 失败常表现为 stderr 非空且退出码非零；exec 实现负责抛错，这里兜底校验
  if (result && typeof result.code === 'number' && result.code !== 0) {
    throw new Error(`windows-toast: powershell 退出码 ${result.code} ${String(result.stderr).slice(0, 120)}`)
  }
}
