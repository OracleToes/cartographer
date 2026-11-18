// Migrated Runtime renderers.
//
// Each renderer receives an already-settled application projection and a small presentation vocabulary assembled by
// screen composition. It owns no Runtime/domain import and starts no live read while it makes list rows.
import { width } from "./text.mjs";

/** A passive line in a Runtime collection. */
const note = (text, style = "muted") => ({ key: `note:${text}`, plain: true, head: [[text, style]] });

/** Render the deferred Runtime shell-list projection; this renderer never touches a live window manager. */
export function shellsView({ windows: all = [], presentation } = {}) {
	if (presentation === undefined || typeof presentation.shell !== "function") throw new TypeError("Shell windows need their Runtime presentation adapter.");
	if (all.length === 0) return { header: [], items: [note("  No shell window is open. A change task opens one when it runs a command.")] };
	const items = all.map((window) => {
		const described = presentation.shell(window);
		const body = [described.truncated ? described.wholeCommand : undefined, ...window.tail].filter((line) => line !== undefined).join("\n");
		return {
			key: `window:${window.name}`,
			head: [[`${window.name}  `, "bold"], ...described.state, [described.location, "muted"]],
			...(body !== "" ? { body, bodyStyle: (line) => (line.startsWith("$ ") ? "bold" : "") } : {}),
			copy: () => [described.wholeCommand, ...window.tail].filter((line) => line !== undefined).join("\n"),
		};
	});
	return { header: [[[`${all.length === 1 ? "1 shell window" : `${all.length} shell windows`}`, "bold"], ["  · opened, a window shows its newest lines, live · /kill NAME ends one", "muted"]]], items };
}

/** The selected deferred shell-output projection, as a terminal emulator sees its newest lines. */
export function shellsOutView({ window, lines = [], presentation } = {}) {
	if (presentation === undefined || typeof presentation.shellOutput !== "function") throw new TypeError("Shell output needs its Runtime presentation adapter.");
	if (window === undefined) return { header: [], items: [note("  No shell window is open. A change task opens one when it runs a command.")] };
	const described = presentation.shellOutput(window);
	const header = [
		[["Output of ", "bold"], [window.name, "bold"], ["  ·  ", "muted"], ...described.state, [described.location, "muted"]],
		[["The newest lines, as the window keeps them; the view follows on its own.", "faint"]],
		[["/send " + window.name + " line types into it from the prompt.", "faint"]],
	];
	const items = [
		{ key: "term", plain: true, head: lines.length === 0 ? [["  (nothing has been printed yet)", "muted"]] : lines.map((line) => [line || " ", ""]) },
	];
	return { header, items };
}

/** The Runtime wake schedule receives a settled snapshot and never reads its live scheduler. */
export function wakesView({ wakes = [], lines = [], presentation } = {}) {
	if (presentation === undefined || typeof presentation.describe !== "function") throw new TypeError("Wake schedules need their Runtime presentation adapter.");
	if (wakes.length === 0) {
		return {
			header: [[["Wake schedule", "bold"]], [["Wakes belong to the main agent and remain scheduled until they fire their last time or are removed.", "muted"]]],
			items: [note("  The agent has set no wake.")],
		};
	}
	const items = wakes.map((wake, index) => {
		const described = presentation.describe(wake, Array.isArray(lines) ? lines[index] : undefined);
		return {
			key: `wake:${wake.id}`,
			head: [[`${wake.id}  `, "bold"], [described.about, ""], [`  · ${described.kindLabel}`, "muted"]],
			body: described.line,
			copy: described.line,
		};
	});
	return {
		header: [
			[[`${wakes.length === 1 ? "1 wake" : `${wakes.length} wakes`} scheduled`, "bold"], ["  · remove one with d; /wakes remove ID remains available in the prompt", "muted"]],
			[["A wake starts no provider request while this view is read. Its lifecycle is refreshed through the Runtime projection.", "faint"]],
		],
		items,
	};
}

/** Model-route discovery and grammar-readiness are settled Runtime facts; selecting a row crosses the typed action boundary in screen composition. */
export function modelRoutesView({ routes, presentation } = {}) {
	if (presentation === undefined || typeof presentation.describe !== "function") throw new TypeError("Model routes need their Runtime presentation adapter.");
	const described = presentation.describe(routes);
	const header = [
		[["Model routes", "bold"], [described.currentId === undefined ? "" : `  · active ${described.currentId}`, ""]],
		[[described.state.text, described.state.style]],
		...(described.limits === undefined ? [] : [[[described.limits, "muted"]]]),
		[["A listed route is not ready until Cartographer has checked native GBNF enforcement. Enter validates the active row, or selects and validates another listed route.", "faint"]],
	];
	if (described.rows.length === 0) {
		return {
			header,
			items: [note("  No model routes are known yet. Refresh after the model server is available.")],
		};
	}
	const items = described.rows.map((route) => ({
		key: `model:${route.id}`,
		head: [[route.id, route.active ? "bold" : ""], [route.active ? "  · active" : "", route.active ? "ok" : "muted"], [route.active && described.ready ? "  · native GBNF ready" : "", route.active && described.ready ? "ok" : "muted"]],
		body: `${route.capacity}${route.active ? described.ready ? "\nThis route is ready for agent work." : "\nEnter validates this active route before agent work can start." : "\nEnter selects and validates this route."}`,
		copy: `${route.id}\n${route.capacity}`,
		// This is only the target from the settled route projection. Screen still invokes the typed model action;
		// it never reaches a provider/model manager from a key handler.
		target: { modelId: route.id, ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }), active: route.active, ready: described.ready },
	}));
	return { header, items };
}

/** The Model tab's frozen-provider-request view. It receives a settled request snapshot and no engine. */
export function contextView({ sent, windowSize, cols, writing, isOpen, presentation } = {}) {
	if (presentation === undefined || typeof presentation.describe !== "function" || typeof presentation.styleOf !== "function" || typeof presentation.contextBar !== "function" || typeof presentation.short !== "function" || typeof presentation.estimate !== "function" || typeof presentation.pretty !== "function" || typeof presentation.firstWords !== "function" || !Array.isArray(presentation.categories)) throw new TypeError("Sent provider requests need their Runtime presentation adapter.");
	const described = presentation.describe(sent, writing);
	if (described === undefined) return { header: [], items: [note("  Nothing has been sent to a provider in this run of carto yet. Send a message, then its frozen provider payload appears here.")] };
	const { parts, since, tools, used, who, request, provider, at, age, reported, payloadHash, collapsedSince } = described;
	const header = [
		[
			["Sent provider request", "bold"],
			[`  ·  ${who} · ${request}`, ""],
			[provider === "" ? "" : `  ·  ${provider}`, "muted"],
		],
		[[`sent ${at} (${age}) · frozen for this run${payloadHash === undefined ? "" : ` · payload ${payloadHash}`}`, "muted"]],
		[[`about ${presentation.short(used)} of ${presentation.short(windowSize)} input tokens (${Math.round((used / windowSize) * 100)}%) — estimated${reported === "" ? "" : ` · provider reported ${reported}`}`, ""]],
		presentation.contextBar(parts, windowSize, cols),
	];
	const totals = new Map();
	for (const part of parts) totals.set(part.cat, (totals.get(part.cat) ?? 0) + part.tokens);
	const entries = [...presentation.categories.filter((category) => totals.has(category.id)).map((category) => ({ mark: "■", style: category.style, name: category.name, tokens: totals.get(category.id) })), { mark: "□", style: "faint", name: "Free", tokens: Math.max(0, windowSize - used) }];
	const nameWidth = Math.max(...entries.map((entry) => width(entry.name)));
	const cellWidth = nameWidth + 20;
	const perRow = Math.max(1, Math.floor(cols / cellWidth));
	for (let index = 0; index < entries.length; index += perRow) {
		const row = [];
		for (const entry of entries.slice(index, index + perRow)) {
			const percent = (entry.tokens / windowSize) * 100;
			row.push([`${entry.mark} `, entry.style], [entry.name, ""], [` ${".".repeat(nameWidth - width(entry.name) + 2)} `, "muted"], [presentation.short(entry.tokens).padStart(5), ""], [`${(percent > 0 && percent < 0.1 ? "<0.1" : percent < 10 ? percent.toFixed(1) : String(Math.round(percent))).padStart(5)}%   `, "muted"]);
		}
		header.push(row);
	}
	if (collapsedSince) header.push([["! A collapse happened after this request was sent. This snapshot stays as sent; a later request starts from the new kept block.", "warn"]]);
	header.push([], [["Frozen payload parts, in provider reading order. Raw provider JSON is a separate audit view, not another context part.", "faint"]]);

	const items = [];
	const one = (part, extra = {}) => {
		const text = part.text;
		return {
			key: part.key,
			head: [["■ ", presentation.styleOf(part.cat)], [presentation.short(part.tokens).padStart(5), "muted"], [`  ${part.title}`, ""], [`  ${part.preview ?? presentation.firstWords(text)}`, "faint"]],
			body: text === "" ? "(empty)" : text,
			copy: text,
			...extra,
		};
	};
	for (const part of parts) {
		items.push(one(part, part.key === "tools" ? { folder: true } : {}));
		if (part.key === "tools" && isOpen?.("tools")) {
			for (const tool of tools) {
				const name = tool.function?.name ?? "?";
				const text = `${tool.function?.description ?? ""}\n\nparameters: ${presentation.pretty(tool.function?.parameters ?? {})}`;
				items.push({
					key: `tool:${name}`,
					depth: 1,
					head: [["· ", "muted"], [presentation.short(presentation.estimate(JSON.stringify(tool))).padStart(5), "muted"], [`  ${name}`, ""], [`  ${presentation.firstWords(tool.function?.description ?? "")}`, "faint"]],
					body: text,
					copy: text,
				});
			}
		}
	}
	if (!parts.some((part) => part.cat === "state")) {
		items.push({
			key: "state:missing",
			plain: true,
			head: [["! ", "warn"], ["  No state block in this sent request — this provider payload did not carry one.", "warn"]],
			copy: "",
		});
	}
	if (since.length > 0) {
		items.push({ key: "since", plain: true, head: [[`── since ${request}: response material, not sent ──`, "muted"]] });
		for (const part of since) items.push(one(part));
	}
	return { header, items, parts, since };
}

/** The exact serialized provider body captured at dispatch, deliberately separate from its semantic request view. */
export function rawPayloadView({ sent, presentation } = {}) {
	if (presentation === undefined || typeof presentation.raw !== "function" || typeof presentation.short !== "function") throw new TypeError("Raw provider payload needs its Runtime presentation adapter.");
	const title = "Raw provider payload · audit copy";
	const described = presentation.raw(sent);
	if (described === undefined) {
		return {
			header: [[[title, "bold"]], [["No provider request has been sent in this run, so there is no frozen raw JSON to inspect.", "muted"]]],
			items: [note("  Nothing has been sent to a provider in this run of carto yet.")],
		};
	}
	const header = [
		[[title, "bold"], [`  ·  ${described.who} · ${described.request}`, ""]],
		[[`Frozen at dispatch${described.payloadHash === undefined ? "" : ` · payload ${described.payloadHash}`}. It serializes the same sent request shown in Latest sent or Main sent.`, "muted"]],
		[["This is an audit copy, not another model-context part; it is not included in either sent view's input-token bar.", "faint"]],
	];
	if (typeof described.payloadJson !== "string") return { header, items: [note("  This sent request has no retained raw provider JSON.", "warn")] };
	return {
		header,
		items: [{
			key: "payload",
			head: [["■ ", "catSystem"], ["  Provider payload JSON", ""], [`  ${presentation.short(described.payloadJson.length)} chars · audit only`, "faint"]],
			body: described.payloadJson,
			copy: described.payloadJson,
		}],
	};
}

/** The explicitly prospective main-agent plan. It has no provider JSON because nothing has been sent. */
export function previewView({ preview, presentation } = {}) {
	if (presentation === undefined || typeof presentation.describe !== "function") throw new TypeError("Next request preview needs its Runtime presentation adapter.");
	const described = presentation.describe(preview);
	if (described.state === "calculating") return { header: [[["Next request preview · not sent", "bold"]]], items: [note("  Calculating the current main-agent plan without consuming wakes…")] };
	if (described.state === "error") return { header: [[["Next request preview · not sent", "bold"]]], items: [note(`  ! ${described.error}`, "warn")] };
	if (described.state === "empty") return { header: [[["Next request preview · not sent", "bold"]]], items: [note("  No main-agent request can be planned now.")] };
	const header = [
		[["Next request preview · not sent", "bold"], [`  ·  main agent · rebuilt ${described.at}`, ""]],
		[["Pure current calculation: wakes were not checked or consumed, and no provider request was made or retained.", "muted"]],
		[["State, windows, the read batch, a collapse, or a new message can change this before any send. Provider JSON does not exist for a preview.", "faint"]],
	];
	const items = described.parts.map((part) => ({
		key: `preview:${part.id}`,
		head: [["◇ ", "catState"], [`${part.title}  `, ""], [`${part.source} · preview only`, "faint"]],
		body: part.text === "" ? "(empty)" : part.text,
		copy: part.text,
	}));
	if (items.length === 0) items.push(note("  The current plan has no displayable parts."));
	return { header, items };
}

/** A view of plain lines, for text that a Runtime projection has already described. */
export function textView(text) {
	return { header: [], items: String(text ?? "").replace(/\n+$/, "").split("\n").map((line, index) => ({ key: `line:${index}`, plain: true, head: [[line, /^\s*!/.test(line) ? "warn" : ""]] })) };
}

/** Current active-context accounting, deliberately not a historical request inspector or a preview. */
export function accountingView(text) {
	const view = textView(text);
	return {
		...view,
		header: [
			[["Current active-context accounting", "bold"]],
			[["Calculated now from the active conversation and brain. It is neither a sent provider payload nor a promise of the next request.", "muted"]],
		],
	};
}

/** Render the typed Runtime accounting projection without capturing or parsing the terminal's `/context` words. */
export function accountingProjectionView({ accounting, config = {}, presentation } = {}) {
	if (presentation === undefined || typeof presentation.rows !== "function") throw new TypeError("Current active-context accounting needs its Runtime presentation adapter.");
	return accountingView(presentation.rows(accounting, config).join("\n"));
}
