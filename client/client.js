/**
 * dsh-notify —— Web Client 入口（零构建，ModuleLoader 包装格式）。
 *
 * 在 DSH 设置页注册「消息推送」分区：展示渠道状态、逐渠道测试按钮。
 * 配置编辑本体由 settings 命名空间 schema 自动渲染的表单承担；本分区只做
 * schema 表单做不到的事——调用 host 端 /dsh-notify/test 做真实链路测试。
 */
window.__ModuleLoader__.load({
	id: "dsh-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		const h = react.createElement;

		/** 渠道类型中文名。 */
		const TYPE_LABELS = {
			serverchan: "Server酱³",
			"windows-toast": "Windows Toast",
			wecom: "企业微信机器人",
			webhook: "自定义 Webhook",
		};

		const styles = {
			card: { display: "flex", flexDirection: "column", gap: 10 },
			row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			name: { fontWeight: 600 },
			muted: { opacity: 0.65, fontSize: 12 },
			badge: {
				fontSize: 11,
				padding: "1px 8px",
				borderRadius: 999,
				border: "1px solid currentColor",
				opacity: 0.9,
			},
			button: { cursor: "pointer", padding: "3px 12px", borderRadius: 6 },
			result: { fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" },
		};

		/** 单个渠道行。 */
		function ChannelRow(props) {
			const channel = props.channel;
			const [busy, setBusy] = react.useState(false);
			const [note, setNote] = react.useState("");
			const typeLabel = TYPE_LABELS[channel.type] ?? channel.type;
			async function test() {
				setBusy(true);
				setNote("");
				try {
					const response = await fetch("/dsh-notify/test", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ channelId: channel.id }),
					});
					const data = await response.json().catch(() => null);
					const row = data && Array.isArray(data.results) ? data.results[0] : null;
					if (!data || !Array.isArray(data.results)) setNote(`HTTP ${response.status}`);
					else if (row === null) setNote(data.note ?? "没有匹配渠道");
					else if (row.ok) setNote("✅ 已发送");
					else setNote("❌ 发送失败（详见 harness 日志）");
				} catch (error) {
					setNote(`❌ ${String(error instanceof Error ? error.message : error)}`);
				} finally {
					setBusy(false);
				}
			}
			return h(
				"div",
				{ style: styles.row },
				h("span", { style: styles.name }, channel.id),
				h("span", { style: styles.badge }, typeLabel),
				channel.enabled ? null : h("span", { style: styles.muted }, "未启用"),
				h(
					"button",
					{ style: styles.button, disabled: busy || !channel.enabled, onClick: test },
					busy ? "发送中…" : "发送测试",
				),
				note === "" ? null : h("span", { style: styles.muted }, note),
			);
		}

		/** 分区主体。 */
		function NotifySection() {
			const [view, setView] = react.useState(null);
			const load = react.useCallback(() => {
				fetch("/dsh-notify/config")
					.then((r) => r.json())
					.then(setView)
					.catch(() => setView({ status: "unavailable" }));
			}, []);
			react.useEffect(load, [load]);
			const config = view?.value;
			const channels = Array.isArray(config?.channels) ? config.channels : [];
			return h(
				"div",
				{ style: styles.card },
				view === null ? h("span", { style: styles.muted }, "加载中…") : null,
				view !== null && view.status !== "ready"
					? h("span", { style: styles.muted }, "配置命名空间不可用（host 端插件未就绪）。")
					: null,
				channels.length === 0 && view?.status === "ready"
					? h(
							"span",
							{ style: styles.muted },
							"还没有配置任何渠道：在上方「dsh-notify」表单里向 channels 数组添加实例（Server酱³ / Windows Toast / 企业微信 / Webhook），保存后回到这里点「发送测试」。",
						)
					: null,
				channels.map((channel) => h(ChannelRow, { key: channel.id, channel })),
			);
		}

		/** 必需 client 服务。 */
		const inject = ["slots"];

		/** 注册设置分区。 */
		function apply(ctx) {
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "dsh-notify",
						order: 1001,
						label: "消息推送",
					},
					NotifySection,
				),
			);
		}

		exports.name = "dsh-notify";
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
