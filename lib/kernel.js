/**
 * dsh-notify 纯函数内核。
 *
 * 本文件不 import 任何 @deepseek-ai/* 与 node 内置模块（windows-toast 的执行器
 * 由调用方注入），保证可以在 `node --test` 里毫秒级单测，也保证标准组件入口
 * （lib/std.js）与 Cordis 入口（lib/index.js）共享同一套业务语义。
 *
 * 词汇表：
 * - Signal   —— 归一化通知信号：{ kind, sessionId?, label, summary, detail?, severity }
 * - Message  —— 渲染后的推送消息：{ title, body }
 * - 路由三层开关：config.events[kind].enabled × channel.enabled × channel.events[kind]
 */

/** 全部事件类型（稳定 id，用作配置键与路由键）。 */
export const EVENT_KINDS = /** @type {const} */ ([
  'plan-completed',
  'loop-completed',
  'subagent-completed',
  'approval-pending',
  'agent-error',
  'workflow-completed',
  'goal-completed',
])

/** 事件类型的中文展示名。 */
export const EVENT_LABELS = Object.freeze({
  'plan-completed': '计划完成',
  'loop-completed': '回合完成',
  'subagent-completed': '子代理完成',
  'approval-pending': '等待审批',
  'agent-error': '运行出错',
  'workflow-completed': '工作流完成',
  'goal-completed': '目标完成',
})

/** severity → 展示标记。 */
const SEVERITY_MARKS = Object.freeze({
  info: '✅',
  warn: '⚠️',
  error: '❌',
})

// ---------------------------------------------------------------------------
// 配置规范化
// ---------------------------------------------------------------------------

/**
 * 把任意（可能缺字段）的配置补全为带默认值的完整形态。
 * Loader config / settings 用户层 / 测试用例共用。
 */
export function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const events = { ...defaultEventSwitches() }
  for (const kind of EVENT_KINDS) {
    const value = config.events?.[kind]
    if (typeof value === 'boolean') events[kind] = value
  }
  const dedup = { ...config.dedup }
  if (!Number.isFinite(dedup.cooldownMs)) dedup.cooldownMs = 10_000
  else dedup.cooldownMs = Math.max(0, dedup.cooldownMs)
  if (!Number.isFinite(dedup.completedDebounceMs)) dedup.completedDebounceMs = 1_000
  else dedup.completedDebounceMs = Math.max(0, dedup.completedDebounceMs)
  if (!Number.isFinite(dedup.perChannelPerMinute) || dedup.perChannelPerMinute < 1) dedup.perChannelPerMinute = 20
  const message = { ...config.message }
  if (typeof message.titlePrefix !== 'string') message.titlePrefix = ''
  if (typeof message.guiUrl !== 'string' || message.guiUrl === '') message.guiUrl = 'http://127.0.0.1:3080'
  const channels = Array.isArray(config.channels)
    ? config.channels.map(normalizeChannel).filter(Boolean)
    : []
  return { events, dedup, message, channels }
}

/** 默认事件开关：前五个默认开（用户高频场景），workflow/goal 默认关。 */
function defaultEventSwitches() {
  return {
    'plan-completed': true,
    'loop-completed': true,
    'subagent-completed': true,
    'approval-pending': true,
    'agent-error': true,
    'workflow-completed': false,
    'goal-completed': false,
  }
}

/** 规范化单个渠道实例；缺 id/type 的实例返回 undefined。 */
export function normalizeChannel(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  if (typeof raw.type !== 'string') return undefined
  const events = { ...defaultChannelEvents() }
  for (const kind of EVENT_KINDS) {
    const value = raw.events?.[kind]
    if (typeof value === 'boolean') events[kind] = value
  }
  return {
    ...raw,
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `${raw.type}-${hashOf(raw)}`,
    enabled: raw.enabled === true,
    events,
  }
}

/** 渠道级事件订阅默认值：跟随全局（全部 true，由全局开关负责关断）。 */
function defaultChannelEvents() {
  const all = {}
  for (const kind of EVENT_KINDS) all[kind] = true
  return all
}

/** 稳定短哈希（为无 id 渠道生成确定 id）。 */
/**
 * 全深度、键排序的稳定序列化。
 *
 * 不能用 JSON.stringify(value, replacerArray)：replacer 数组会在**每一层**按同一份
 * 键列表过滤，嵌套对象（如 serverchan.sendKey、events.*）会被整体丢弃，导致同类型
 * 不同配置的渠道 id 碰撞。这里递归排序后拼接，保证语义相同的配置得到相同哈希。
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const entries = Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
  return `{${entries.join(',')}}`
}

function hashOf(value) {
  const text = stableStringify(value)
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return Math.abs(hash).toString(36)
}

// ---------------------------------------------------------------------------
// 路由决策
// ---------------------------------------------------------------------------

/**
 * 三层开关求值：该信号是否应投递到该渠道。
 * 纯真值表，无副作用。
 */
export function shouldRoute(config, channel, kind) {
  return config.events[kind] === true && channel.enabled === true && channel.events[kind] === true
}

/**
 * 求出该接收该信号的全部渠道实例。
 */
export function routeTargets(config, kind) {
  return config.channels.filter(channel => shouldRoute(config, channel, kind))
}

// ---------------------------------------------------------------------------
// 去重 / 限流状态机
// ---------------------------------------------------------------------------

/**
 * 冷却 + 限流 + 防抖状态机。时钟可注入便于测试。
 * 同一会话同一事件的冷却窗口内只投递一次；
 * 每渠道每分钟不超过 perChannelPerMinute 条；
 * loop-completed 进入防抖窗口（等待 turn/end 原因合并）。
 */
export class Gatekeeper {
  constructor(config, { now = Date.now } = {}) {
    this.config = config
    this.now = now
    /** `${sessionId}:${kind}` → 上次放行时间戳 */
    this.cooldowns = new Map()
    /** channelId → 最近一分钟放行时间戳数组 */
    this.windows = new Map()
    /** sessionId → { signal, timer } 防抖中的 loop-completed */
    this.pendingLoops = new Map()
    /** sessionId → 最近 turn/end 原因 */
    this.lastTurnEnd = new Map()
    /** 已见过的 approval/asked 请求 id（decided 到达即移除） */
    this.pendingApprovals = new Set()
    this.timers = new Set()
  }

  /** 释放全部定时器（activation scope 清理）。 */
  dispose() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.pendingLoops.clear()
  }

  /** 记录 turn/end 结束原因，供防抖中的完成信号合并（容量护栏防无界增长）。 */
  noteTurnEnd(sessionId, reason) {
    if (this.lastTurnEnd.has(sessionId)) this.lastTurnEnd.delete(sessionId)
    this.lastTurnEnd.set(sessionId, reason)
    while (this.lastTurnEnd.size > 500) this.lastTurnEnd.delete(this.lastTurnEnd.keys().next().value)
  }

  /** 记录审批请求 id；返回 false 表示重复（应去重）。 */
  noteApprovalAsked(requestId) {
    if (this.pendingApprovals.has(requestId)) return false
    // 容量护栏：正常流里 decided 会成对删除；异常流（decided 丢失）下有界
    this.pendingApprovals.add(requestId)
    if (this.pendingApprovals.size > 1000) {
      const oldest = this.pendingApprovals.values().next().value
      this.pendingApprovals.delete(oldest)
    }
    return true
  }

  /** 审批已决定：解除去重占位。 */
  noteApprovalDecided(requestId) {
    this.pendingApprovals.delete(requestId)
  }

  /**
   * 信号准入。返回：
   * - `{ action: 'deliver', signal }` —— 立即投递
   * - `{ action: 'debounce' }`       —— 已进入防抖窗口，窗口结束时会以回调交还
   * - `{ action: 'skip' }`           —— 开关关闭/冷却中/重复审批
   *
   * 语义对齐：loop-completed 先经防抖窗口合并连续边界，窗口结束时再按冷却
   * 决定是否真正交还（先合并、后限流），避免快速连续完成被冷却误吞。
   * @param {(signal: object) => void} onDebounced 防抖窗口结束时的交还回调
   */
  admit(signal, onDebounced) {
    const now = this.now()
    if (signal.kind === 'loop-completed' && this.config.dedup.completedDebounceMs > 0) {
      this.debounceLoop(signal, onDebounced)
      return { action: 'debounce' }
    }
    const key = `${signal.sessionId ?? '-'}:${signal.kind}`
    const last = this.cooldowns.get(key)
    if (last !== undefined && now - last < this.config.dedup.cooldownMs) return { action: 'skip' }
    // 冷却表容量护栏：写入前清理远超冷却期的陈旧键，防止长会话无界增长
    if (this.cooldowns.size >= 2000) {
      for (const [staleKey, ts] of this.cooldowns) {
        if (now - ts >= Math.max(this.config.dedup.cooldownMs, 10_000) * 10) this.cooldowns.delete(staleKey)
        if (this.cooldowns.size < 2000) break
      }
    }
    this.cooldowns.set(key, now)
    return { action: 'deliver' }
  }

  /** loop-completed 防抖：窗口内只保留最新信号；结束时按冷却决定是否交还（附 turn/end 原因）。 */
  debounceLoop(signal, onDebounced) {
    const sessionId = signal.sessionId
    const merged = {
      ...signal,
      ...(this.lastTurnEnd.get(sessionId) === undefined ? {} : { detail: this.lastTurnEnd.get(sessionId) }),
    }
    const existing = this.pendingLoops.get(sessionId)
    if (existing !== undefined) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.pendingLoops.delete(sessionId)
      const now = this.now()
      const key = `${sessionId ?? '-'}:loop-completed`
      const last = this.cooldowns.get(key)
      if (last !== undefined && now - last < this.config.dedup.cooldownMs) return
      this.cooldowns.set(key, now)
      onDebounced(merged)
    }, this.config.dedup.completedDebounceMs)
    this.timers.add(timer)
    // 记录最新信号供窗口重置时读取
    this.pendingLoops.set(sessionId, { signal: merged, timer })
  }

  /** 渠道级限流：每分钟超过上限返回 false。 */
  allowChannel(channelId) {
    const now = this.now()
    const windowStart = now - 60_000
    const window = (this.windows.get(channelId) ?? []).filter(ts => ts >= windowStart)
    if (window.length >= this.config.dedup.perChannelPerMinute) {
      this.windows.set(channelId, window)
      return false
    }
    window.push(now)
    this.windows.set(channelId, window)
    return true
  }
}

// ---------------------------------------------------------------------------
// 消息渲染
// ---------------------------------------------------------------------------

/**
 * 把 Signal 渲染为 { title, body }。
 * 标题：`${titlePrefix}${severityMark} ${EVENT_LABELS[kind]} · ${label}`
 * 正文：summary + detail + guiUrl 提示。
 */
export function renderMessage(config, signal) {
  const label = EVENT_LABELS[signal.kind] ?? signal.kind
  const mark = SEVERITY_MARKS[signal.severity] ?? ''
  const prefix = config.message.titlePrefix
  const title = truncate(`${prefix}${mark} ${label} · ${signal.label}`.trimStart(), 64)
  const lines = [signal.summary]
  if (signal.detail) lines.push(truncate(String(signal.detail), 500))
  lines.push(`时间：${formatTime(signal.time)}`)
  if (config.message.guiUrl) lines.push(`打开 DSH：${config.message.guiUrl}`)
  return { title, body: lines.filter(Boolean).join('\n') }
}

/** 截断过长文本（保尾省略号）。 */
export function truncate(text, maxLength) {
  const string = String(text ?? '')
  return string.length > maxLength ? `${string.slice(0, maxLength)}…` : string
}

/** 本地时间格式化（YYYY-MM-DD HH:mm:ss）。 */
export function formatTime(timestamp = Date.now()) {
  const date = new Date(timestamp)
  const pad = n => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}
