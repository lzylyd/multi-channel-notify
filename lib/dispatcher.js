/**
 * 通知调度器：Signal 入口 → 三层路由 → 渲染 → 逐渠道异步投递（重试退避）。
 *
 * 约束：
 * - 永不向调用方抛错（渠道失败只经 hooks.logWarn 记录）；
 * - 单渠道失败不影响其他渠道；
 * - 配置热更新（reconfigure）保留冷却/防抖状态。
 */

import { ADAPTERS } from './channels/index.js'
import { Gatekeeper, renderMessage, routeTargets, truncate } from './kernel.js'

const DEFAULT_RETRY_BACKOFF_MS = [1_000, 4_000]

export class Dispatcher {
  /**
   * @param {object} options
   * @param {object} options.config          规范化后的配置（kernel.normalizeConfig）
   * @param {object} options.hooks           { logInfo, logWarn, logDebug, exec, fetch }
   *                                         fetch/exec 透传给渠道适配器（可注入测试）
   * @param {number[]} [options.retryBackoffMs] 重试退避序列（默认 1s/4s；测试注入短间隔）
   */
  constructor({ config, hooks, retryBackoffMs }) {
    this.hooks = hooks
    this.retryBackoffMs = Array.isArray(retryBackoffMs) ? retryBackoffMs : DEFAULT_RETRY_BACKOFF_MS
    this.gatekeeper = new Gatekeeper(config)
    /** 未触发的重试 setTimeout id 集合（dispose 时统一清理）。 */
    this.retryTimers = new Set()
    this.reconfigure(config)
  }

  /** 释放全部重试定时器（activation scope 清理）。 */
  dispose() {
    for (const timer of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
  }

  /** 配置热更新：替换配置，保留去重状态。 */
  reconfigure(config) {
    this.config = config
    this.gatekeeper.config = config
  }

  /** 信号入口。立即返回；全部后续动作异步。 */
  submit(signal) {
    try {
      const verdict = this.gatekeeper.admit(signal, debounced => {
        this.deliver(debounced)
      })
      if (verdict.action === 'deliver') {
        // 让出当前栈：审批/状态回调路径上绝不同步等待网络
        queueMicrotask(() => this.deliver(signal))
      }
    } catch (error) {
      this.hooks.logWarn?.(`调度器内部错误：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 路由 + 渲染 + 投递。 */
  deliver(signal) {
    const targets = routeTargets(this.config, signal.kind)
    if (targets.length === 0) {
      this.hooks.logDebug?.(`[multi-channel-notify] 无订阅渠道：${signal.kind}`)
      return
    }
    for (const channel of targets) {
      if (!this.gatekeeper.allowChannel(channel.id)) {
        this.hooks.logDebug?.(`[multi-channel-notify] 限流跳过：${channel.id}`)
        continue
      }
      const message = renderMessage(this.config, signal)
      void this.deliverToChannel(channel, message, signal.kind)
    }
  }

  /** 单渠道投递：带重试退避；失败只记日志。 */
  async deliverToChannel(channel, message, kind, attempt = 0) {
    const adapter = ADAPTERS[channel.type]
    if (adapter === undefined) {
      this.hooks.logWarn?.(`[multi-channel-notify] 未知渠道类型：${channel.type}（${channel.id}）`)
      return
    }
    try {
      await adapter.send(channel, message, {
        exec: this.hooks.exec,
        fetch: this.hooks.fetch,
        versionText: this.hooks.versionText,
      })
      this.hooks.logInfo?.(`[multi-channel-notify] 已推送 ${kind} → ${channel.id}`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const canRetry =
        attempt < this.retryBackoffMs.length &&
        // toast 的失败通常是环境性的（无 interop 等），重试无意义；网络类渠道才重试
        channel.type !== 'windows-toast'
      if (canRetry) {
        const delay = this.retryBackoffMs[attempt]
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer)
          void this.deliverToChannel(channel, message, kind, attempt + 1)
        }, delay)
        this.retryTimers.add(timer)
        this.hooks.logDebug?.(`[multi-channel-notify] ${channel.id} 第 ${attempt + 1} 次失败，${delay}ms 后重试：${reason}`)
        return
      }
      this.hooks.logWarn?.(`[multi-channel-notify] 推送失败 ${kind} → ${channel.id}：${truncate(reason, 200)}`)
    }
  }
}
