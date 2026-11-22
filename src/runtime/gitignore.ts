/**
 * `.gitignore` semantics for the project tree scan (§6.3).
 *
 * Scope, deliberately: the project root's `.gitignore`, the repository's
 * `.git/info/exclude`, and nested `.gitignore` files below the anchor.
 * Comments, blank lines, negation (`!`), directory-only rules (trailing `/`),
 * anchored rules (leading `/`, or containing `/`), basename rules (no
 * slash), `**`, `*`, `?`, and `[...]` classes. Deeper files win; within a
 * file, later lines win; the last matching rule decides, and negation is a
 * re-include.
 *
 * Ignored directories are pruned from the walk, not filtered from the
 * output — git cannot re-include a file whose parent directory is excluded,
 * so neither can this. Pruning is where the saving comes from.
 *
 * Deviations from git, on purpose: the global excludes file and
 * `core.excludesfile` are not read; `.ignore` files are not read; the rules
 * apply even outside a git repository (a root `.gitignore` is the project's
 * own statement of what is generated, and repo-boundary quirks are not
 * something an agent-facing map should inherit). Patterns containing a slash
 * anchor at the `.gitignore` file's directory, as git does.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface IgnoreRule {
  /** A leading `!` rule: a match re-includes rather than excludes. */
  readonly negate: boolean;
  /** A trailing `/` rule: matches directories only. */
  readonly dirOnly: boolean;
  /** True when the pattern may contain or start with a slash: matched against the path relative to the file's directory. */
  readonly anchored: boolean;
  /** The compiled glob, anchored at both ends. */
  readonly regex: RegExp;
}

export interface IgnoreFile {
  /** Absolute directory the file lives in (posix separators). */
  readonly refDir: string;
  /** Rules in file order; evaluation reads them backwards. */
  readonly rules: readonly IgnoreRule[];
}

/** Root-anchored chain: `.git/info/exclude` and the root `.gitignore`. Parsed once per scan. */
export interface IgnoreChain {
  readonly files: readonly IgnoreFile[];
  /** Absolute paths of the ignore files already loaded; prevents double-loading when the base walk and the scan meet. */
  readonly paths: ReadonlySet<string>;
}

const escapeRe = (text: string): string => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * Compile a glob to an anchored RegExp. A double-star followed by a slash
 * may match zero or more leading directories; `*` and `?` stay inside one
 * segment; bracketed classes pass through with `!` as negation.
 */
function globToRegex(glob: string): RegExp {
  let out = "";
  let index = 0;
  while (index < glob.length) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob.startsWith("**", index)) {
        index += 2;
        if (glob[index] === "/") {
          index += 1;
          out += "(?:[^/]+/)*";
        } else {
          out += ".*";
        }
        continue;
      }
      out += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      index += 1;
      continue;
    }
    if (char === "[") {
      const close = glob.indexOf("]", index + 1);
      if (close === -1) {
        out += "\\[";
        index += 1;
        continue;
      }
      let body = glob.slice(index + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      out += `[${body}]`;
      index = close + 1;
      continue;
    }
    out += escapeRe(char);
    index += 1;
  }
  return new RegExp(`^${out}$`);
}

/** Parse one line of a gitignore file; returns the rule, or null for comments/blanks/bad patterns. */
export function parseRuleLine(rawLine: string): IgnoreRule | null {
  let line = rawLine.replace(/\r$/, "");
  if (line.trim() === "") return null;
  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!")) {
    line = line.slice(1);
  } else if (line.startsWith("#")) {
    return null;
  } else if (line.startsWith("\\#")) {
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line === "") return null;
  let anchored = false;
  if (line.startsWith("/")) {
    anchored = true;
    line = line.slice(1);
  } else if (line.includes("/")) {
    anchored = true;
  }
  return { negate, dirOnly, anchored, regex: globToRegex(line) };
}

const posixPath = (absolute: string): string => absolute.split(sep).join("/");

/** Load a gitignore file relative to `refDir`; unreadable files yield no rules. */
export function loadIgnoreFile(filePath: string, refDir: string): IgnoreFile {
  let rules: IgnoreRule[] = [];
  try {
    for (const raw of readFileSync(filePath, "utf8").split("\n")) {
      const rule = parseRuleLine(raw);
      if (rule) rules.push(rule);
    }
  } catch {
    rules = [];
  }
  return { refDir: posixPath(refDir), rules };
}

/**
 * The base chain for a scan rooted at `root`: `.git/info/exclude` first, then
 * the root `.gitignore` (later files win). Missing files contribute nothing.
 */
export function baseIgnoreChain(root: string): IgnoreChain {
  const files: IgnoreFile[] = [];
  const paths = new Set<string>();
  const exclude = join(root, ".git", "info", "exclude");
  if (existsSync(exclude)) {
    files.push(loadIgnoreFile(exclude, root));
    paths.add(exclude);
  }
  const gitignore = join(root, ".gitignore");
  if (existsSync(gitignore)) {
    files.push(loadIgnoreFile(gitignore, root));
    paths.add(gitignore);
  }
  return { files, paths };
}

/**
 * The chain for `refDir`, extended with its own `.gitignore` if it has one.
 * Call for directories below the root; the root's own file is already in the
 * base chain. `entryNames` are the names listed in the directory (from
 * readdir), so no extra syscall is made; omit them outside a listing.
 */
export function deeperIgnoreChain(chain: IgnoreChain, absoluteDir: string, entryNames?: readonly string[]): IgnoreChain {
  const candidate = join(absoluteDir, ".gitignore");
  if (chain.paths.has(candidate)) return chain;
  if (entryNames === undefined ? !existsSync(candidate) : !entryNames.includes(".gitignore")) {
    return chain;
  }
  return {
    files: [...chain.files, loadIgnoreFile(candidate, absoluteDir)],
    paths: new Set([...chain.paths, candidate]),
  };
}

const relativePosix = (refDir: string, absolutePosix: string): string => {
  const base = refDir.endsWith("/") ? refDir.slice(0, -1) : refDir;
  if (absolutePosix.startsWith(`${base}/`)) return absolutePosix.slice(base.length + 1);
  const rel = relative(base, absolutePosix);
  return rel.split(sep).join("/");
};

/**
 * True when the path is ignored by the chain. Deeper files win; within a
 * file, later lines win; the last matching rule decides. `directory` must be
 * the lstat verdict (symlinks are leaves, not directories).
 */
export function isIgnored(chain: IgnoreChain, absolutePath: string, basename: string, directory: boolean): boolean {
  const posix = posixPath(absolutePath);
  for (let fileIndex = chain.files.length - 1; fileIndex >= 0; fileIndex -= 1) {
    const file = chain.files[fileIndex]!;
    const rel = file.refDir === posix ? "." : relativePosix(file.refDir, posix);
    const rules = file.rules;
    for (let ruleIndex = rules.length - 1; ruleIndex >= 0; ruleIndex -= 1) {
      const rule = rules[ruleIndex]!;
      if (rule.dirOnly && !directory) continue;
      const matched = rule.anchored ? rule.regex.test(rel) : rule.regex.test(basename);
      if (matched) return !rule.negate;
    }
  }
  return false;
}

