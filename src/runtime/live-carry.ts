import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc } from "@earendil-works/pi-durable";

import type { CarryPin } from "../domain/types.js";

type StoredCarry = Record<string, JsonValue>;

/** Selected carry pins belong to one live context generation, not the long-lived Brain. */
export const LiveCarryDocument = defineDoc<StoredCarry>({
  kind: "cartographer.mini.live-carry",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ pins: [] }),
  checkpointWhen: () => true,
});

export function readLiveCarry(value: unknown): CarryPin[] {
  if (value === null || typeof value !== "object" || !Array.isArray((value as { pins?: unknown }).pins)) return [];
  return JSON.parse(JSON.stringify((value as { pins: unknown }).pins)) as CarryPin[];
}
