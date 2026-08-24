/**
 * multi-channel-notify —— dsh-std 标准 FacetModule 入口。
 *
 * 该入口仅在包被 `@dsh-std/adapter-dsh` 发现并激活时运行
 * （`dsh-plugin.json` 的 `facets.host.entry`）。它与 Cordis 主入口
 * （lib/index.js，经 cordis.patch.yml 装载）互斥生效、不会叠加：
 *
 * - 当前标准协议面（adapter-dsh 已发布的 capability）尚无可观察的
 *   agent 生命周期事件契约；MessageObserver 仅有 definition、无 publisher，
 *   因此本 facet 以「degraded：等待标准事件协议」状态发布自身扩展，
 *   不注册任何通知副作用，避免与主路径双重推送；
 * - 一旦上游发布可协商的事件/观察协议，本文件即迁移点。
 *
 * 形状对齐 `@dsh-std/sdk` 的 `FacetModule`
 * （activate 必需 / deactivate、snapshot 可选），零依赖实现。
 */

const MESSAGES_REFERENCE = Object.freeze({
  apiVersion: 'messages.dsh/v1alpha1',
  kind: 'MessageObserver',
})

/** 激活：只读协商 + 发布状态扩展，全部资源登记到 activation scope。 */
export function activate(context) {
  const observed = context?.protocols?.agreement?.(MESSAGES_REFERENCE)
  const state = observed === undefined
    ? {
        state: 'degraded',
        message:
          '标准 MessageObserver 协议当前不可协商（宿主尚未发布 support）；'
          + 'multi-channel-notify 的事件监听经宿主原生通道在 Cordis 插件行中提供，本标准 facet 保持无副作用。',
      }
    : { state: 'active', message: 'MessageObserver 已协商（迁移预留）。' }

  /** 扩展卸载器（scope 清理兜底之外的显式路径）。 */
  let unpublish
  try {
    unpublish = context?.extensions?.publish?.(
      { apiVersion: 'lifecycle.dsh/v1alpha1', kind: 'FacetStatus' },
      'multi-channel-notify.status',
      Object.freeze({ ...state, events: ['plan-completed', 'loop-completed', 'subagent-completed', 'approval-pending', 'agent-error', 'workflow-completed', 'goal-completed'] }),
    )
  } catch {
    unpublish = undefined
  }
  return () => {
    if (typeof unpublish === 'function') unpublish()
  }
}

/** 停用：幂等清理。 */
export function deactivate() {}

/** 状态投影（lifecycle snapshot 用）。 */
export function snapshot() {
  return { state: 'degraded', message: '见 activate 发布的 multi-channel-notify.status' }
}

/** 标准 FacetModule（default 与命名导出各一份，兼容两种装载取向）。 */
const facet = Object.freeze({
  activate,
  deactivate,
  ...(typeof snapshot === 'function' ? { snapshot } : {}),
})

export default facet
