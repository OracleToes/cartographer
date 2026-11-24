/**
 * The /copy-session context flattening (the person's diagnostic logs).
 * Re-exported from `domain/dump.ts` so both UI dumps and cross-collapse
 * diagnostic history share one flattening implementation.
 */
export { flattenEntry, truncateDumpText, type ContextDumpEntry } from "../domain/dump.js";
