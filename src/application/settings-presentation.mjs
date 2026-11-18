// Presentation-safe vocabulary for Settings & Safety.
//
// The screen receives only these descriptive facts and settled projections. In particular, provider route listing,
// native-grammar proof, and session policy state remain separate so a reachable `/models` endpoint never reads as a
// permission to start agent work.
import { stamp } from "../time.mjs";

const text = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const whole = (value) => Number.isInteger(value) && value > 0 ? value : undefined;
const count = (value) => {
	if (!Number.isFinite(value)) return "?";
	if (value < 1_000) return String(Math.round(value));
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${Math.round(value / 1_000)}k`;
};
const minutes = (value) => value === 0 ? "off" : `${value} minute${value === 1 ? "" : "s"}`;
const setting = (id, label, value, detail) => ({ id, label, value, ...(detail === undefined ? {} : { detail }) });
const routeLimit = (limits) => {
	const usable = whole(limits?.usableContextWindow);
	if (usable === undefined) return undefined;
	const server = whole(limits?.serverContextWindow);
	const configured = whole(limits?.configuredContextWindow);
	return `active context ${count(usable)} tokens${server === undefined ? "" : ` · server capacity ${count(server)}`}${configured === undefined ? "" : ` · settings cap ${count(configured)}`}`;
};

const providerDescription = (provider = {}, configuration = {}) => {
	const routes = provider.routes;
	const currentId = text(routes?.currentId);
	const listed = Array.isArray(routes?.models) ? routes.models.filter((route) => text(route?.id) !== undefined) : [];
	const listingIssue = text(routes?.issue?.message) ?? text(provider.routeIssue);
	const diagnostic = text(routes?.diagnostic?.message);
	const diagnosticKind = text(routes?.diagnostic?.kind);
	const ready = routes?.ready === true;
	const diagnostics = [];
	if (listingIssue !== undefined) diagnostics.push({
		id: "provider-listing",
		label: "Route listing",
		state: "unavailable",
		style: "warn",
		text: `The model-route listing could not be refreshed: ${listingIssue}`,
	});
	if (routes === undefined) {
		diagnostics.push({
			id: "native-grammar",
			label: "Native grammar",
			state: "unavailable",
			style: "warn",
			text: "This session did not provide model-route status. Agent work cannot be treated as ready from Settings.",
		});
	} else if (ready) {
		diagnostics.push({
			id: "native-grammar",
			label: "Native grammar",
			state: "ready",
			style: "ok",
			text: `${currentId ?? "The active route"} passed native llama.cpp GBNF validation. Agent work may use this proven route.`,
		});
	} else if (diagnostic !== undefined) {
		const state = diagnosticKind === "transport" ? "disconnected" : "blocked";
		diagnostics.push({
			id: "native-grammar",
			label: "Native grammar",
			state,
			style: "warn",
			text: `${state === "disconnected" ? "The route is disconnected" : "Native llama.cpp GBNF validation is blocked"}: ${diagnostic}. Cartographer does not fall back to ordinary tool calls or prompt-only decisions.`,
		});
	} else {
		diagnostics.push({
			id: "native-grammar",
			label: "Native grammar",
			state: "disconnected",
			style: "warn",
			text: `${currentId ?? "The configured route"} has not passed native llama.cpp GBNF validation in this session. Agent work stays blocked until a positive proof succeeds.`,
		});
	}
	return {
		server: text(configuration.provider?.server),
		configuredModel: text(configuration.provider?.configuredModel),
		currentId,
		listed,
		...(routeLimit(routes?.limits) === undefined ? {} : { limits: routeLimit(routes.limits) }),
		diagnostics,
	};
};

const policyDescription = (policy = {}) => {
	const approval = policy.approval ?? {};
	const initiation = policy.initiation ?? {};
	const sandbox = policy.sandbox ?? {};
	const sandboxMode = text(sandbox.mode);
	return [
		{
			id: "approval",
			label: "Approval",
			state: approval.yolo === true ? "YOLO · approval off" : "approval on",
			style: approval.yolo === true ? "warn" : "ok",
			detail: approval.yolo === true
				? "Declared change moves may run without /approve while this session stays in YOLO mode. Targets, budgets, checkpoints, reports, and native policy still apply."
				: "Declared change moves wait for /approve. This is the session default-safe policy.",
			default: approval.defaultYolo === true ? "setting default: YOLO" : "setting default: approval on",
		},
		{
			id: "initiation",
			label: "Initiation",
			state: initiation.on === false ? "the agent waits" : "the agent may start itself",
			style: initiation.on === false ? "warn" : "ok",
			detail: initiation.on === false
				? "The agent waits for a message; it starts no work on its own."
				: "The agent may start on launch or after an eligible wake when nothing is owed.",
			default: initiation.defaultOn === false ? "setting default: wait" : "setting default: initiate",
		},
		{
			id: "sandbox",
			label: "Bubblewrap sandbox",
			state: sandboxMode === "sandbox" ? "sandboxed" : sandboxMode === "direct" ? "OFF · commands run directly" : "no usable sandbox",
			style: sandboxMode === "sandbox" ? "ok" : "warn",
			detail: sandboxMode === "sandbox"
				? `Change commands use disposable staged copies${text(sandbox.version) === undefined ? "" : ` · bubblewrap ${sandbox.version}`}. Network access remains limited by each declared move.`
				: sandboxMode === "direct"
					? "Change commands run on this machine as you. They can reach whatever you can, including the network; /undo covers the project folder only."
					: `${text(sandbox.unavailableReason) ?? "Bubblewrap availability was not reported"}. Tasks cannot run commands unless the session is explicitly switched to direct execution.`,
			default: sandbox.defaultOn === false ? "setting default: direct" : "setting default: sandbox",
		},
	];
};

/** Pure Settings & Safety presentation from a settled application snapshot. */
const settings = (snapshot = {}) => {
	const configuration = snapshot.configuration ?? {};
	const provider = providerDescription(snapshot.provider, configuration);
	const configRows = [
		setting("provider-server", "Provider endpoint", provider.server ?? "not configured"),
		setting("provider-model", "Configured model", provider.configuredModel ?? "not configured", provider.currentId === undefined ? undefined : `active route: ${provider.currentId}`),
		...(whole(configuration.provider?.contextWindow) === undefined ? [] : [setting("context-window", "Context window", `${count(configuration.provider.contextWindow)} tokens`)]),
		...(whole(configuration.provider?.maxTokens) === undefined ? [] : [setting("max-tokens", "Reply ceiling", `${count(configuration.provider.maxTokens)} tokens`)]),
		...(whole(configuration.agent?.mainTurns) === undefined ? [] : [setting("main-turns", "Main-agent turn ceiling", String(configuration.agent.mainTurns))]),
		...(whole(configuration.agent?.taskTurns) === undefined ? [] : [setting("task-turns", "Task turn ceiling", String(configuration.agent.taskTurns))]),
		...(whole(configuration.agent?.shellWait) === undefined ? [] : [setting("shell-wait", "Shell quiet wait", `${configuration.agent.shellWait} seconds`)]),
		...(whole(configuration.agent?.windowTail) === undefined ? [] : [setting("window-tail", "Shell output in state", `${configuration.agent.windowTail} lines`)]),
		...(whole(configuration.agent?.wakeMin) === undefined ? [] : [setting("wake-min", "Minimum wake interval", `${configuration.agent.wakeMin} seconds`)]),
		...(whole(configuration.context?.chatWindow) === undefined ? [] : [setting("chat-window", "Kept talk", `${count(configuration.context.chatWindow)} tokens`)]),
		...(whole(configuration.context?.collapseTokens) === undefined ? [] : [setting("collapse-tokens", "Collapse threshold", `${count(configuration.context.collapseTokens)} tokens`)]),
		...(typeof configuration.context?.collapseMinutes === "number" ? [setting("collapse-minutes", "Away collapse", minutes(configuration.context.collapseMinutes))] : []),
		...(text(configuration.appearance?.colors) === undefined ? [] : [setting("colors", "Colours", configuration.appearance.colors)]),
		...(text(configuration.appearance?.theme) === undefined ? [] : [setting("theme", "Theme", configuration.appearance.theme)]),
	];
	return {
		provider,
		configuration: configRows,
		policy: policyDescription(snapshot.policy),
	};
};

/** The assessment and top-of-context comparison uses the existing settled Runtime projection. */
const assessment = ({ assessment: current = {}, top, changes, file } = {}) => {
	const textValue = typeof current.text === "string" ? current.text.trim() : "";
	const changed = changes !== undefined && (changes.assessment === true || (Array.isArray(changes.written) && changes.written.length > 0) || (Array.isArray(changes.removed) && changes.removed.length > 0));
	const topAt = typeof top?.at === "string" ? Date.parse(top.at) : undefined;
	return {
		text: textValue,
		empty: textValue === "",
		...(typeof current.written === "number" ? { written: stamp(current.written) } : {}),
		...(typeof file === "string" && file !== "" ? { file } : {}),
		copy: top === undefined
			? { state: "missing", style: "warn", text: "No top-of-context copy has been written yet. The next pin, fresh context, or eligible collapse writes the assessment and graph together." }
			: changed
				? { state: "stale", style: "warn", text: `The top-of-context copy is from ${Number.isFinite(topAt) ? stamp(topAt) : "an unknown time"}${text(top.reason) === undefined ? "" : ` (${top.reason})`}; the assessment or graph changed since. /pin, /new, or a goal close refreshes it.` }
				: { state: "current", style: "ok", text: `The top-of-context copy from ${Number.isFinite(topAt) ? stamp(topAt) : "its recorded time"}${text(top.reason) === undefined ? "" : ` (${top.reason})`} matches the current assessment and graph.` },
	};
};

export function createSettingsPresentation() {
	return Object.freeze({
		overview: Object.freeze({ describe: settings }),
		assessment: Object.freeze({ describe: assessment }),
	});
}
