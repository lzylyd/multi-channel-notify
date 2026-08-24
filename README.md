# dsh-notify

<p align="center">
  <strong>DeepSeek Harness 消息通知插件 · 事件可配 × 渠道可配 × 路由矩阵</strong><br>
  <em>计划完成 · 回合完成 · 子代理完成 · 等待审批 · 运行出错 · 工作流完成 · 目标完成</em>
</p>

Agent 在后台跑长任务时，你不用再盯着网页圆点——事件发生即推送到你选的渠道。

## 是什么

一个纯社区维护的 DeepSeek Harness（DSH）通知插件：

- **7 类事件钩子**（每类独立开关）：计划完成（退出计划模式）、回合完成（Agent 回到空闲，仅根会话）、子代理完成、等待审批/提问、运行出错、工作流完成、目标完成
- **4 类推送渠道**（可多实例）：Server酱³、Windows Toast（Windows 原生 / WSL→宿主机）、企业微信群机器人、自定义 Webhook（ntfy / bark / 自有系统）
- **「事件 × 渠道」路由矩阵**：全局总闸 × 渠道启停 × 渠道级订阅三层布尔，任意组合
- **Web 设置页**：安装后设置页出现「消息推送」分区——配置表单（schema 自动渲染，密钥自动脱敏）+ 逐渠道「发送测试」按钮
- **防刷屏**：同会话同事件冷却、回合完成防抖（合并 turn/end 原因）、每渠道每分钟限流
- **永不阻塞主循环**：全部投递异步 fire-and-forget，单渠道失败重试退避（Toast 类环境性失败不重试），失败只记日志

## 安装

```sh
dsh plugin --profile web add dsh-notify   # 或本地路径 ./dsh-notify
dsh web                                   # 重启生效
```

零构建：纯 ESM JavaScript，无需 pnpm build。

## 快速配置

1. 设置页打开「消息推送」分区；
2. 在 dsh-notify 配置表单向 `channels` 添加渠道实例并启用；
3. 点「发送测试」验证链路；
4. 完成——之后事件发生即推送。

也可以直接编辑 `$DSH_HOME/settings.yaml` 的 `dsh-notify:` 段，保存实时生效。

## 渠道配置要点

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| Server酱³ | `sendKey` | 从 [SendKey 页](https://sc3.ft07.com/sendkey) 获取；uid 自动从 `sctp<uid>t…` 提取 |
| | `apiUrl` | 或直接粘完整 API URL（优先于 sendKey） |
| Windows Toast | `mode` | `auto` 自动判定 / `native` Windows 原生 / `wsl` 经 interop 弹宿主机 Toast；WinRT 实现，零依赖 |
| 企业微信机器人 | `webhookUrl` + 可选 `secret` | 加签按官方规则 HMAC-SHA256 |
| 自定义 Webhook | `url/method/headers/bodyTemplate` | 占位符 `{{json}}`（整对象 JSON）/`{{title}}`/`{{body}}`；模板留空发 `{"title": "…", "body": "…"}` |

WSL→宿主机 Toast 要求 interop 可用（PATH 中有 `powershell.exe` 或存在
`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`）；不可用时该渠道报错并在日志提示，不影响其他渠道。

## 去重与限流

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `dedup.cooldownMs` | 10000 | 同会话同事件冷却窗口 |
| `dedup.completedDebounceMs` | 1000 | 回合完成防抖（合并窗口内的连续边界与 turn/end 原因） |
| `dedup.perChannelPerMinute` | 20 | 每渠道每分钟上限 |

审批等待按请求 id 精确去重，`approval/decided` 到达即解除占位。

## 与 dsh-std 社区规范的关系

包根目录提供合法的 [dsh-std](https://github.com/Yan-Zero/dsh-std) Community v0.15
`dsh-plugin.json` 清单（身份元数据完整；`MessageObserver` 以 optional 契约声明并附 fallback）。
当前适配层尚未发布可观察的 agent 生命周期协议，因此事件监听经宿主原生事件通道在 Cordis
插件行中实现；标准 facet 入口（`lib/std.js`）以无副作用的 degraded 状态发布自身扩展，
作为上游协议就绪后的迁移点。该差异在清单 fallback 与源码注释中均有声明。

## 数据与隐私

- 推送内容只含事件摘要（会话标题/错误截断文本），不携带对话正文全文；
- SendKey/webhook 密钥仅存于本机 `$DSH_HOME/settings.yaml`，设置接口返回脱敏视图，日志不含密钥；
- 配置/测试路由带同源校验，跨站读取被 CORS 挡在读之外。

## 已知限制

- macOS 通知、飞书机器人暂未内置（渠道注册表统一接口，欢迎 PR）；
- 「计划完成」依赖会话日志中的 `plan/mode` 跃迁：插件加载前已处于计划模式的首次退出不会补报；
- Windows Toast 的 WinRT AUMID 复用 PowerShell，通知左下角应用名显示为 PowerShell。

## License

[MIT](LICENSE)
