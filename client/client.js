/**
 * multi-channel-notify —— Web Client 入口（零构建，ModuleLoader 包装格式）。
 *
 * 设置页「消息推送」分区（视觉语言对齐 dsh-better-sidebar 设置页）：
 * - 版本徽章 + 分组卡片（圆角 16 容器、行式布局、hairline 分隔、计数胶囊）；
 * - 渠道卡片网格（图标芯片 + 迷你开关 + 悬停态），「配置」展开全宽编辑面板；
 * - 保存协议：GET 脱敏视图 → 编辑全文 POST（expectedRevision 防冲突；
 *   已存密钥不在视图里，宿主按渠道 id 合并，留空=保持不变）；
 * - 导航图标：DSH 0.1.x 的 settings.section 契约只投影 id/order/label，
 *   借鉴 dsh-better-sidebar 的 DOM 标记方案，用 currentColor mask 把默认齿轮
 *   换成 Lucide volume-2（喇叭）。
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
		const PLUGIN_VERSION = "0.1.4";

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

		/** 各渠道类型可编辑字段；secret 字段 write-only。 */
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
				{ key: "webhookUrl", label: "群机器人 Webhook 地址", desc: "含 ?key= 的一完整 URL" },
				{ key: "secret", label: "加签密钥（可选）", secret: true },
				{ key: "timeoutMs", label: "请求超时（毫秒）", kind: "number" },
			],
			webhook: [
				{ key: "url", label: "目标 URL" },
				{ key: "method", label: "HTTP 方法", kind: "select", options: ["POST", "PUT", "GET"] },
				{ key: "headers", label: "额外请求头", kind: "dict", desc: "每行 Key: Value" },
				{ key: "bodyTemplate", label: "正文模板", kind: "textarea", desc: "占位符 {{json}} / {{title}} / {{body}}，留空发默认 JSON" },
				{ key: "timeoutMs", label: "请求超时（毫秒）", kind: "number" },
			],
		};

		/** 渠道类型图标（Lucide 16px，currentColor 描边）。 */
		function TypeIcon(props) {
			const paths = {
				serverchan: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
				"windows-toast": ["M2 8h20", "M10 4v4", "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"],
				wecom: ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"],
				webhook: ["M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z", "M2 12h20"],
				plus: ["M5 12h14", "M12 5v14"],
			}[props.type] ?? [];
			return h(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
				paths.map((d, i) => h("path", { key: i, d })),
			);
		}

		// ---- 样式（对齐 dsh-better-sidebar 设置页的设计 token）----
		const UI_STYLE_ID = "multi-channel-notify-ui";
		const UI_CSS = `
.mcn-section { display:flex; flex-direction:column; gap:16px; width:100%; max-width:760px; }
.mcn-badge { display:inline-flex; align-items:center; gap:8px; align-self:flex-start;
  border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2);
  border-radius:999px; padding:4px 12px 4px 14px; font-size:12px; line-height:18px; }
.mcn-badge-name { color:var(--dsw-alias-label-primary); font-weight:600; }
.mcn-badge-tag { background:var(--dsw-alias-accent-soft,var(--dsw-alias-border-l2)); color:var(--dsw-alias-label-secondary);
  border-radius:999px; padding:1px 8px; font-variant-numeric:tabular-nums; }
.mcn-group { box-sizing:border-box; display:flex; flex-direction:column; gap:8px; flex:none;
  border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-3);
  border-radius:16px; padding:20px; }
.mcn-group-head { display:flex; align-items:baseline; gap:7px; padding:0 2px 6px;
  color:var(--dsw-alias-label-primary); font-size:13px; font-weight:600; line-height:20px; }
.mcn-count { background:var(--dsw-alias-accent-soft,var(--dsw-alias-bg-layer-2)); color:var(--dsw-alias-label-secondary);
  border-radius:999px; padding:1px 8px; font-size:11px; font-weight:500; line-height:16px; font-variant-numeric:tabular-nums; }
.mcn-empty { color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; padding:2px; }
.mcn-row { display:flex; justify-content:space-between; align-items:center; gap:16px;
  padding:12px 2px; border-bottom:1px solid var(--dsw-alias-border-l2); }
.mcn-row:last-child { border-bottom:none; }
.mcn-row-text { display:flex; flex-direction:column; gap:4px; min-width:0; }
.mcn-title { color:var(--dsw-alias-label-primary); font-size:14px; line-height:22px; }
.mcn-desc { color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.mcn-control { flex:none; display:flex; align-items:center; gap:6px; }
/* 开关（36x20，选中填充主题色） */
.mcn-switch { display:inline-flex; position:relative; cursor:pointer; flex:none; }
.mcn-switch-input { position:absolute; width:1px; height:1px; margin:0; opacity:0; }
.mcn-switch-track { box-sizing:border-box; display:inline-flex; align-items:center; width:36px; height:20px; padding:2px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-2);
  transition:background .15s,border-color .15s; }
.mcn-switch-thumb { display:block; width:14px; height:14px; border-radius:50%;
  background:var(--dsw-alias-label-tertiary); transition:transform .15s,background .15s; }
.mcn-switch:hover .mcn-switch-track { border-color:var(--dsw-alias-label-dimmed); }
.mcn-switch-input:checked + .mcn-switch-track { border-color:var(--dsw-alias-button-primary-fill); background:var(--dsw-alias-button-primary-fill); }
.mcn-switch-input:checked + .mcn-switch-track .mcn-switch-thumb { background:var(--dsw-alias-bg-layer-3); transform:translate(16px); }
.mcn-switch-input:focus-visible + .mcn-switch-track { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }
/* 迷你开关（渠道卡片 30x16） */
.mcn-miniswitch { display:inline-flex; position:relative; cursor:pointer; flex:none; }
.mcn-miniswitch .mcn-switch-track { width:30px; height:16px; border-radius:8px; }
.mcn-miniswitch .mcn-switch-thumb { width:10px; height:10px; }
.mcn-miniswitch .mcn-switch-input:checked + .mcn-switch-track .mcn-switch-thumb { transform:translate(14px); }
/* 渠道卡片网格 */
.mcn-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:12px; }
.mcn-card { display:flex; flex-direction:column; position:relative; overflow:hidden; min-height:96px;
  font:inherit; color:inherit; border:1px solid var(--dsw-alias-border-l2); border-radius:12px;
  background:0 0; transition:background .12s,border-color .12s; }
.mcn-card-main { display:flex; flex-direction:column; flex:1; gap:6px; width:100%; padding:12px;
  font:inherit; color:inherit; text-align:left; background:0 0; border:0; border-radius:inherit; cursor:pointer; }
.mcn-card:hover { background:var(--dsw-alias-interactive-bg-hover); }
.mcn-card-on { border-color:color-mix(in srgb,var(--dsw-alias-button-primary-fill) 45%,transparent);
  background:var(--dsw-alias-interactive-bg-active); }
.mcn-card-top { display:flex; align-items:center; gap:8px; min-height:28px; min-width:0; }
.mcn-chip { display:inline-flex; justify-content:center; align-items:center; flex:none; width:28px; height:28px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:8px;
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-tertiary); }
.mcn-card-on .mcn-chip { border-color:color-mix(in srgb,var(--dsw-alias-button-primary-fill) 35%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-button-primary-fill) 12%,transparent);
  color:var(--dsw-alias-button-primary-fill); }
.mcn-card-title { flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
  color:var(--dsw-alias-label-secondary); font-size:13px; font-weight:600; line-height:20px; }
.mcn-card-on .mcn-card-title { color:var(--dsw-alias-label-primary); }
.mcn-card-desc { overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
  color:var(--dsw-alias-label-tertiary); font-size:11px; line-height:16px; }
.mcn-card-foot { display:flex; align-items:center; gap:6px; width:100%; padding:6px 12px;
  border:0; border-top:1px solid var(--dsw-alias-border-l1); background:0 0; cursor:pointer;
  color:var(--dsw-alias-label-secondary); font:inherit; font-size:11px; font-weight:500; line-height:16px;
  text-align:left; transition:background .12s,color .12s; }
.mcn-card-foot:hover { background:var(--dsw-alias-interactive-bg-hover-accent); color:var(--dsw-alias-brand-primary); }
.mcn-add-card { border-style:dashed; align-items:flex-start; text-align:left; cursor:pointer; padding:12px;
  font:inherit; color:inherit; background:0 0; }
.mcn-add-card:hover { border-color:var(--dsw-alias-interactive-bg-hover-accent);
  background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
.mcn-add-card .mcn-chip { color:var(--dsw-alias-label-tertiary); }
.mcn-add-card:hover .mcn-chip { color:var(--dsw-alias-button-primary-fill); }
/* 渠道编辑面板（全宽） */
.mcn-editor { box-sizing:border-box; display:flex; flex-direction:column; gap:2px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:12px;
  background:var(--dsw-alias-bg-layer-2); padding:6px 14px; }
.mcn-editor-head { display:flex; align-items:center; gap:8px; padding:10px 2px 4px; }
.mcn-editor-title { color:var(--dsw-alias-label-primary); font-size:13px; font-weight:600; }
.mcn-subhead { color:var(--dsw-alias-label-secondary); font-size:12px; font-weight:600; padding:10px 2px 2px; }
.mcn-events { display:flex; flex-wrap:wrap; gap:4px 14px; padding:4px 2px 8px; }
.mcn-event-chip { display:inline-flex; align-items:center; gap:6px; font-size:11px;
  color:var(--dsw-alias-label-secondary); cursor:pointer; }
/* 输入控件 */
.mcn-input { box-sizing:border-box; appearance:none; border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary);
  border-radius:8px; padding:6px 10px; font:inherit; font-size:12px; line-height:18px; width:280px; max-width:100%; }
.mcn-input:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; }
.mcn-input::placeholder { color:var(--dsw-alias-label-tertiary); }
.mcn-textarea { width:280px; min-height:56px; resize:vertical; font-family:var(--ds-font-family-code,monospace); }
select.mcn-input { width:auto; min-width:120px; cursor:pointer; }
/* 按钮 */
.mcn-btn { appearance:none; font:inherit; font-size:12px; line-height:1.5; cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2); background:0 0; color:var(--dsw-alias-label-primary);
  border-radius:8px; padding:5px 14px; transition:background .12s,border-color .12s; }
.mcn-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); border-color:var(--dsw-alias-label-dimmed); }
.mcn-btn:disabled { opacity:.4; cursor:default; }
.mcn-btn-primary { background:var(--dsw-alias-label-primary); color:var(--dsw-alias-bg-layer-3);
  border:1px solid transparent; font-weight:600; }
.mcn-btn-primary:hover:not(:disabled) { background:var(--dsw-alias-label-primary); opacity:.88; border-color:transparent; }
.mcn-btn-danger { color:var(--dsw-alias-state-error-primary); }
.mcn-btn-danger:hover:not(:disabled) { border-color:var(--dsw-alias-state-error-primary); background:0 0; }
/* 结果提示 */
.mcn-note { font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary);
  white-space:pre-wrap; word-break:break-all; }
.mcn-savebar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:2px; }
@media (prefers-reduced-motion:reduce) {
  .mcn-card,.mcn-card-foot,.mcn-switch-track,.mcn-switch-thumb,.mcn-btn { transition:none; }
}`;

		// ---- 基础组件 ----

		/** 开关（36x20）。props: checked, onChange */
		function Switch(props) {
			return h(
				"label",
				{ className: "mcn-switch" },
				h("input", {
					className: "mcn-switch-input",
					type: "checkbox",
					checked: props.checked === true,
					onChange: (e) => props.onChange(e.target.checked === true),
				}),
				h("span", { className: "mcn-switch-track" }, h("span", { className: "mcn-switch-thumb" })),
			);
		}

		/** 迷你开关（渠道卡片用）。 */
		function MiniSwitch(props) {
			return h(
				"label",
				{ className: "mcn-miniswitch", onClick: (e) => e.stopPropagation() },
				h("input", {
					className: "mcn-switch-input",
					type: "checkbox",
					checked: props.checked === true,
					onChange: (e) => props.onChange(e.target.checked === true),
				}),
				h("span", { className: "mcn-switch-track" }, h("span", { className: "mcn-switch-thumb" })),
			);
		}

		/** 分组卡片。props: title, count?, children */
		function Group(props) {
			return h(
				"div",
				{ className: "mcn-group" },
				h(
					"div",
					{ className: "mcn-group-head" },
					props.title,
					props.count === undefined ? null : h("span", { className: "mcn-count" }, String(props.count)),
				),
				...react.Children.toArray(props.children),
			);
		}

		/** 行：左侧标题+描述，右侧控件。props: title, desc?, children */
		function Row(props) {
			return h(
				"div",
				{ className: "mcn-row" },
				h(
					"div",
					{ className: "mcn-row-text" },
					h("span", { className: "mcn-title" }, props.title),
					props.desc ? h("span", { className: "mcn-desc" }, props.desc) : null,
				),
				h("div", { className: "mcn-control" }, ...react.Children.toArray(props.children)),
			);
		}

		function TextField(props) {
			const common = {
				className: "mcn-input",
				placeholder: props.placeholder,
				value: props.value ?? "",
				onChange: (e) => props.onChange(e.target.value),
			};
			if (props.kind === "number")
				return h("input", { ...common, type: "number", value: props.value ?? "", onChange: (e) => props.onChange(e.target.value === "" ? undefined : Number(e.target.value)) });
			if (props.kind === "textarea") return h("textarea", { ...common, className: "mcn-input mcn-textarea", rows: 3 });
			if (props.kind === "password") return h("input", { ...common, type: "password", autoComplete: "off" });
			return h("input", { ...common });
		}

		function SelectField(props) {
			return h(
				"select",
				{ className: "mcn-input", value: String(props.value ?? props.options[0]), onChange: (e) => props.onChange(e.target.value) },
				props.options.map((opt) => h("option", { key: opt, value: opt }, opt)),
			);
		}

		/**
		 * 密钥输入框（write-only）：
		 * - 不回填已存值（视图里本来就没有），但输入必须走本地 state——
		 *   若受控 value 恒为空串，每次键入都会被重渲染拉回空（曾因此无法输入）；
		 * - 输入内容实时同步进父 draft；清空=回退「保持已存值」（下发 undefined）；
		 * - 保存成功后 revision 变化 → 自动清空输入框。
		 */
		function SecretField(props) {
			const [val, setVal] = react.useState("");
			react.useEffect(() => {
				setVal("");
			}, [props.revision]);
			return h("input", {
				className: "mcn-input",
				type: "password",
				autoComplete: "new-password",
				placeholder: props.savedHint ? "••••••••" : props.placeholder,
				value: val,
				onChange: (e) => {
					const v = e.target.value;
					setVal(v);
					props.onChange(v === "" ? undefined : v);
				},
			});
		}

		/**
		 * 字典编辑器：每行「Key: Value」（首个冒号分隔），空行忽略。
		 * 编辑态以本地原始文本为准（受控回弹修复）：全部行合法时即时提交；
		 * 存在非法行只暂存不提交，失焦时兜底解析。
		 */
		function DictField(props) {
			const serialize = (v) =>
				Object.entries(v ?? {})
					.map(([k, v2]) => `${k}: ${v2}`)
					.join("\n");
			const parse = (text) => {
				const next = {};
				for (const line of String(text).split("\n")) {
					const trimmed = line.trim();
					if (trimmed === "") continue;
					const sep = trimmed.indexOf(":");
					if (sep <= 0) return null;
					next[trimmed.slice(0, sep).trim()] = trimmed.slice(sep + 1).trim();
				}
				return next;
			};
			const [raw, setRaw] = react.useState(serialize(props.value));
			const committedRef = react.useRef(serialize(props.value));
			react.useEffect(() => {
				const serialized = serialize(props.value);
				if (serialized !== committedRef.current) {
					committedRef.current = serialized;
					setRaw(serialized);
				}
			}, [props.value]);
			const commit = (text, allowPartial) => {
				const parsed = parse(text);
				if (parsed === null && !allowPartial) return;
				const valueOut = parsed !== null && Object.keys(parsed).length > 0 ? parsed : undefined;
				committedRef.current = serialize(valueOut);
				props.onChange(valueOut);
			};
			return h("textarea", {
				className: "mcn-input mcn-textarea",
				rows: 2,
				placeholder: props.placeholder ?? "X-Token: abc\nX-Env: prod",
				value: raw,
				onChange: (e) => {
					setRaw(e.target.value);
					commit(e.target.value, false);
				},
				onBlur: () => commit(raw, true),
			});
		}

		// ---- 渠道 ----
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

		/** 渠道卡片（网格内）：图标芯片 + 名称 + 迷你开关 + 配置入口。 */
		function ChannelCard(props) {
			const { channel, editing, onToggle, onEdit } = props;
			// 主区用 div 而非 button：内部要嵌开关的 label/input（button 内嵌交互元素非法）
			return h(
				"div",
				{ className: `mcn-card${channel.enabled ? " mcn-card-on" : ""}` },
				h(
					"div",
					{
						className: "mcn-card-main",
						role: "button",
						tabIndex: 0,
						onClick: onEdit,
						onKeyDown: (e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onEdit();
							}
						},
						title: "编辑该渠道",
					},
					h(
						"div",
						{ className: "mcn-card-top" },
						h("span", { className: "mcn-chip" }, h(TypeIcon, { type: channel.type })),
						h("span", { className: "mcn-card-title" }, TYPE_LABELS[channel.type] ?? channel.type),
						h(MiniSwitch, {
							checked: channel.enabled,
							onChange: (v) => onToggle(v),
						}),
					),
					h("span", { className: "mcn-card-desc" }, channel.id),
				),
				h(
					"button",
					{ className: "mcn-card-foot", onClick: onEdit },
					editing ? "收起配置 ▲" : "配置 ▼",
				),
			);
		}

		/** 渠道编辑面板（全宽）：字段行 + 订阅事件 + 测试/删除。 */
		function ChannelEditor(props) {
			const { channel, view, onChange, onRemove } = props;
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
				{ className: "mcn-editor" },
				h(
					"div",
					{ className: "mcn-editor-head" },
					h("span", { className: "mcn-chip" }, h(TypeIcon, { type: channel.type })),
					h("span", { className: "mcn-editor-title" }, `${TYPE_LABELS[channel.type] ?? channel.type} · ${channel.id}`),
					h("span", { className: "mcn-desc" }, channel.enabled ? "已启用" : "未启用"),
				),
				...fields.map((field) => {
					const bucketName = field.bucket ?? channel.type;
					const bucket = channel[bucketName] ?? {};
					const isSecret = field.secret === true;
					const savedHint = isSecret && secretIsSet(view, channel.id, channel.type, field.key);
					const control = isSecret
						? h(SecretField, {
								savedHint,
								placeholder: field.placeholder,
								revision: view.revision,
								onChange: (v) => onChange({ ...channel, [bucketName]: { ...bucket, [field.key]: v } }),
							})
						: field.kind === "select" ? h(SelectField, {
								options: field.options,
								value: bucket[field.key],
								onChange: (v) => onChange({ ...channel, [bucketName]: { ...bucket, [field.key]: v } }),
							})
						: field.kind === "dict" ? h(DictField, {
								value: bucket[field.key],
								onChange: (v) => onChange({ ...channel, [bucketName]: { ...bucket, [field.key]: v } }),
							})
						: h(TextField, {
								kind: field.kind,
								placeholder: field.placeholder,
								value: bucket[field.key],
								onChange: (v) => onChange({ ...channel, [bucketName]: { ...bucket, [field.key]: v } }),
							});
					return h(
						Row,
						{ key: field.key, title: field.label, desc: savedHint ? "已保存（留空保持不变）" : field.desc },
						control,
					);
				}),
				// 该渠道自己的事件订阅（覆盖全局开关）
				h("div", { className: "mcn-subhead" }, "订阅事件（关闭=不推送该渠道；默认全开）"),
				h(
					"div",
					{ className: "mcn-events" },
					EVENT_KINDS.map((kind) =>
						h(
							"label",
							{ key: kind, className: "mcn-event-chip" },
							h(MiniSwitch, {
								checked: channel.events?.[kind] !== false,
								onChange: (v) => onChange({ ...channel, events: { ...channel.events, [kind]: v } }),
							}),
							EVENT_LABELS[kind][0],
						),
					),
				),
				note === "" ? null : h("div", { className: "mcn-note", style: { padding: "2px 2px 6px" } }, note),
				h(
					"div",
					{ className: "mcn-savebar", style: { paddingBottom: 10 } },
					h(
						"button",
						{
							className: "mcn-btn",
							onClick: test,
							disabled: busy || channel.enabled !== true,
							title: channel.enabled !== true ? "启用并保存后才能测试" : undefined,
						},
						busy ? "发送中…" : "发送测试",
					),
					h("button", { className: "mcn-btn mcn-btn-danger", onClick: () => onRemove(channel.id) }, "删除渠道"),
				),
			);
		}

		// ---- 主分区 ----
		function NotifySection() {
			const [view, setView] = react.useState(null);
			const [draft, setDraft] = react.useState(null);
			const [saveNote, setSaveNote] = react.useState("");
			const [saving, setSaving] = react.useState(false);
			const [editingId, setEditingId] = react.useState(null);

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

			if (view === null)
				return h("div", { className: "mcn-section" }, h("span", { className: "mcn-empty" }, "加载中…"));
			if (view.status !== "ready" || draft === null) {
				return h(
					"div",
					{ className: "mcn-section" },
					h("span", { className: "mcn-empty" }, "配置命名空间不可用（host 端插件未就绪）。"),
					h("button", { className: "mcn-btn", onClick: load }, "重试"),
				);
			}

			const patch = (mutate) => setDraft((current) => ({ ...current, ...mutate(current) }));
			const channels = Array.isArray(draft.channels) ? draft.channels : [];
			const editingChannel = channels.find((c) => c.id === editingId) ?? null;

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
				{ className: "mcn-section" },
				// 版本徽章
				h(
					"div",
					{ className: "mcn-badge" },
					h("span", { className: "mcn-badge-name" }, SECTION_LABEL),
					h("span", { className: "mcn-badge-tag" }, `multi-channel-notify v${PLUGIN_VERSION}`),
				),
				// 推送渠道
				h(
					Group,
					{ title: "推送渠道", count: channels.length },
					channels.length === 0 ? h("span", { className: "mcn-empty" }, "还没有渠道，点下方虚线卡片添加一个。") : null,
					h(
						"div",
						{ className: "mcn-grid" },
						...channels.map((channel) =>
							h(ChannelCard, {
								key: channel.id,
								channel,
								editing: channel.id === editingId,
								onToggle: (v) => patch((cur) => ({ channels: cur.channels.map((c) => (c.id === channel.id ? { ...c, enabled: v } : c)) })),
								onEdit: () => setEditingId((cur) => (cur === channel.id ? null : channel.id)),
							}),
						),
						...Object.keys(TYPE_LABELS).map((type) =>
							h(
								"button",
								{
									key: `add-${type}`,
									className: "mcn-card mcn-add-card",
									onClick: () => {
										const channel = newChannel(type);
										patch((cur) => ({ channels: [...(cur.channels ?? []), channel] }));
										setEditingId(channel.id);
									},
								},
								h(
									"div",
									{ className: "mcn-card-top" },
									h("span", { className: "mcn-chip" }, h(TypeIcon, { type: "plus" })),
									h("span", { className: "mcn-card-title" }, TYPE_LABELS[type]),
								),
								h("span", { className: "mcn-card-desc" }, "点击添加"),
							),
						),
					),
					editingChannel !== null
						? h(ChannelEditor, {
								key: editingChannel.id,
								channel: editingChannel,
								view,
								onChange: (next) => patch((cur) => ({ channels: cur.channels.map((c) => (c.id === editingChannel.id ? next : c)) })),
								onRemove: (id) => {
									patch((cur) => ({ channels: cur.channels.filter((c) => c.id !== id) }));
									setEditingId(null);
								},
							})
						: null,
				),
				// 全局事件开关
				h(
					Group,
					{ title: "订阅事件", count: EVENT_KINDS.length },
					h("span", { className: "mcn-empty" }, "全局总闸；渠道内可按渠道覆盖。"),
					...EVENT_KINDS.map((kind) =>
						h(
							Row,
							{ key: kind, title: EVENT_LABELS[kind][0], desc: EVENT_LABELS[kind][1] },
							h(Switch, {
								checked: draft.events?.[kind],
								onChange: (v) => patch((cur) => ({ events: { ...cur.events, [kind]: v } })),
							}),
						),
					),
				),
				// 消息外观
				h(
					Group,
					{ title: "消息外观" },
					h(
						Row,
						{ title: "标题前缀", desc: "推送标题最前面的固定文字，可为空" },
						h(TextField, { value: draft.message?.titlePrefix ?? "", onChange: (v) => patch((cur) => ({ message: { ...cur.message, titlePrefix: v } })) }),
					),
					h(
						Row,
						{ title: "DSH 地址", desc: "通知卡片里的跳转链接" },
						h(TextField, { value: draft.message?.guiUrl ?? "", onChange: (v) => patch((cur) => ({ message: { ...cur.message, guiUrl: v } })) }),
					),
				),
				// 去重与限流
				h(
					Group,
					{ title: "去重与限流" },
					...[
						["cooldownMs", "同会话同事件冷却", "同一事件在冷却窗口内只推一次（毫秒）"],
						["completedDebounceMs", "回合完成防抖", "连续完成事件合并推送的等待窗口（毫秒）"],
						["perChannelPerMinute", "每渠道每分钟上限", "超出限额的推送直接丢弃"],
					].map(([key, title, desc]) =>
						h(
							Row,
							{ key, title, desc },
							h(TextField, {
								kind: "number",
								value: draft.dedup?.[key],
								onChange: (v) => patch((cur) => ({ dedup: { ...cur.dedup, [key]: v } })),
							}),
						),
					),
				),
				// 保存栏
				h(
					"div",
					{ className: "mcn-savebar" },
					h("button", { className: "mcn-btn mcn-btn-primary", onClick: save, disabled: saving }, saving ? "保存中…" : "保存配置"),
					h("button", { className: "mcn-btn", onClick: load, disabled: saving }, "重新加载"),
					saveNote === "" ? null : h("span", { className: "mcn-note" }, saveNote),
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
		 * 局限：按当前界面语言的分区文本精确匹配（与 better-sidebar 同款方案）。
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

		/** 注入 UI 样式（fiber 卸载时移除）。 */
		function registerUiStyle() {
			if (document.getElementById(UI_STYLE_ID) !== null) return () => {};
			const style = document.createElement("style");
			style.id = UI_STYLE_ID;
			style.textContent = UI_CSS;
			document.head.appendChild(style);
			return () => style.remove();
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
			ctx.effect(() => registerUiStyle(), "settings ui stylesheet");
			// 导航图标替换（fiber 卸载时自动还原齿轮）
			ctx.effect(() => registerSettingsNavIcon(SECTION_LABEL), "settings nav speaker icon");
		}

		exports.name = "multi-channel-notify";
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
