// Migrated Settings & Safety renderers.
//
// Configuration, policy, provider, and assessment data arrive as already-settled application projections. These
// renderers own no config/session/sandbox/native-grammar import and never turn a listed provider route into a ready
// route themselves.

const note = (text, style = "muted") => ({ key: `note:${text}`, plain: true, head: [[text, style]] });

/** The session-only safety and provider view. Persisted settings have their own Configuration collection. */
export function settingsSafetyView({ settings, presentation, lifecycle = [] } = {}) {
	if (presentation === undefined || typeof presentation.describe !== "function") throw new TypeError("Safety needs its presentation adapter.");
	if (!Array.isArray(lifecycle)) throw new TypeError("Safety lifecycle controls need a settled capability array.");
	const described = presentation.describe(settings);
	const lifecycleRows = lifecycle.filter((capability) => capability !== null && typeof capability === "object" && typeof capability.id === "string" && typeof capability.label === "string").map((capability) => {
		const enabled = capability.availability?.enabled === true;
		const reason = typeof capability.availability?.reason === "string" && capability.availability.reason.trim() !== "" ? capability.availability.reason.trim() : "This lifecycle action is unavailable right now.";
		return {
			key: `lifecycle:${capability.id}`,
			head: [[`${capability.label}  `, "bold"], [enabled ? "available" : "unavailable", enabled ? "ok" : "warn"], [enabled ? "  · Enter opens" : "", "muted"]],
			body: enabled ? "Terminal-owned control. Enter opens its typed action flow; confirmation appears when required." : reason,
			copy: `${capability.label}: ${enabled ? "available" : `unavailable — ${reason}`}`,
			lifecycleAction: capability.id,
		};
	});
	const header = [
		[["Safety", "bold"]],
		[["Session policy is shown here, but authorization stays with the backend. Saved policy defaults take effect only in a future session; a listed provider route is not agent-ready until native llama.cpp GBNF validation passes.", "muted"]],
	];
	const items = [
		{ key: "provider", plain: true, head: [["── Provider setup ──", "muted"]] },
		{
			key: "provider:endpoint",
			head: [["Provider endpoint  ", "bold"], [described.provider.server ?? "not configured", described.provider.server === undefined ? "warn" : ""]],
			body: `Configured model: ${described.provider.configuredModel ?? "not configured"}${described.provider.currentId === undefined ? "" : `\nActive route: ${described.provider.currentId}`}${described.provider.limits === undefined ? "" : `\n${described.provider.limits}`}`,
			copy: [described.provider.server, described.provider.configuredModel, described.provider.currentId, described.provider.limits].filter((value) => value !== undefined).join("\n"),
		},
		{ key: "provider:diagnostics", plain: true, head: [["── Connection and native grammar ──", "muted"]] },
		...described.provider.diagnostics.map((diagnostic) => ({
			key: `diagnostic:${diagnostic.id}`,
			head: [[`${diagnostic.label}  `, "bold"], [diagnostic.state, diagnostic.style]],
			body: diagnostic.text,
			copy: `${diagnostic.label}: ${diagnostic.state}\n${diagnostic.text}`,
		})),
		{ key: "policy", plain: true, head: [["── Session policy ──", "muted"]] },
		...described.policy.map((policy) => ({
			key: `policy:${policy.id}`,
			head: [[`${policy.label}  `, "bold"], [policy.state, policy.style], [`  · ${policy.default}`, "muted"]],
			body: policy.detail,
			copy: `${policy.label}: ${policy.state}\n${policy.detail}\n${policy.default}`,
		})),
		...(lifecycleRows.length === 0 ? [] : [
			{ key: "lifecycle", plain: true, head: [["── Terminal lifecycle controls ──", "muted"]] },
			...lifecycleRows,
		]),
	];
	return { header, items };
}

/** Compatibility renderer for callers that still show configuration and safety in one legacy overview. */
export function settingsOverviewView({ settings, presentation } = {}) {
	if (presentation === undefined || typeof presentation.describe !== "function") throw new TypeError("Settings & Safety needs its presentation adapter.");
	const described = presentation.describe(settings);
	const header = [
		[["Settings & Safety", "bold"]],
		[["Session policy is shown here, but authorization stays with the backend. A listed provider route is not agent-ready until native llama.cpp GBNF validation passes.", "muted"]],
	];
	const items = [
		{ key: "provider", plain: true, head: [["── Provider setup ──", "muted"]] },
		{
			key: "provider:endpoint",
			head: [["Provider endpoint  ", "bold"], [described.provider.server ?? "not configured", described.provider.server === undefined ? "warn" : ""]],
			body: `Configured model: ${described.provider.configuredModel ?? "not configured"}${described.provider.currentId === undefined ? "" : `\nActive route: ${described.provider.currentId}`}${described.provider.limits === undefined ? "" : `\n${described.provider.limits}`}`,
			copy: [described.provider.server, described.provider.configuredModel, described.provider.currentId, described.provider.limits].filter((value) => value !== undefined).join("\n"),
		},
		{ key: "provider:diagnostics", plain: true, head: [["── Connection and native grammar ──", "muted"]] },
		...described.provider.diagnostics.map((diagnostic) => ({
			key: `diagnostic:${diagnostic.id}`,
			head: [[`${diagnostic.label}  `, "bold"], [diagnostic.state, diagnostic.style]],
			body: diagnostic.text,
			copy: `${diagnostic.label}: ${diagnostic.state}\n${diagnostic.text}`,
		})),
		{ key: "policy", plain: true, head: [["── Session policy ──", "muted"]] },
		...described.policy.map((policy) => ({
			key: `policy:${policy.id}`,
			head: [[`${policy.label}  `, "bold"], [policy.state, policy.style], [`  · ${policy.default}`, "muted"]],
			body: policy.detail,
			copy: `${policy.label}: ${policy.state}\n${policy.detail}\n${policy.default}`,
		})),
		{ key: "configuration", plain: true, head: [["── Active configuration ──", "muted"]] },
		...described.configuration.map((row) => ({
			key: `setting:${row.id}`,
			head: [[`${row.label}  `, "bold"], [row.value, ""]],
			...(row.detail === undefined ? {} : { body: row.detail, copy: `${row.label}: ${row.value}\n${row.detail}` }),
			...(row.detail === undefined ? { copy: `${row.label}: ${row.value}` } : {}),
		})),
	];
	return { header, items };
}

/** The settled assessment and its top-of-context freshness state. */
export function settingsAssessmentView({ assessment, presentation } = {}) {
	if (presentation === undefined || typeof presentation.describe !== "function") throw new TypeError("Assessment needs its Settings presentation adapter.");
	const described = presentation.describe(assessment);
	const header = [
		[["Assessment", "bold"], [described.written === undefined ? "" : `  · written ${described.written}`, "muted"]],
		[["The assessment is current durable project knowledge. The top-of-context copy is separate and stays byte-stable until an explicit safe refresh.", "muted"]],
	];
	const items = [
		{
			key: "assessment:copy",
			head: [["Top-of-context copy  ", "bold"], [described.copy.state, described.copy.style]],
			body: described.copy.text,
			copy: described.copy.text,
		},
	];
	if (described.empty) items.push(note("  No assessment yet. The agent writes one when it knows the project."));
	else items.push({
		key: "assessment:text",
		head: [["Current assessment", "bold"]],
		body: described.text,
		copy: described.text,
		...(described.file === undefined ? {} : { target: { file: described.file }, editKind: "assessment" }),
	});
	return { header, items };
}
