export class WakeError extends Error {}

/** Accept an ISO 8601 time or a Unix timestamp in milliseconds. */
export function parseTimeWakeCondition(condition: string): number {
  const trimmed = condition.trim();
  const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new WakeError("A time wake needs an ISO 8601 time or a Unix timestamp in milliseconds.");
  }
  return numeric;
}
