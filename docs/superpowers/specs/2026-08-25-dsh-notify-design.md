# dsh-notify 设计文档

- 日期：2026-08-25
- 状态：已经用户三轮确认批准
- 形态：DeepSeek Harness 社区插件包（零构建 ESM）

## 1. 目标

一个可配置的 DSH 消息通知插件：监听多种 Agent 生命周期事件，按「事件 × 渠道」路由矩阵推送到多个渠道。所有事件与渠道均可独立开关。

## 2. 需求（用户已确认）

### 事件（第一版 7 个，全部启用）
| 事件 | hook 挂点 | 关键语义 |
| --- | --- | --- |
| plan-completed | `session/event` 的 `plan/mode` | active true→false 跃迁 = 计划批准/退出计划模式 |
| loop-completed | `agent/status` running→idle | 仅根会话（`agent.session.header.origin === 'subagent'` 排除），防抖合并 turn/end 原因 |
| subagent-completed | `subagent/end` | stopReason: completed/aborted/error/max-tokens/refusal |
| approval-pending | `session/event` 的 `approval/asked` | 按 ApprovalRequestId 去重；`approval/decided` 到达即清除 |
| agent-error | `agent/error` | 错误摘要截断 300 字符 |
| workflow-completed | `workflow/end` | stopReason + agentsStarted |
| goal-completed | `goal/changed` | operation === 'complete' 才通知 |

### 渠道（第一版 4 类适配器、支持多实例）
| 类型 | 要点 |
| --- | --- |
| serverchan | Server酱³ `https://<uid>.push.ft07.com/send/<sendkey>.send`；uid 可从 sendkey（`/^sctp(\d+)t/`）提取或直接填完整 API URL；POST JSON：title/desp(markdown)/short/tags |
| windows-toast | 单适配器三模式：`auto`（win32→native，WSL→interop 自动判定）/`native`（DSH 直接跑在 Windows）/`wsl`（经 powershell.exe interop 弹宿主机 WinRT Toast）；无需第三方依赖 |
| wecom | 企业微信群机器人 webhook；msgtype=markdown；可选加签（base64(hmac-sha256(key=secret, msg=`${timestamp}\n${secret}`))） |
| webhook | 通用 HTTP：method/headers/bodyTemplate 全可配，占位符 `{{json}}`（整对象替换）/`{{title}}`/`{{body}}`；兼容 ntfy/bark/自有系统 |

macOS、飞书未选入第一版；渠道注册表统一接口，后续加渠道只需新增一个适配器文件。

### 配置
- settings 命名空间 `dshNotify`（schemastery schema，secret 字段 `.role('secret')` 自动脱敏）
- `$DSH_HOME/settings.yaml` 直改实时生效（settings watch）
- Web 设置页自动渲染 schema 表单 + 本插件自带「消息推送」分区（状态展示 + 渠道测试按钮）
- 路由粒度：全局事件开关 × 渠道实例启用 × 渠道级事件订阅矩阵（三层布尔）

## 3. 架构（双入口共享内核）

```
dsh-notify/
├── dsh-plugin.json      # Community v0.15 清单：身份 + requires(MessageObserver optional)
│                        # facets.host.entry → ./lib/std.js（schema 必填项）
├── cordis.patch.yml     # Cordis 行装载 ./lib/index.js（完整功能主入口）
├── package.json         # main ./lib/index.js；exports ./client；dsh.bundle.patch + dsh.client.platform=web
├── lib/
│   ├── index.js         # Cordis 入口：apply(ctx, config)；唯一接触 live 对象的文件
│   ├── kernel.js        # 纯函数内核：信号提取/路由决策/模板渲染/去重限流状态机
│   ├── dispatcher.js    # 调度器：信号入口 → 路由 → 渲染 → 逐渠道异步投递(重试退避)
│   ├── config-schema.js # schemastery 配置模型（Loader config 与 settings ns 共用）
│   ├── routes.js        # GET/POST /dsh-notify/config（同源校验+脱敏）；POST /dsh-notify/test
│   ├── std.js           # 标准 FacetModule：adapter-dsh 激活路径，无副作用降级声明
│   └── channels/        # serverchan.js / windows-toast.js / wecom.js / webhook.js / index.js 注册表
├── client/client.js     # 「消息推送」设置分区：状态卡片 + 渠道测试按钮
└── test/                # node --test：kernel 纯函数 + 各渠道请求构造
```

数据流：
```
live 对象(index.js 解包为纯标量) → Signal{kind,sessionId,label,summary,detail,severity,time}
  → kernel.shouldDeliver(config,signal)(三层开关+冷却+限流)
  → kernel.render(config,channel,signal)(title/body 模板)
  → channel.send(msg) fire-and-forget，失败重试×2指数退避，绝不抛出
  → ctx.logger 记录结果（不含密钥）
```

## 4. dsh-std 合规策略（用户已批准的修正案）

- 根目录提供合法的 Community v0.15 `dsh-plugin.json`：身份元数据完整、license/source 可定位。
- `requires.contracts` 声明 `messages.dsh/v1alpha1 MessageObserver` 为 **optional** 并给出 fallback 说明——当前适配层未发布该 support，协商通过 optional 语义不阻塞激活。
- `facets.host.entry`（schema 必填）指向 `lib/std.js`：被 `@dsh-std/adapter-dsh` 激活时仅发布状态扩展并报告 degraded（事件协议尚未标准化），不做任何通知副作用，避免与 Cordis 主路径双重触发。
- 实际事件监听走宿主原生事件通道（今天唯一能触达 7 个事件的途径）；README 明确标注该差异与未来迁移点。
- 生命周期语义对齐 TUI-OBS-001：全部监听/路由/定时器归属 activation scope，ctx.effect/effect(() => disposer) 管理，停用即清理。

## 5. 关键实现决定

- **零构建**：纯 ESM JavaScript，`node --test` 单测，无 TS/打包工具链；peerDependencies 仅 `@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`、`react`。
- **会话标题**：监听 `session/title` 事件维护 `Map<sessionId,title>`，负缓存防重复兜底查询。
- **审批去重**：`approval/decided`（同 id）到达即从 pending 集合移除；冷却窗口兜底防刷屏。
- **WSL Toast**：`WSL_DISTRO_NAME` 或 `/proc/version` 含 microsoft 判定 WSL；优先 PATH 中 `powershell.exe`，回退 `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`；WinRT ToastNotificationManager + PowerShell AUMID；单次调用 10s 超时。
- **安全**：POST 路由同源校验（Origin/Referer vs Host）；secret 字段脱敏；日志不含密钥与全文正文（截断）。
- **失败隔离**：单渠道异常只记日志；投递队列永不阻塞 agent loop。

## 6. 测试

- kernel：路由矩阵三层开关真值表、模板渲染变量替换、冷却/限流/防抖时间行为（注入时钟）。
- channels：各渠道请求构造断言（URL/init/powershell 参数数组），网络与子进程注入 mock。
- 清单：按本地 dsh-plugin-0.15.schema.json 结构校验。

## 7. 发布约定

GitHub topic:dsh-plugin · MIT · 安装：`dsh plugin --profile web add dsh-notify` 后重启 `dsh web`。
