/**
 * multi-channel-notify —— Web Client 入口（零构建，ModuleLoader 包装格式）。
 *
 * 设置页「消息推送」分区：
 * - 可视化配置：全局事件开关、渠道卡片（含 write-only 密钥输入）、消息外观与限流；
 * - 保存/加载：GET 脱敏视图 → 本地编辑 → 差分 path-ops POST（expectedRevision 防冲突；
 *   密钥字段只在用户实际输入时下发，避免脱敏回写清空已存密钥）；
 * - 导航图标：DSH 0.1.x 的 settings.section 契约只投影 id/order/label，
 *   借鉴 dsh-better-sidebar 的 DOM 标记方案，用 currentColor mask 把默认齿轮
 *   换成 Lucide volume-2（喇叭），跟随导航悬停/激活配色。
 */
window.__ModuleLoader__.load({
	id: "multi-channel-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		const h = react.createElement;

		// ---- 常量 ----
		const ROUTE_PREFIX = "/multi-channel-notify";
		const SECTION_LABEL = "消息推送";
		const NAV_MARKER = "data-mcn-settings-nav";

		const EVENT_LABELS = {
			"plan-completed": ["计划完成", "退出计划模式/计划被批准"],
			"loop-completed": ["回合完成", "Agent 回到空闲"],
			"subagent-completed": ["子代理完成", "后台 subagent 结束"],
			"approval-pending": ["等待审批", "工具调用等待确认"],
			"agent-error": ["运行出错", "Agent 执行报错"],
			"workflow-completed": ["工作流完成", "workflow 编排结束"],
			"goal-completed": ["目标完成", "完成目标被标记 complete"],
		};
		const EVENT_KINDS = Object.keys(EVENT_LABELS);

		const TYPE_LABELS = {
			serverchan: "Server酱³",
			"windows-toast": "Windows Toast",
			wecom: "企业微信机器人",
			webhook: "自定义 Webhook",
		};

		/** 各渠道类型可编辑字段（label/type）；secret 字段单独标注。 */
		const TYPE_FIELDS = {
			serverchan: [
				{ key: "sendKey", label: "SendKey", secret: true, placeholder: "sctp…t…" },
				{ key: "apiUrl", label: "API URL（可选，优先于 SendKey）" },
				{ key: "short", label: "卡片简述（可选）" },
				{ key: "tags", label: "标签（竖线分隔，可选）" },
			],
			"windows-toast": [
				// 注意桶名是 camelCase 的 windowsToast（与 config-schema.js 声明一致），
				// kebab 的渠道 type 不能直接当字段桶名——曾因此读写双失效
				{ bucket: "windowsToast", key: "mode", label: "弹出来源", kind: "select", options: ["auto", "native", "wsl"] },
			],
			wecom: [
				{ key: "webhookUrl", label: "群机器人 Webhook 地址（含 ?key=）" },
				{ key: "secret", label: "加签密钥（可选）", secret: true },
				{ key: "timeoutMs", label: "请求超时毫秒", kind: "number" },
			],
			webhook: [
				{ key: "url", label: "目标 URL" },
				{ key: "method", label: "HTTP 方法", kind: "select", options: ["POST", "PUT", "GET"] },
				{ key: "headers", label: "额外请求头（每行 Key: Value）", kind: "dict" },
				{ key: "bodyTemplate", label: "正文模板（{{json}}/{{title}}/{{body}}，留空发默认 JSON）", kind: "textarea" },
				{ key: "timeoutMs", label: "请求超时毫秒", kind: "number" },
			],
		};
		const styles = {
			card: { display: "flex", flexDirection: "column", gap: 12 },
			group: { display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", border: "1px solid var(--ds-border-color, rgba(128,128,128,.25))", borderRadius: 10 },
			groupTitle: { fontWeight: 600, fontSize: 13 },
			muted: { opacity: 0.65, fontSize: 12 },
			row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			col: { display: "flex", flexDirection: "column", gap: 4 },
			name: { fontWeight: 600 },
			badge: { fontSize: 11, padding: "1px 8px", borderRadius: 999, border: "1px solid currentColor", opacity: 0.9 },
			button: { cursor: "pointer", padding: "3px 12px", borderRadius: 6 },
			buttonPrimary: { cursor: "pointer", padding: "5px 16px", borderRadius: 6, fontWeight: 600 },
			input: { padding: "4px 8px", borderRadius: 6, border: "1px solid var(--ds-border-color, rgba(128,128,128,.35))", background: "transparent", color: "inherit", minWidth: 220 },
			result: { fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" },
			eventRow: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px", alignItems: "center" },
			channelHead: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			dangerBtn: { cursor: "pointer", marginLeft: "auto", padding: "2px 10px", borderRadius: 6, color: "#e5484d", borderColor: "#e5484d55" },
		};

		// ---- 小组件 ----
		function Toggle(props) {
			return h("input", {
				type: "checkbox",
				checked: props.checked === true,
				onChange: (e) => props.onChange(e.target.checked === true),
				style: { width: 16, height: 16, accentColor: "var(--ds-accent-color, currentColor)" },
			});
		}

		function TextField(props) {
			const common = {
				style: styles.input,
				placeholder: props.placeholder,
				value: props.value ?? "",
				onChange: (e) => props.onChange(e.target.value),
			};
			if (props.kind === "number") return h("input", { ...common, type: "number", value: props.value ?? "", onChange: (e) => props.onChange(e.target.value === "" ? undefined : Number(e.target.value)) });
			if (props.kind === "textarea") return h("textarea", { ...common, rows: 2 });
			if (props.kind === "password") return h("input", { ...common, type: "password", autoComplete: "off" });
			return h("input", { ...common });
		}

		/** 字典编辑器：每行「Key: Value」（首个冒号分隔），空行忽略。 */
		function DictField(props) {
			const text = Object.entries(props.value ?? {})
				.map(([k, v]) => `${k}: ${v}`)
				.join("\n");
			return h("textarea", {
				style: { ...styles.input, minWidth: 280, fontFamily: "monospace" },
				rows: 2,
				placeholder: props.placeholder ?? "X-Token: abc\nX-Env: prod",
				value: text,
				onChange: (e) => {
					const next = {};
					for (const line of String(e.target.value).split("\n")) {
						const trimmed = line.trim();
						if (trimmed === "") continue;
						const sep = trimmed.indexOf(":");
						if (sep <= 0) continue;
						next[trimmed.slice(0, sep).trim()] = trimmed.slice(sep + 1).trim();
					}
					props.onChange(Object.keys(next).length > 0 ? next : undefined);
				},
			});
		}

		function SelectField(props) {
			return h(
				"select",
				{ style: styles.input, value: String(props.value ?? props.options[0]), onChange: (e) => props.onChange(e.target.value) },
				props.options.map((opt) => h("option", { key: opt, value: opt }, opt)),
			);
		}

		/** 事件开关网格。 */
		function EventGrid(props) {
			const events = props.events ?? {};
			return h(
				"div",
				{ style: styles.eventRow },
				EVENT_KINDS.map((kind) =>
					h(react.Fragment, { key: kind }, [
						h(Toggle, { checked: events[kind], onChange: (v) => props.onChange(kind, v) }),
						h("span", null, h("div", null, h("span", { style: styles.name }, EVENT_LABELS[kind][0]), " ", h("span", { style: styles.muted }, EVENT_LABELS[kind][1]))),
					]),
				),
			);
		}

		// ---- 渠道卡片 ----
		let autoSeq = 0;
		function newChannel(type) {
			autoSeq += 1;
			return {
				id: `${type}-${Date.now().toString(36)}${autoSeq}`,
				type,
				enabled: false,
				events: Object.fromEntries(EVENT_KINDS.map((k) => [k, true])),
			};
		}

		function secretIsSet(view, channelId, type, fieldKey) {
			const channelIndex = (view?.value?.channels ?? []).findIndex((c) => c.id === channelId);
			if (channelIndex < 0 || !Array.isArray(view?.secrets)) return false;
			return view.secrets.some(
				(entry) =>
					Array.isArray(entry.path) &&
					entry.path[0] === "channels" &&
					String(entry.path[1]) === String(channelIndex) &&
					entry.path[2] === type &&
					entry.path[3] === fieldKey &&
					entry.set === true,
			);
		}

		function ChannelCard(props) {
			const { channel, view, onChange, onRemove, onEdited } = props;
			const [busy, setBusy] = react.useState(false);
			const [note, setNote] = react.useState("");
			const fields = TYPE_FIELDS[channel.type] ?? [];

			async function test() {
				setBusy(true);
				setNote("");
				try {
					const response = await fetch(`${ROUTE_PREFIX}/test`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ channelId: channel.id }),
					});
					const data = await response.json().catch(() => null);
					const row = data && Array.isArray(data.results) ? data.results.find((r) => r.id === channel.id) : null;
					if (!data || !Array.isArray(data.results)) setNote(`HTTP ${response.status}`);
					else if (!row) setNote("⚠️ 未测试：渠道需先保存且处于启用状态");
					else if (row.ok) setNote("✅ 测试通知已发送");
					else setNote("❌ 发送失败（详见 harness 日志）");
				} catch (error) {
					setNote(`❌ ${String(error instanceof Error ? error.message : error)}`);
				} finally {
					setBusy(false);
				}
			}

			return h(
				"div",
				{ style: { ...styles.group, gap: 8 } },
				h(
					"div",
					{ style: styles.channelHead },
					h(Toggle, { checked: channel.enabled, onChange: (v) => onChange({ ...channel, enabled: v }) }),
					h("span", { style: styles.name }, channel.id),
					h("span", { style: styles.badge }, TYPE_LABELS[channel.type] ?? channel.type),
					h(
						"button",
						{ style: styles.dangerBtn, onClick: () => onRemove(channel.id), title: "删除该渠道" },
						"删除",
					),
				),
				// 该渠道自己的事件订阅（覆盖全局开关）
				h(
					"details",
					{ style: { fontSize: 12 } },
					h("summary", { style: { cursor: "pointer", opacity: 0.75 } }, "订阅事件（默认跟随全局总闸）"),
					h("div", { style: { ...styles.eventRow, marginTop: 6 } },
						EVENT_KINDS.map((kind) =>
							h(react.Fragment, { key: kind }, [
								h(Toggle, {
									checked: channel.events?.[kind] !== false,
									onChange: (v) => onChange({ ...channel, events: { ...channel.events, [kind]: v } }),
								}),
								h("span", null, EVENT_LABELS[kind][0]),
							]),
						),
					),
				),
				// 类型相关字段
				...fields.map((field) => {
					const bucketName = field.bucket ?? channel.type;
					const bucket = channel[bucketName] ?? {};
					const isSecret = field.secret === true;
					const hint = isSecret && secretIsSet(view, channel.id, channel.type, field.key)
						? h("span", { style: styles.muted }, "已保存（留空保持不变）")
						: null;
					const controlProps = {
						label: field.label,
						options: field.options,
						kind: isSecret ? "password" : field.kind,
						placeholder: isSecret ? (secretIsSet(view, channel.id, channel.type, field.key) ? "••••••••" : field.placeholder) : field.placeholder,
						value: isSecret ? "" : bucket[field.key],
						onChange: (v) => {
							if (isSecret && v === "") return; // 空=保持已存值
							onEdited({ ...channel, [bucketName]: { ...bucket, [field.key]: v } });
						},
					};
					const control =
						field.kind === "select" ? h(SelectField, controlProps)
						: field.kind === "dict" ? h(DictField, controlProps)
						: h(TextField, controlProps);
					return h(
						"label",
						{ key: field.key, style: styles.col },
						h("span", { style: { fontSize: 12 } }, field.label, " ", hint),
						control,
					);
				}),
				note === "" ? null : h("span", { style: styles.result }, note),
				h(
					"button",
					{ style: styles.button, onClick: test, disabled: busy || channel.enabled !== true, title: channel.enabled !== true ? "启用并保存后才能测试" : undefined },
					busy ? "发送中…" : "发送测试",
				),
			);
		}

		// ---- 主分区 ----
		function NotifySection() {
			const [view, setView] = react.useState(null);
			const [draft, setDraft] = react.useState(null);
			const [saveNote, setSaveNote] = react.useState("");
			const [saving, setSaving] = react.useState(false);

			const load = react.useCallback(() => {
				fetch(`${ROUTE_PREFIX}/config`)
					.then((r) => r.json())
					.then((data) => {
						setView(data);
						if (data?.status === "ready") setDraft(JSON.parse(JSON.stringify(data.value)));
					})
					.catch(() => setView({ status: "unavailable" }));
			}, []);
			react.useEffect(load, [load]);

			if (view === null) return h("div", { style: styles.card }, h("span", { style: styles.muted }, "加载中…"));
			if (view.status !== "ready" || draft === null) {
				return h("div", { style: styles.card }, h("span", { style: styles.muted }, "配置命名空间不可用（host 端插件未就绪）。"), h("button", { style: styles.button, onClick: load }, "重试"));
			}

			const patch = (mutate) => setDraft((current) => ({ ...current, ...mutate(current) }));
			const channels = Array.isArray(draft.channels) ? draft.channels : [];

			async function save() {
				setSaving(true);
				setSaveNote("");
				try {
					// 协议：交编辑态全文；已存密钥不在视图里（天然不会回传），
					// 宿主按渠道 id 合并保留，仅覆盖本会话实际输入的新密钥。
					const response = await fetch(`${ROUTE_PREFIX}/config`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ config: draft, expectedRevision: view.revision }),
					});
					const data = await response.json().catch(() => null);
					if (response.status === 409) setSaveNote("⚠️ 配置已被其他窗口修改，请点「重新加载」后再改");
					else if (!response.ok || data?.ok !== true) setSaveNote(`❌ 保存失败：${data?.error ?? `HTTP ${response.status}`}`);
					else {
						setSaveNote("✅ 已保存并实时生效");
						load();
					}
				} catch (error) {
					setSaveNote(`❌ ${String(error instanceof Error ? error.message : error)}`);
				} finally {
					setSaving(false);
				}
			}

			return h(
				"div",
				{ style: styles.card },
				// 事件开关
				h("div", { style: styles.group },
					h("div", { style: styles.groupTitle }, "事件开关"),
					h(EventGrid, {
						events: draft.events,
						onChange: (kind, v) => patch((cur) => ({ events: { ...cur.events, [kind]: v } })),
					}),
				),
				// 渠道列表
				h("div", { style: styles.group },
					h("div", { style: styles.groupTitle }, "推送渠道"),
					channels.length === 0 ? h("span", { style: styles.muted }, "还没有渠道，从下面添加一个。") : null,
					...channels.map((channel) =>
						h(ChannelCard, {
							key: channel.id,
							channel,
							view,
							onChange: (next) => patch((cur) => ({ channels: cur.channels.map((c) => (c.id === channel.id ? next : c)) })),
							onRemove: (id) => patch((cur) => ({ channels: cur.channels.filter((c) => c.id !== id) })),
						}),
					),
					h("div", { style: styles.row },
						Object.keys(TYPE_LABELS).map((type) =>
							h(
								"button",
								{
									key: type,
									style: styles.button,
									onClick: () => patch((cur) => ({ channels: [...(cur.channels ?? []), newChannel(type)] })),
								},
								`＋ ${TYPE_LABELS[type]}`,
							),
						),
					),
				),
				// 消息外观
				h("div", { style: styles.group },
					h("div", { style: styles.groupTitle }, "消息外观"),
					h("label", { style: styles.row },
						h("span", { style: { minWidth: 200, fontSize: 12 } }, "标题前缀"),
						h(TextField, { value: draft.message?.titlePrefix ?? "", onChange: (v) => patch((cur) => ({ message: { ...cur.message, titlePrefix: v } })) }),
					),
					h("label", { style: styles.row },
						h("span", { style: { minWidth: 200, fontSize: 12 } }, "通知里的 DSH 地址"),
						h(TextField, { value: draft.message?.guiUrl ?? "", onChange: (v) => patch((cur) => ({ message: { ...cur.message, guiUrl: v } })) }),
					),
				),
				// 高级
				h("details", { style: styles.group },
					h("summary", { style: { cursor: "pointer", fontWeight: 600, fontSize: 13 } }, "去重与限流（高级）"),
					...["cooldownMs", "completedDebounceMs", "perChannelPerMinute"].map((key) =>
						h("label", { key, style: { ...styles.row, marginTop: 6 } },
							h("span", { style: { minWidth: 200, fontSize: 12 } }, { cooldownMs: "同会话同事件冷却(ms)", completedDebounceMs: "回合完成防抖(ms)", perChannelPerMinute: "每渠道每分钟上限" }[key]),
							h(TextField, { kind: "number", value: draft.dedup?.[key], onChange: (v) => patch((cur) => ({ dedup: { ...cur.dedup, [key]: v } })) }),
						),
					),
				),
				// 保存栏
				h("div", { style: styles.row },
					h("button", { style: styles.buttonPrimary, onClick: save, disabled: saving }, saving ? "保存中…" : "💾 保存配置"),
					h("button", { style: styles.button, onClick: load, disabled: saving }, "重新加载"),
					saveNote === "" ? null : h("span", { style: styles.result }, saveNote),
				),
			);
		}

		// ---- 设置导航喇叭图标（DOM 标记 + currentColor mask，参照 better-sidebar 方案）----
		const VOLUME_SVG_MASK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M11 5 6 9H2v6h4l5 4z'/%3E%3Cpath d='M15.54 8.46a5 5 0 0 1 0 7.07'/%3E%3Cpath d='M19.07 4.93a10 10 0 0 1 0 14.14'/%3E%3C/svg%3E")`;
		const NAV_ICON_STYLE_ID = "multi-channel-notify-nav-icon";
		const NAV_ICON_CSS = `
[data-mcn-settings-nav] > svg:first-child { display: none; }
[data-mcn-settings-nav]::before {
	content: '';
	flex: none;
	width: 16px;
	height: 16px;
	background: currentColor;
	-webkit-mask: ${VOLUME_SVG_MASK} center / contain no-repeat;
	mask: ${VOLUME_SVG_MASK} center / contain no-repeat;
}`;

		/**
		 * 给文本匹配的设置导航按钮打标记；返回清理函数（observer + 标记 + 样式）。
		 * 局限：按当前界面语言的分区文本精确匹配（与 better-sidebar 同款方案；
		 * 其支持 locale thunk，本插件暂为单语言硬编码）。运行时若切换语言，
		 * 图标优雅回退齿轮，不影响功能。
		 */
		function registerSettingsNavIcon(labelText) {
			let disposed = false;
			const sync = () => {
				if (disposed) return;
				const buttons = document.querySelectorAll('[role="dialog"] nav button');
				for (const button of buttons) {
					const match = button.textContent?.trim() === labelText;
					const marked = button.hasAttribute(NAV_MARKER);
					if (match === marked) continue; // 无变更不写 DOM
					if (match) button.setAttribute(NAV_MARKER, "");
					else button.removeAttribute(NAV_MARKER);
				}
			};
			sync();
			const observer = new MutationObserver(sync);
			observer.observe(document.body, { childList: true, subtree: true, characterData: true });
			let style = document.getElementById(NAV_ICON_STYLE_ID);
			if (style === null) {
				style = document.createElement("style");
				style.id = NAV_ICON_STYLE_ID;
				style.textContent = NAV_ICON_CSS;
				document.head.appendChild(style);
			}
			return () => {
				disposed = true;
				observer.disconnect();
				document.querySelectorAll(`[${NAV_MARKER}]`).forEach((el) => el.removeAttribute(NAV_MARKER));
				document.getElementById(NAV_ICON_STYLE_ID)?.remove();
			};
		}

		/** 必需 client 服务。 */
		const inject = ["slots"];

		/** 注册设置分区。 */
		function apply(ctx) {
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "multi-channel-notify",
						order: 1001,
						label: SECTION_LABEL,
					},
					NotifySection,
				),
			);
			// 导航图标替换（fiber 卸载时自动还原齿轮）
			ctx.effect(() => registerSettingsNavIcon(SECTION_LABEL), "settings nav speaker icon");
		}

		exports.name = "multi-channel-notify";
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
