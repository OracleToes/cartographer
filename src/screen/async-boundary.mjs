// The common synchronous face of a deferred screen projection.
//
// The projection scheduler owns reads, cancellation, cache freshness, and stale-result rejection. This component
// only turns its settled cache into the list shape the existing screen parts draw. Keeping that boundary here means
// a renderer never has to decide whether it may read again while painting.
import { TOKEN } from "./tokens.mjs";

const messageOf = (projection) => projection?.error?.message ?? "Cartographer could not refresh this view.";
const nameOf = (name) => String(name ?? "view");

/**
 * Render a projection's loading, cached-stale, cached-error, and data states as an existing list view.
 *
 * `render` runs only after data has settled. Empty data belongs to the feature renderer: an empty collection is a
 * successful projection, not a loading or failure state. A cancelled request deliberately has no alarming state;
 * the scheduler leaves its prior data in place, or the next visible refresh starts it again.
 *
 * @template T
 * @param {{
 *   id: string,
 *   name: string,
 *   projection?: { data?: T, loading?: boolean, error?: { message?: string } },
 *   render: (data: T) => { header?: [string, string][][], items?: object[] },
 *   retryHint?: string,
 * }} given
 * @returns {{ header: [string, string][][], items: object[] }}
 */
export function renderAsyncBoundary({ id, name, projection = {}, render, retryHint = "Press r to retry." }) {
	if (typeof render !== "function") throw new TypeError("An async boundary needs a data renderer.");
	const label = nameOf(name);
	if (projection.data === undefined) {
		if (projection.error !== undefined) {
			return {
				header: [[[`! ${messageOf(projection)}`, TOKEN.feedback.warning]]],
				items: [{ key: `projection:${id}:error`, plain: true, head: [[`  ${label} could not be loaded. ${retryHint}`, TOKEN.text.secondary]] }],
			};
		}
		return {
			header: [[[`${label} is loading…`, TOKEN.text.secondary]]],
			items: [{ key: `projection:${id}:loading`, plain: true, head: [["  Reading the current durable view without blocking input…", TOKEN.text.muted]] }],
		};
	}

	const view = render(projection.data);
	const notices = [];
	if (projection.loading) notices.push([[`↻ Refreshing ${label.toLowerCase()} · showing cached data`, TOKEN.text.secondary]]);
	else if (projection.error !== undefined) notices.push([[`! ${messageOf(projection)} · showing cached data`, TOKEN.feedback.warning]]);
	if (Array.isArray(projection.data.issues) && projection.data.issues.length > 0) notices.push([[`! ${projection.data.issues.map((issue) => issue.message).join(" · ")}`, TOKEN.feedback.warning]]);
	return notices.length === 0 ? view : { ...view, header: [...notices, ...(view.header ?? [])] };
}
