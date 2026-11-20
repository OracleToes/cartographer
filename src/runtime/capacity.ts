/**
 * Advertised capacity, discovered — never assumed (MINI.md §11: Pi AI owns
 * the wire; this only asks llama-swap what it knows).
 *
 * llama-swap advertises a model's context capacity in its `/models` listing,
 * but only once the model is loaded, so the first request may see nothing.
 * Keys checked, in order: top-level `context_length`, then `context_window`,
 * then legacy llama.cpp `meta.n_ctx`.
 *
 * Discovery is best-effort by contract: any failure (unreachable server,
 * non-200, malformed body, missing fields, unknown model id) yields
 * `undefined`, and the configured ceiling stands. It never throws.
 */

export interface AdvertisedCapacity {
  capacity: number;
  /** Which field carried the number; kept for the driver's report line. */
  source: "context_length" | "context_window" | "meta.n_ctx";
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

function advertisedFromEntry(entry: unknown): AdvertisedCapacity | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const pick = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  const direct = pick(record.context_length);
  if (direct !== undefined) return { capacity: direct, source: "context_length" };
  const mirror = pick(record.context_window);
  if (mirror !== undefined) return { capacity: mirror, source: "context_window" };
  const meta = record.meta;
  if (typeof meta === "object" && meta !== null) {
    const legacy = pick((meta as Record<string, unknown>).n_ctx);
    if (legacy !== undefined) return { capacity: legacy, source: "meta.n_ctx" };
  }
  return undefined;
}

export async function discoverAdvertisedCapacity(
  endpoint: string,
  modelId: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<AdvertisedCapacity | undefined> {
  const base = endpoint.replace(/\/+$/, "");
  let body: unknown;
  try {
    const response = await fetchImpl(`${base}/models`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    body = await response.json();
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) return undefined;
  // Strict id match: a capacity from a different route must never be
  // applied to this one. No match means the ceiling stands.
  const entry = data.find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === "object" && candidate !== null && (candidate as Record<string, unknown>).id === modelId,
  );
  if (entry === undefined) return undefined;
  return advertisedFromEntry(entry);
}

/**
 * The configured ceiling is a ceiling: advertised capacity can lower the
 * active window (the server cannot fit what it was not given) but never
 * raise it — raising the ceiling is the person's act, by editing config.
 */
export function activeContextWindow(configured: number, advertised?: number): number {
  return advertised !== undefined && advertised > 0 ? Math.min(configured, advertised) : configured;
}
