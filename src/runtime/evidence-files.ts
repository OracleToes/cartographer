/** Dormant, scoped file observations; not a complete assessment or a store. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { assertFileScope, type PathScope } from "./workspace.js";

export type FileObservation =
  | { path: string; resolved: string; sha256: string }
  | { path: string; unavailable: string };
export type FileEvidence = { version: 1; scope: PathScope; files: FileObservation[] };
export type FileEvidenceCheck = {
  status: "current-for-listed-inputs" | "stale" | "unknown";
  files: Array<{ path: string; status: "current" | "changed" | "unknown" }>;
};

/** Stat comparisons detect many races, not an atomic snapshot or a hostile filesystem. */
function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function observe(root: string, path: string, scope: PathScope): FileObservation {
  let fd: number | undefined;
  try {
    if (typeof path !== "string" || path.trim() === "") throw new Error("Invalid path");
    assertFileScope(root, path, scope);
    const named = resolve(root, path);
    const target = realpathSync(named);
    assertFileScope(root, target, scope);
    if (!statSync(target).isFile()) throw new Error("Not a regular file");
    fd = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("Not a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let remaining = before.size;
    while (remaining > 0n) {
      const amount = remaining > BigInt(buffer.length) ? buffer.length : Number(remaining);
      const read = readSync(fd, buffer, 0, amount, null);
      if (read === 0) throw new Error("File changed while reading");
      hash.update(buffer.subarray(0, read));
      remaining -= BigInt(read);
    }
    const after = fstatSync(fd, { bigint: true });
    assertFileScope(root, path, scope);
    const targetAfter = realpathSync(named);
    const pathStat = statSync(targetAfter, { bigint: true });
    if (target !== targetAfter || !sameStat(before, after) || !sameStat(after, pathStat)) {
      throw new Error("File changed while reading");
    }
    return { path, resolved: target, sha256: hash.digest("hex") };
  } catch (error) {
    const reason = error instanceof Error && (error.message === "Not a regular file" || error.message === "File changed while reading")
      ? error.message : "Missing, inaccessible, invalid, or outside the allowed scope";
    return { path, unavailable: reason };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The caller identifies inputs; this does not determine what was actually assessed. */
export function observeEvidenceFiles(root: string, paths: readonly string[], scope: PathScope): FileEvidence {
  if (scope !== "strict" && scope !== "relaxed") throw new Error("Invalid file scope.");
  return { version: 1, scope, files: paths.map((path) => observe(root, path, scope)) };
}

/** Untrusted or incomplete saved evidence is unknown, never an implicit match. */
export function checkEvidenceFiles(root: string, saved: unknown, scope: PathScope): FileEvidenceCheck {
  const unknown = (): FileEvidenceCheck => ({ status: "unknown", files: [] });
  if ((scope !== "strict" && scope !== "relaxed") || saved === null || typeof saved !== "object" || Array.isArray(saved)) return unknown();
  const evidence = saved as Partial<FileEvidence>;
  if (evidence.version !== 1 || evidence.scope !== scope || !Array.isArray(evidence.files) || evidence.files.length === 0) return unknown();
  const seen = new Set<string>();
  const checks: FileEvidenceCheck["files"] = [];
  for (const item of evidence.files) {
    if (item === null || typeof item !== "object" || Array.isArray(item) || typeof item.path !== "string" ||
        item.path.trim() === "" || seen.has(item.path)) return unknown();
    seen.add(item.path);
    if ("unavailable" in item) {
      if (typeof item.unavailable !== "string" || item.unavailable.trim() === "" || "resolved" in item || "sha256" in item) return unknown();
      checks.push({ path: item.path, status: "unknown" });
      continue;
    }
    if (typeof item.resolved !== "string" || !isAbsolute(item.resolved) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) return unknown();
    const current = observe(root, item.path, scope);
    checks.push({ path: item.path, status: "unavailable" in current ? "unknown" :
      current.resolved === item.resolved && current.sha256 === item.sha256 ? "current" : "changed" });
  }
  return { status: checks.some((item) => item.status === "changed") ? "stale" :
    checks.some((item) => item.status === "unknown") ? "unknown" : "current-for-listed-inputs", files: checks };
}
