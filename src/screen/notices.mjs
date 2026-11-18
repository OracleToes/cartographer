// Session-local notices for the persistent screen shell.
//
// A flash is still useful for immediate terminal feedback, but it vanishes before someone can orient themselves.
// This store keeps a bounded status history and exposes the newest live notice to the footer without involving a
// renderer in action, transport, or durable-state work.
import { TOKEN } from "./tokens.mjs";

export const NOTICE_LEVEL = Object.freeze({
	info: "info",
	success: "success",
	warning: "warning",
	error: "error",
});

const LEVEL = {
	[NOTICE_LEVEL.info]: { mark: "·", style: TOKEN.feedback.info },
	[NOTICE_LEVEL.success]: { mark: "✓", style: TOKEN.feedback.success },
	[NOTICE_LEVEL.warning]: { mark: "!", style: TOKEN.feedback.warning },
	[NOTICE_LEVEL.error]: { mark: "!", style: TOKEN.feedback.danger },
};
const cleanMessage = (message) => String(message ?? "").replace(/\s+/g, " ").trim();

/** A semantic span for a visible notification row. */
export function noticeSpans(notice) {
	const level = LEVEL[notice?.level] ?? LEVEL[NOTICE_LEVEL.info];
	return [[`${level.mark} `, level.style], [cleanMessage(notice?.message), TOKEN.text.primary]];
}

/**
 * A bounded in-memory notice history. Expired notices remain in history for a screen session but stop occupying the
 * persistent footer. Callers may pass `ttl: Infinity` for a notice that must remain visible until dismissed.
 */
export function createNoticeStore({ now = () => Date.now(), limit = 24, ttlMs = 4_000 } = {}) {
	const maximum = Math.max(1, Math.floor(limit));
	let serial = 0;
	let notices = [];

	const add = ({ message, level = NOTICE_LEVEL.info, ttl = ttlMs } = {}) => {
		const text = cleanMessage(message);
		if (text === "") return undefined;
		const at = now();
		const duration = Number.isFinite(ttl) && ttl >= 0 ? ttl : undefined;
		const notice = Object.freeze({
			id: `notice:${++serial}`,
			message: text,
			level: Object.hasOwn(LEVEL, level) ? level : NOTICE_LEVEL.info,
			at,
			...(duration === undefined ? {} : { expiresAt: at + duration }),
		});
		notices = [...notices, notice].slice(-maximum);
		return notice;
	};
	const latest = ({ live = false } = {}) => {
		const at = now();
		for (let index = notices.length - 1; index >= 0; index--) {
			const notice = notices[index];
			if (!live || notice.expiresAt === undefined || notice.expiresAt > at) return notice;
		}
		return undefined;
	};
	const history = () => [...notices];
	const dismiss = (id = latest()?.id) => {
		const before = notices.length;
		notices = notices.filter((notice) => notice.id !== id);
		return notices.length !== before;
	};
	const clear = () => {
		const had = notices.length > 0;
		notices = [];
		return had;
	};
	return Object.freeze({ add, latest, history, dismiss, clear });
}
