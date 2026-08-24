/**
 * dsh-notify 动态验证版（本会话动态插件镜像）。
 *
 * 与 npm 包版的差异（动态沙箱约束所致）：
 * - 单文件内联 kernel/channels；无 import/node 内置模块；
 * - HTTP 推送与 WSL Toast 走 `shell` 服务（curl / powershell.exe，payload 经 stdin 免转义）；
 *   动态环境无 fetch 全局，且 web 服务是 GET 只读检索发不了 POST；
 * - 配置为内存态，经注册的模型工具 notify_set_channel / notify_toggle_event /
 *   notify_test_send 自服务调整（无 settings.yaml 持久化）。
 *
 * 用途：在当前运行实例里即时验证「事件流 → 路由 → 真实推送」链路。
 */

// ---- 可调参数（改这里或用工具热调） ----
const GUI_URL = 'http://127.0.0.1:3080'
const TITLE_PREFIX = '[DSH]'
const COOLDOWN_MS = 10_000
const DEBOUNCE_MS = 1_000
const PER_CHANNEL_PER_MINUTE = 20

const EVENT_LABELS = {
  'plan-completed': '计划完成',
  'loop-completed': '回合完成',
  'subagent-completed': '子代理完成',
  'approval-pending': '等待审批',
  'agent-error': '运行出错',
  'workflow-completed': '工作流完成',
  'goal-completed': '目标完成',
}

return {
  name: 'dsh-notify-live',
  inject: ['timer'],
  apply(ctx) {
    // ---- 内存配置 ----
    const state = {
      events: {
        'plan-completed': true,
        'loop-completed': true,
        'subagent-completed': true,
        'approval-pending': true,
        'agent-error': true,
        'workflow-completed': false,
        'goal-completed': false,
      },
      channels: [], // {id,type,enabled,...}
    }
    const titles = new Map()
    const cooldowns = new Map()
    const windows = new Map()
    const pendingApprovals = new Set()
    const planActive = new Map()
    const running = new Map()
    const lastTurnEnd = new Map()
    const pendingLoops = new Map()
    let sentCount = 0
    let failCount = 0

    const log = message => console.log(`[dsh-notify-live] ${message}`)

    // ---- shell 执行器（可选服务） ----
    const shell = ctx.get('shell')
    async function runShell(command, stdin, timeoutMs = 15_000) {
      if (shell === undefined) throw new Error('shell 服务未挂载')
      const spec = shell.resolve({ command, timeoutMs, stdin })
      const result = await shell.run(spec)
      if (result.exitCode !== 0) {
        throw new Error(`exit=${result.exitCode} ${String(result.stderr ?? '').slice(0, 160)}`)
      }
      return result
    }

    // ---- 渠道发送 ----
    function serverChanUrl(channel) {
      const key = String(channel.sendKey ?? '').trim()
      if (key === '') throw new Error('serverchan 缺少 sendKey')
      const match = /^sctp(\d+)t/.exec(key)
      const uid = match === null ? 'sc3' : match[1]
      const host = match === null ? 'sc3.ft07.com' : `${uid}.push.ft07.com`
      return `https://${host}/send/${key}.send`
    }

    const SENDERS = {
      async serverchan(channel, message) {
        const body = JSON.stringify({ title: message.title, desp: message.body })
        await runShell(
          `curl -sS -X POST -H 'content-type: application/json' --data-binary @- '${serverChanUrl(channel)}'`,
          body,
        )
      },
      async webhook(channel, message) {
        const url = String(channel.url ?? '').trim()
        if (url === '') throw new Error('webhook 缺少 url')
        const payload = channel.bodyTemplate
          ? channel.bodyTemplate
              .replaceAll('{{json}}', JSON.stringify({ title: message.title, body: message.body }))
              .replaceAll('{{title}}', message.title)
              .replaceAll('{{body}}', message.body)
          : JSON.stringify({ title: message.title, body: message.body })
        const method = String(channel.method ?? 'POST').toUpperCase()
        await runShell(
          `curl -sS -X ${method} -H 'content-type: application/json' --data-binary @- '${url}'`,
          method === 'GET' ? '' : payload,
        )
      },
      async 'windows-toast'(channel, message) {
        const esc = s => String(s).replaceAll("'", "''")
        const script = [
          "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
          "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
          '$template = @"',
          '<toast><visual><binding template="ToastGeneric">',
          `<text>${esc(message.title)}</text>`,
          `<text>${esc(message.body)}</text>`,
          '</binding></visual></toast>',
          '"@',
          '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
          '$xml.LoadXml($template)',
          '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
          "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
        ].join('\n')
        await runShell("powershell.exe -NoProfile -NonInteractive -Command -", script)
      },
    }

    function renderMessage(signal) {
      const mark = signal.severity === 'error' ? '❌' : signal.severity === 'warn' ? '⚠️' : '✅'
      const title = `${TITLE_PREFIX}${mark} ${EVENT_LABELS[signal.kind] ?? signal.kind} · ${signal.label}`
      const lines = [signal.summary]
      if (signal.detail) lines.push(String(signal.detail).slice(0, 400))
      if (GUI_URL) lines.push(`打开 DSH：${GUI_URL}`)
      return { title: title.slice(0, 64), body: lines.filter(Boolean).join('\n') }
    }

    function targetsOf(kind) {
      return state.channels.filter(c => c.enabled === true && state.events[kind] === true && c.events[kind] !== false)
    }

    function allowChannel(id) {
      const now = Date.now()
      const window = (windows.get(id) ?? []).filter(ts => ts >= now - 60_000)
      if (window.length >= PER_CHANNEL_PER_MINUTE) {
        windows.set(id, window)
        return false
      }
      window.push(now)
      windows.set(id, window)
      return true
    }

    async function deliverToChannel(channel, message, kind) {
      const sender = SENDERS[channel.type]
      try {
        if (sender === undefined) throw new Error(`未知渠道类型 ${channel.type}`)
        await sender(channel, message)
        sentCount += 1
        log(`已推送 ${kind} → ${channel.id}`)
      } catch (error) {
        failCount += 1
        log(`推送失败 ${kind} → ${channel.id}：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    function deliver(signal) {
      const targets = targetsOf(signal.kind)
      if (targets.length === 0) return
      const message = renderMessage(signal)
      for (const channel of targets) {
        if (!allowChannel(channel.id)) continue
        void deliverToChannel(channel, message, signal.kind)
      }
    }

    function labelOf(sessionId) {
      if (typeof sessionId !== 'string') return '未知会话'
      const title = titles.get(sessionId)
      return typeof title === 'string' && title !== '' ? title.slice(0, 40) : sessionId.slice(-8)
    }

    function submit(signal) {
      if (state.events[signal.kind] !== true) return
      const key = `${signal.sessionId ?? '-'}:${signal.kind}`
      const last = cooldowns.get(key)
      const now = Date.now()
      if (last !== undefined && now - last < COOLDOWN_MS) return
      cooldowns.set(key, now)
      deliver(signal)
    }

    // ---- 事件源接线（与 npm 包版一致） ----
    ctx.on('session/event', (session, event) => {
      const sessionId = session.id
      if (event.type === 'session/title') {
        if (typeof event.data?.title === 'string' && event.data.title !== '') titles.set(sessionId, event.data.title)
        return
      }
      if (event.type === 'plan/mode') {
        const previous = planActive.get(sessionId)
        const next = event.data?.active === true
        planActive.set(sessionId, next)
        if (previous === true && next === false) {
          submit({ kind: 'plan-completed', sessionId, label: labelOf(sessionId), summary: '计划已批准，Agent 已退出计划模式开始执行。', severity: 'info' })
        }
        return
      }
      if (event.type === 'approval/asked') {
        const requestId = String(event.data?.id ?? '')
        if (requestId === '' || pendingApprovals.has(requestId)) return
        pendingApprovals.add(requestId)
        const toolName = typeof event.data?.toolName === 'string' ? event.data.toolName : undefined
        submit({
          kind: 'approval-pending',
          sessionId,
          label: labelOf(sessionId),
          summary: toolName === undefined ? '会话等待你的审批。' : `工具 ${toolName} 等待你的审批。`,
          severity: 'warn',
        })
        return
      }
      if (event.type === 'approval/decided') {
        pendingApprovals.delete(String(event.data?.id ?? ''))
        return
      }
      if (event.type === 'turn/end') {
        lastTurnEnd.set(sessionId, `turn 结束原因：${String(event.data?.reason ?? 'unknown')}`)
      }
    })

    ctx.on('agent/status', payload => {
      const isRunning = payload.status === 'running'
      const previous = running.get(payload.agent.id)
      running.set(payload.agent.id, isRunning)
      if (previous !== true || isRunning) return
      if (payload.agent.session?.header?.origin === 'subagent') return
      const sessionId = payload.agent.id
      // 防抖：窗口内只保留最新信号，结束后合并 turn/end 原因再投递
      const merged = {
        kind: 'loop-completed',
        sessionId,
        label: labelOf(sessionId),
        summary: '任务已跑完，Agent 回到空闲状态。',
        ...(lastTurnEnd.get(sessionId) === undefined ? {} : { detail: lastTurnEnd.get(sessionId) }),
        severity: 'info',
      }
      const existing = pendingLoops.get(sessionId)
      if (existing !== undefined) existing()
      pendingLoops.set(sessionId, ctx.timeout(() => {
        pendingLoops.delete(sessionId)
        submit(merged)
      }, DEBOUNCE_MS))
    })

    ctx.on('agent/error', payload => {
      const errorText = payload.error instanceof Error ? payload.error.message : String(payload.error ?? '')
      submit({
        kind: 'agent-error',
        sessionId: payload.agent?.id,
        label: labelOf(payload.agent?.id),
        summary: `turn ${payload.turn} step ${payload.step} 出错。`,
        detail: errorText.slice(0, 300),
        severity: 'error',
      })
    })

    ctx.on('subagent/end', info => {
      const stopReason = String(info.stopReason ?? 'unknown')
      submit({
        kind: 'subagent-completed',
        sessionId: typeof info.id === 'string' ? info.id : undefined,
        label: `${info.provider ?? 'subagent'}#${String(info.runId ?? '').slice(-6)}`,
        summary: `子代理结束：${stopReason}。`,
        severity: stopReason === 'completed' ? 'info' : 'warn',
      })
    })

    ctx.on('workflow/end', (info, result) => {
      submit({
        kind: 'workflow-completed',
        sessionId: undefined,
        label: `${typeof info?.meta?.name === 'string' ? info.meta.name : 'workflow'}#${String(info?.id ?? '').slice(-6)}`,
        summary: `工作流结束：${String(result?.stopReason ?? 'unknown')}，共启动 ${Number(result?.agentsStarted ?? 0)} 个 agent。`,
        ...(result?.error === undefined ? {} : { detail: String(result.error).slice(0, 300) }),
        severity: result?.stopReason === 'completed' ? 'info' : 'warn',
      })
    })

    ctx.on('goal/changed', payload => {
      if (payload.change?.operation !== 'complete') return
      const objective = typeof payload.change.goal?.objective === 'string' ? payload.change.goal.objective : undefined
      submit({
        kind: 'goal-completed',
        sessionId: payload.agent?.id,
        label: labelOf(payload.agent?.id),
        summary: objective === undefined ? '当前目标已标记完成。' : `目标已完成：${objective.slice(0, 160)}`,
        severity: 'info',
      })
    })

    // ---- 自服务工具 ----
    const outputDef = {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    }

    const maskOf = channel => ({
      id: channel.id,
      type: channel.type,
      enabled: channel.enabled,
      events: channel.events,
      ...(channel.sendKey ? { sendKey: `${String(channel.sendKey).slice(0, 6)}***` } : {}),
      ...(channel.url ? { url: channel.url } : {}),
    })

    ctx.effect(() => harness.registerTool(ctx, harness.defineTool({
      name: 'notify_set_channel',
      description: '配置 dsh-notify-live 的推送渠道（serverchan=Server酱³ 需 sendKey；webhook=自定义 URL；windows-toast=WSL 宿主 Toast）。同类型重复设置即覆盖。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['serverchan', 'webhook', 'windows-toast'] },
          enabled: { type: 'boolean', default: true },
          sendKey: { type: 'string', description: 'Server酱³ SendKey（sctp<uid>t…）' },
          url: { type: 'string', description: 'webhook 目标 URL 或 Server酱完整 API URL' },
          method: { type: 'string', enum: ['POST', 'PUT', 'GET'], default: 'POST' },
          bodyTemplate: { type: 'string', description: 'webhook 正文模板，支持 {{json}}/{{title}}/{{body}}' },
        },
        required: ['type'],
      },
      output: outputDef,
      async execute(args) {
        const id = `${args.type}-live`
        const existing = state.channels.find(row => row.id === id)
        const channel = {
          id,
          type: args.type,
          enabled: args.enabled !== false,
          events: existing?.events ?? {},
          ...(args.sendKey !== undefined ? { sendKey: args.sendKey } : {}),
          ...(args.url !== undefined ? { url: args.url } : {}),
          ...(args.method !== undefined ? { method: args.method } : {}),
          ...(args.bodyTemplate !== undefined ? { bodyTemplate: args.bodyTemplate } : {}),
        }
        const index = state.channels.findIndex(row => row.id === id)
        if (index >= 0) state.channels[index] = channel
        else state.channels.push(channel)
        log(`渠道已更新：${JSON.stringify(maskOf(channel))}`)
        return { ok: true, channels: state.channels.map(maskOf), eventSwitches: state.events }
      },
    })), 'tool notify_set_channel')

    ctx.effect(() => harness.registerTool(ctx, harness.defineTool({
      name: 'notify_toggle_event',
      description: '开关 dsh-notify-live 的某类事件监听。',
      parameters: {
        type: 'object',
        properties: {
          event: { type: 'string', enum: Object.keys(EVENT_LABELS) },
          enabled: { type: 'boolean' },
        },
        required: ['event', 'enabled'],
      },
      output: outputDef,
      async execute(args) {
        state.events[args.event] = args.enabled === true
        return { ok: true, eventSwitches: state.events }
      },
    })), 'tool notify_toggle_event')

    ctx.effect(() => harness.registerTool(ctx, harness.defineTool({
      name: 'notify_test_send',
      description: '向全部启用渠道发送 dsh-notify 测试通知并返回逐渠道结果。',
      parameters: { type: 'object', properties: {} },
      output: outputDef,
      async execute() {
        const message = renderMessage({
          kind: 'loop-completed',
          label: '测试',
          summary: '这是一条 dsh-notify-live 测试通知。',
          severity: 'info',
        })
        const enabled = state.channels.filter(row => row.enabled)
        if (enabled.length === 0) return { ok: false, note: '没有启用的渠道，先用 notify_set_channel 配置' }
        const results = []
        for (const channel of enabled) {
          try {
            await SENDERS[channel.type](channel, message)
            results.push({ id: channel.id, ok: true })
            sentCount += 1
          } catch (error) {
            results.push({ id: channel.id, ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 200) })
            failCount += 1
          }
        }
        return { ok: results.every(row => row.ok), results, sentCount, failCount }
      },
    })), 'tool notify_test_send')

    log('动态验证版已加载：7 类事件监听就绪；用 notify_set_channel 配置渠道后即可真实推送')
  },
}
