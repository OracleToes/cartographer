import { createHash } from "node:crypto";
import { realpath, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { brainDirectory, isInsideRoot } from "./paths.js";

const MAX_INSPECT_BYTES = 1_000_000;
const MAX_INSPECT_LINES = 500;

export interface InspectRequest {
  path: string;
  startLine: number;
  endLine: number;
}

export interface InspectedFile {
  path: string;
  startLine: number;
  endLine: number;
  digest: string;
  excerpt: string;
}

export class WorkspaceError extends Error {}

export async function inspectProjectFile(projectRoot: string, request: InspectRequest): Promise<InspectedFile> {
  if (!Number.isInteger(request.startLine) || request.startLine < 1) {
    throw new WorkspaceError("The first line must be a positive integer.");
  }
  if (!Number.isInteger(request.endLine) || request.endLine < request.startLine) {
    throw new WorkspaceError("The last line must be at or after the first line.");
  }
  if (request.endLine - request.startLine + 1 > MAX_INSPECT_LINES) {
    throw new WorkspaceError(`Mini reads at most ${MAX_INSPECT_LINES} lines at one time.`);
  }

  const root = await realpath(projectRoot);
  const candidate = await realpath(resolve(root, request.path));
  if (!isInsideRoot(root, candidate)) throw new WorkspaceError("The path is outside the project root.");
  if (isInsideRoot(brainDirectory(root), candidate)) throw new WorkspaceError("Mini does not inspect .brain.");

  const info = await stat(candidate);
  if (!info.isFile()) throw new WorkspaceError("Mini can inspect files only.");
  if (info.size > MAX_INSPECT_BYTES) throw new WorkspaceError(`Mini reads files up to ${MAX_INSPECT_BYTES} bytes.`);

  const bytes = await readFile(candidate);
  if (bytes.includes(0)) throw new WorkspaceError("Mini does not inspect binary files in version one.");
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/);
  const excerpt = lines.slice(request.startLine - 1, request.endLine).join("\n");
  const displayPath = relative(root, candidate) || ".";

  return {
    path: displayPath,
    startLine: request.startLine,
    endLine: Math.min(request.endLine, lines.length),
    digest: createHash("sha256").update(bytes).digest("hex"),
    excerpt,
  };
}
