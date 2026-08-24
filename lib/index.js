/**
 * dsh-notify —— Cordis Host 入口（社区插件主路径）。
 *
 * 职责边界：本文件是唯一允许接触 DSH live 对象（Agent/Session/Event payload）的
 * 文件；它把事件解包为纯标量 Signal 后交给 kernel/dispatcher，其余模块保持可单测。
 *
 * 生命周期：全部监听与路由经 ctx / inject scope 注册，插件停用即整体撤销。
 */

import { spawn } from 'node:child_process'

import { settingsNamespace } from '@deepseek-ai/dsh-settings'

import { Config } from './config-schema.js'
import { Dispatcher } from './dispatcher.js'
import { normalizeConfig, truncate } from './kernel.js'
import { mountRoutes } from './routes.js'

/** Cordis 插件名（cordis.patch.yml 的 name 保持一致）。 */
export const name = 'dsh-notify'

/** settings 命名空间。 */
const NAMESPACE = settingsNamespace('dshNotify')

export function apply(ctx, loaderConfig) {
  const baseConfig = normalizeConfig(loaderConfig)
  const dispatcher = new Dispatcher({
    config: baseConfig,
    hooks: {
      logInfo: message => ctx.logger.info(message),
      logWarn: message => ctx.logger.warn(message),
      logDebug: message => ctx.logger.debug(message),
      exec: execProcess,
    },
  })

  // ---- 配置：settings 命名空间（base = Loader config），热更新 ----
  ctx.inject(['settings'], settingsCtx => {
    const scope = settingsCtx.settings.register(NAMESPACE, Config, { base: loaderConfig, applies: 'live' })
    dispatcher.reconfigure(normalizeConfig(scope.get()))
    settingsCtx.effect(() => scope.watch(next => {
      dispatcher.reconfigure(normalizeConfig(next))
    }), 'dsh-notify: settings watch')
  })

  // ---- Web 设置页配置/测试路由 ----
  ctx.inject(['webServer'], webCtx => {
    webCtx.inject(['settings'], fullCtx => {
      const settings = fullCtx.get('settings')
      if (settings === undefined) return
      fullCtx.effect(() => mountRoutes(fullCtx.webServer, {
        settings,
        namespace: NAMESPACE,
        dispatcher,
      }), 'dsh-notify: routes')
    })
  })

  // ---- 会话标题缓存 ----
  /** sessionId → 标题 */
  const titles = new Map()

  // ---- 事件源 1：计划完成（plan/mode active true→false）----
  /** sessionId → 最近一次观察到的 plan/mode active */
  const planActive = new Map()

  // ---- 审批去重占位在 Gatekeeper 内 ----
  const gatekeeper = dispatcher.gatekeeper

  ctx.on('session/event', (session, event) => {
    const sessionId = session.id
    switch (event.type) {
      case 'session/title':
        if (typeof event.data?.title === 'string' && event.data.title !== '') {
          titles.set(sessionId, event.data.title)
        }
        return
      case 'plan/mode': {
        const previous = planActive.get(sessionId)
        const next = event.data?.active === true
        planActive.set(sessionId, next)
        if (previous === true && next === false) {
          dispatcher.submit({
            kind: 'plan-completed',
            sessionId,
            label: labelOf(titles, sessionId),
            summary: '计划已批准，Agent 已退出计划模式开始执行。',
            severity: 'info',
          })
        }
        return
      }
      case 'approval/asked': {
        const requestId = String(event.data?.id ?? '')
        if (requestId === '' || !gatekeeper.noteApprovalAsked(requestId)) return
        const toolName = typeof event.data?.toolName === 'string' ? event.data.toolName : undefined
        const reason = typeof event.data?.reason === 'string' ? event.data.reason : undefined
        dispatcher.submit({
          kind: 'approval-pending',
          sessionId,
          label: labelOf(titles, sessionId),
          summary: toolName === undefined ? '会话等待你的审批。' : `工具 ${toolName} 等待你的审批。`,
          ...(reason === undefined ? {} : { detail: truncate(reason, 300) }),
          severity: 'warn',
        })
        return
      }
      case 'approval/decided':
        gatekeeper.noteApprovalDecided(String(event.data?.id ?? ''))
        return
      case 'turn/end': {
        const turn = event.data?.turn
        const reason = event.data?.reason
        gatekeeper.noteTurnEnd(
          sessionId,
          `turn ${typeof turn === 'number' ? turn : '?'} 结束原因：${String(reason ?? 'unknown')}`,
        )
        return
      }
      default:
        return
    }
  })

  // ---- 事件源 2：回合完成（running→idle，仅根会话）----
  /** agentId → 最近一次是否 running */
  const running = new Map()
  ctx.on('agent/status', payload => {
    const agent = payload.agent
    const isRunning = payload.status === 'running'
    const previous = running.get(agent.id)
    running.set(agent.id, isRunning)
    if (previous !== true || isRunning) return
    // 子代理由 subagent/end 负责；分叉会话 origin 为空仍是顶层
    const origin = agent.session?.header?.origin
    if (origin === 'subagent') return
    dispatcher.submit({
      kind: 'loop-completed',
      sessionId: agent.id,
      label: labelOf(titles, agent.id),
      summary: '任务已跑完，Agent 回到空闲状态。',
      severity: 'info',
    })
  })

  // ---- 事件源 3：子代理完成 ----
  ctx.on('subagent/end', info => {
    const stopReason = String(info.stopReason ?? 'unknown')
    const ok = stopReason === 'completed'
    dispatcher.submit({
      kind: 'subagent-completed',
      sessionId: typeof info.id === 'string' ? info.id : undefined,
      label: `${info.provider ?? 'subagent'}#${shortId(info.runId)}`,
      summary: `子代理结束：${stopReason}。`,
      severity: ok ? 'info' : 'warn',
    })
  })

  // ---- 事件源 4：运行出错 ----
  ctx.on('agent/error', payload => {
    dispatcher.submit({
      kind: 'agent-error',
      sessionId: payload.agent?.id,
      label: labelOf(titles, payload.agent?.id),
      summary: `turn ${payload.turn} step ${payload.step} 出错。`,
      detail: errorMessageOf(payload.error),
      severity: 'error',
    })
  })

  // ---- 事件源 5：工作流完成 ----
  ctx.on('workflow/end', (info, result) => {
    const metaName = typeof info?.meta?.name === 'string' ? info.meta.name : undefined
    dispatcher.submit({
      kind: 'workflow-completed',
      sessionId: undefined,
      label: `${metaName ?? 'workflow'}#${shortId(info?.id)}`,
      summary: `工作流结束：${String(result?.stopReason ?? 'unknown')}，共启动 ${Number(result?.agentsStarted ?? 0)} 个 agent。`,
      ...(result?.error === undefined ? {} : { detail: truncate(String(result.error), 300) }),
      severity: result?.stopReason === 'completed' ? 'info' : 'warn',
    })
  })

  // ---- 事件源 6：目标完成 ----
  ctx.on('goal/changed', payload => {
    if (payload.change?.operation !== 'complete') return
    const objective = typeof payload.change.goal?.objective === 'string'
      ? payload.change.goal.objective
      : undefined
    dispatcher.submit({
      kind: 'goal-completed',
      sessionId: payload.agent?.id,
      label: labelOf(titles, payload.agent?.id),
      summary: objective === undefined ? '当前目标已标记完成。' : `目标已完成：${truncate(objective, 160)}`,
      severity: 'info',
    })
  })

  ctx.effect(() => () => gatekeeper.dispose(), 'dsh-notify: gatekeeper timers')
  ctx.logger.info('[dsh-notify] 插件已加载：监听 7 类事件，等待渠道配置')
}

// ---------------------------------------------------------------------------
// 工具函数（纯标量处理）
// ---------------------------------------------------------------------------

/** 会话展示标签：优先标题，回退短 id。 */
function labelOf(titles, sessionId) {
  if (typeof sessionId !== 'string') return '未知会话'
  const title = titles.get(sessionId)
  if (typeof title === 'string' && title !== '') return truncate(title, 40)
  return shortId(sessionId)
}

/** 取 id 尾部 8 位做短标识。 */
function shortId(value) {
  const text = String(value ?? '')
  return text.length > 8 ? text.slice(-8) : text || '?'
}

/** 错误归一化为可展示文本（截断防刷屏）。 */
function errorMessageOf(error, maxLength = 300) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return truncate(message, maxLength)
}

/**
 * windows-toast 执行器：spawn 进程并收集结果；超时杀进程。
 * @param {{command,args,timeoutMs}} spec
 * @returns {Promise<{code:number,stdout:string,stderr:string}>}
 */
function execProcess({ command, args, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`windows-toast: powershell ${timeoutMs}ms 超时`))
    }, timeoutMs)
    child.stdout?.on('data', chunk => {
      stdout += chunk
    })
    child.stderr?.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}
