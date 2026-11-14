// Time, as the agent is told it.
//
// The model has no clock. Cartographer gives it three things: the current time in
// the state block, the time of each of the user's messages and task reports, and
// how old a record is where that matters. All of it is written the same way, so
// the model can compare one with another.
import { POLICY } from "./config.mjs";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n) => String(n).padStart(2, "0");

/** A point in time, in the machine's own time zone: "Tue 10 Nov 2026, 14:32". */
export function stamp(ms) {
	const date = new Date(ms);
	return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** What `stamp` writes, as a pattern: for taking stamps out of a text again. */
export const STAMP = "[A-Z][a-z]{2} \\d{1,2} [A-Z][a-z]{2} \\d{4}, \\d{2}:\\d{2}";

/** How long something took: "42 s", "2 m 10 s", "1 h 5 m", "3 d 2 h". */
export function took(ms) {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return seconds % 60 === 0 ? `${minutes} m` : `${minutes} m ${seconds % 60} s`;
	const hours = Math.floor(minutes / 60);
	if (hours < POLICY.limits.format.hoursBeforeDays) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} m`;
	const days = Math.floor(hours / 24);
	return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/** How long ago, coarsely: "just now", "5 m ago", "3 h ago", "2 d ago". */
export function ago(ms) {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < POLICY.limits.format.hoursBeforeDays) return `${hours} h ago`;
	return `${Math.floor(hours / 24)} d ago`;
}

/** Milliseconds since an ISO date or a millisecond count; undefined when it cannot be read. */
export function since(when, now) {
	const then = typeof when === "number" ? when : Date.parse(when ?? "");
	return Number.isFinite(then) ? now - then : undefined;
}
