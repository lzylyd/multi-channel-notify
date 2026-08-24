/**
 * dsh-notify 配置模型。
 *
 * 同一份 schema 承担两个角色：
 * - Loader config（cordis.patch.yml 中该插件行的 `config:`，成为 settings base 层）；
 * - `ctx.settings.register('dshNotify', Config, { base })` 的命名空间 schema，
 *   Web 设置页据此自动渲染表单，secret 字段自动脱敏。
 */

import Schema from '@deepseek-ai/schemastery'

/** 七个事件的开关组（与 kernel.EVENT_KINDS 一一对应）。 */
function eventSwitches(defaults) {
  return Schema.object({
    'plan-completed': Schema.boolean().default(defaults['plan-completed']).description('计划完成（退出计划模式/计划被批准）'),
    'loop-completed': Schema.boolean().default(defaults['loop-completed']).description('回合完成（Agent 回到空闲）'),
    'subagent-completed': Schema.boolean().default(defaults['subagent-completed']).description('子代理完成'),
    'approval-pending': Schema.boolean().default(defaults['approval-pending']).description('等待审批/提问'),
    'agent-error': Schema.boolean().default(defaults['agent-error']).description('运行出错'),
    'workflow-completed': Schema.boolean().default(defaults['workflow-completed']).description('工作流完成'),
    'goal-completed': Schema.boolean().default(defaults['goal-completed']).description('目标完成'),
  })
}

/** 单个渠道实例的 schema（扁平结构，按 type 取用相关字段）。 */
function channelSchema() {
  return Schema.object({
    id: Schema.string().description('渠道实例唯一 id（留空自动生成）'),
    type: Schema.union(['serverchan', 'windows-toast', 'wecom', 'webhook']).required().description('渠道类型'),
    enabled: Schema.boolean().default(false).description('启用该渠道'),
    events: eventSwitches({
      'plan-completed': true,
      'loop-completed': true,
      'subagent-completed': true,
      'approval-pending': true,
      'agent-error': true,
      'workflow-completed': true,
      'goal-completed': true,
    }).description('该渠道订阅的事件（与全局开关同时生效）'),
    serverchan: Schema.object({
      sendKey: Schema.string().role('secret').description('SendKey（sc3.ft07.com/sendkey 页获取）'),
      apiUrl: Schema.string().description('或直接填完整 API URL（优先于 sendKey）'),
      short: Schema.string().description('消息卡片简述（可选）'),
      tags: Schema.string().description('标签，竖线分隔（可选）'),
    }),
    windowsToast: Schema.object({
      mode: Schema.union(['auto', 'native', 'wsl']).default('auto')
        .description('auto=按环境判定；native=Windows 原生；wsl=经 interop 弹宿主机 Toast'),
    }),
    wecom: Schema.object({
      webhookUrl: Schema.string().description('群机器人 Webhook 地址（含 ?key=）'),
      secret: Schema.string().role('secret').description('加签密钥（机器人安全设置-加签，可选）'),
      timeoutMs: Schema.number().default(5000).description('请求超时毫秒'),
    }),
    webhook: Schema.object({
      url: Schema.string().description('目标 URL'),
      method: Schema.union(['POST', 'PUT', 'GET']).default('POST').description('HTTP 方法'),
      headers: Schema.dict(Schema.string()).description('额外请求头'),
      bodyTemplate: Schema.string().role('textarea').description(
        '正文模板：{{json}} 整体 JSON / {{title}} / {{body}}；留空发 {"title","body"}',
      ),
      timeoutMs: Schema.number().default(5000).description('请求超时毫秒'),
    }),
  }).description('渠道实例')
}

export const Config = Schema.object({
  events: eventSwitches({
    'plan-completed': true,
    'loop-completed': true,
    'subagent-completed': true,
    'approval-pending': true,
    'agent-error': true,
    'workflow-completed': false,
    'goal-completed': false,
  }).description('全局事件开关（总闸）'),
  channels: Schema.array(channelSchema()).default([]).description('推送渠道列表（可添加多个实例）'),
  dedup: Schema.object({
    cooldownMs: Schema.number().min(0).default(10_000).description('同会话同事件冷却毫秒'),
    completedDebounceMs: Schema.number().min(0).default(1_000).description('回合完成防抖毫秒'),
    perChannelPerMinute: Schema.number().min(1).default(20).description('每渠道每分钟上限'),
  }).description('去重与限流'),
  message: Schema.object({
    titlePrefix: Schema.string().default('').description('标题前缀，如「[DSH]」'),
    guiUrl: Schema.string().default('http://127.0.0.1:3080').description('通知里附带的 DSH 地址'),
  }).description('消息外观'),
})
