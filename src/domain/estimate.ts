import type { Message } from "@earendil-works/pi-ai";
import {
  calculateContextTokens,
  estimateContextTokens,
  estimateMessageTokens,
  estimateTextTokens,
} from "@earendil-works/pi-ai/utils/estimate";

export { calculateContextTokens, estimateContextTokens, estimateMessageTokens, estimateTextTokens };

/** Estimated tokens from text length, using pi-ai's 3.5 chars/token estimator. */
export const estimateTokens = (text: string): number => estimateTextTokens(text);

const isPiMessage = (value: unknown): value is Message => {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { role?: unknown; content?: unknown };
  if (candidate.role === "system" || candidate.role === "user" || candidate.role === "toolResult") {
    return typeof candidate.content === "string" || Array.isArray(candidate.content);
  }
  if (candidate.role === "assistant") {
    return (
      Array.isArray(candidate.content) &&
      candidate.content.every((block) => block !== null && typeof block === "object" && typeof (block as { type?: unknown }).type === "string")
    );
  }
  return false;
};

/** Estimated tokens of a Pi message or JSON-serialized value; non-serializable values cost 0. */
export const estimateSerialized = (value: unknown): number => {
  if (isPiMessage(value)) return estimateMessageTokens(value);
  const json = JSON.stringify(value);
  return json === undefined ? 0 : estimateTextTokens(json);
};
