/** Pure, condition-based guidance derived from observations already in context. */

export type StateCapability = "read" | "collapse" | "proc";
export type StaleKind = "atlas" | "file-modified" | "file-unavailable" | "read-modified" | "read-unavailable";

export function staleGuidance(kind: StaleKind | undefined, capabilities: ReadonlySet<StateCapability>): string | undefined {
  if (kind === "atlas") return capabilities.has("read") ? "inspect the attachment before relying on this note" : undefined;
  if (kind === "file-modified" || kind === "read-modified") {
    if (capabilities.has("read") && capabilities.has("collapse")) return "read current content if in scope, or collapse to refresh the pinned copy";
    if (capabilities.has("read")) return "read current content if in scope before relying on the pinned copy";
    if (capabilities.has("collapse")) return "collapse to refresh the pinned copy";
  }
  if (kind === "file-unavailable" || kind === "read-unavailable") {
    return "check the path and scope before relying on the pinned content";
  }
  return undefined;
}

/** Only fields provided by Pi's actual messages are interpreted here. */
export interface ObservedMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly toolCallId?: string;
  readonly isError?: boolean;
}

interface ToolCall { id: string; name: string }
interface ToolRound { calls: ToolCall[]; results: Map<string, boolean> }

/**
 * Report failures in the latest completed visible tool round, not unresolved
 * problems. Incomplete rounds, orphan results and omitted calls are not guessed.
 */
export function latestToolFailures(
  messages: readonly ObservedMessage[],
  resultHandles: ReadonlyMap<string, string> = new Map(),
): string[] {
  const rounds: ToolRound[] = [];
  const seenIds = new Set<string>();
  let current: ToolRound | undefined;
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const calls: ToolCall[] = [];
      let invalid = false;
      for (const part of message.content as unknown[]) {
        if (part === null || typeof part !== "object") continue;
        const call = part as { type?: unknown; id?: unknown; name?: unknown };
        if (call.type !== "toolCall") continue;
        if (typeof call.id !== "string" || typeof call.name !== "string" || calls.some((existing) => existing.id === call.id)) {
          invalid = true;
        } else {
          calls.push({ id: call.id, name: call.name });
        }
      }
      if (calls.some((call) => seenIds.has(call.id))) return [];
      for (const call of calls) seenIds.add(call.id);
      if (invalid) {
        current = undefined;
      } else if (calls.length > 0) {
        current = { calls, results: new Map() };
        rounds.push(current);
      }
    } else if (message.role === "toolResult" && current !== undefined && typeof message.toolCallId === "string" && typeof message.isError === "boolean") {
      if (current.calls.some((call) => call.id === message.toolCallId)) {
        if (current.results.has(message.toolCallId)) return [];
        current.results.set(message.toolCallId, message.isError);
      }
    }
  }
  const latest = rounds.reverse().find((round) => round.calls.every((call) => round.results.has(call.id)));
  if (latest === undefined) return [];
  return latest.calls.flatMap((call) => {
    if (latest.results.get(call.id) !== true) return [];
    const handle = resultHandles.get(call.id);
    return [`Last completed tool round: \`${call.name}\` failed${handle === undefined ? "" : ` (${handle})`}. Inspect the result before relying on that operation.`];
  });
}
