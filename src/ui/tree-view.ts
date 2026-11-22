/**
 * The Tree view (§6.3): the project as the harness uses it.
 *
 * The state block renders the tree at the anchor and depth the agent set. This
 * is the same tree, opened up: every file and directory under its handle, the
 * Atlas nodes attached to each file, the pinned files the head is holding, and
 * what the agent can actually reach by the tool that moves it.
 *
 * Posting gives the shape (one pane, a header that states what the keys do), and
 * broot gives the tree itself: branches drawn down from the anchor rather than
 * space-indented, a fold per directory so a deep hierarchy stays one screen,
 * and sizes that are honest about what they count — a directory's figure is its
 * whole subtree, because that is what it costs.
 *
 * The details are the ones the harness *uses*, and nothing else. A handle is
 * here because a tool takes one. An attached node is here because the collapse
 * re-reads a pinned file and the block lists the nodes that name it. A pinned
 * file is here because the head is holding a copy of it. A git status is here
 * because the suite and the repo care — and it is not shown at all when the
 * anchor is not in a repository, so the column never lies about a fact it does
 * not have.
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import { handleOf } from "../domain/handles.js";
import type { CartoBrain } from "../domain/records.js";
import { liveStaleMarks } from "../runtime/carto-extension.js";
import { formatSize, projectTreeView, type TreeEntry, type TreeProjection } from "../runtime/project-tree.js";
import { padLine, tokens } from "./tokens.js";

/** Where the agent is looking, and how much it can see: the `tree` tool's own arguments. */
export interface TreeAnchor {
  anchor: string;
  depth: number;
}

export interface TreeViewData {
  /** The project root, so the header can name the anchor the way the agent thinks of it. */
  root: string;
  anchor: TreeAnchor;
  brain: CartoBrain;
}

/** One row of the rendered tree: an entry plus the folder lines that lead to it. */
interface Row {
  entry: TreeEntry;
  /** Depth below the anchor: 1 is the anchor's own contents. */
  level: number;
  /** Whether this entry is the last child on each level, from the anchor down. */
  last: boolean[];
  /** True when the row is a directory whose children are collapsed. */
  folded: boolean;
  /** Files below a collapsed directory, so a folded row can say how much it hides. */
  hidden: number;
}

const isPrefix = (child: string, parent: string): boolean =>
  child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

/** The git status letters for a set of paths, or nothing when this is not a repository. */
function gitStatuses(root: string, paths: readonly string[]): Map<string, string> | undefined {
  let top: string;
  try {
    const asked = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
    if (asked.status !== 0 || asked.stdout.trim() === "") return undefined;
    top = resolve(asked.stdout.trim());
  } catch {
    return undefined;
  }
  const wanted = new Set(paths.map((path) => relative(top, path)));
  const statuses = new Map<string, string>();
  try {
    // `-z`: NUL-separated, so a path with a space or a newline is not parsed wet.
    // `--untracked-files=all` names the new files themselves rather than their
    // directory, which is the fact the tree wants per file.
    const shown = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
      cwd: top,
      encoding: "utf8",
    });
    if (shown.status !== 0 || typeof shown.stdout !== "string") return statuses;
    for (const record of shown.stdout.split("\u0000")) {
      if (record.length < 4) continue;
      const code = record.slice(0, 2).trim();
      const path = record.slice(3);
      if (!wanted.has(path)) continue;
      statuses.set(path, code === "??" ? "new" : code);
    }
  } catch {
    // A repository that cannot be read is not a fact about the tree.
  }
  return statuses;
}

export class TreeView implements Component, Focusable {
  focused = false;
  onBack?: () => void;
  /**
   * Called with the drawn line of the selected row after each render. The view
   * does not scroll itself, and a ScrollView does not follow a child's cursor:
   * the app uses this to keep the cursor in view (§9).
   */
  onCursorLine?: (line: number) => void;

  private data: TreeViewData | undefined;
  private projection: TreeProjection | undefined;
  private rows: Row[] = [];
  private selectedIndex = 0;
  /** Folded directories, by absolute path. Nothing is folded until the person folds it. */
  private folded = new Set<string>();
  private mtimes: Map<string, number> = new Map();
  private git: Map<string, string> | undefined;
  /** Which note the detail pane is showing: the selection, or a note the cursor was opened onto. */
  private detailNote: string | undefined;
  private showPinnedOnly = false;
  private filterText = "";
  private filtering = false;
  /** Files the head is holding, by absolute path, and whether the copy is stale (§5.5). */
  private pinnedFiles = new Map<string, { stale: boolean }>();
  /** Handles of Atlas notes that drifted from the file they attach to. */
  private staleNotes = new Set<string>();
  /** Where each rendered row landed, so a click never has to guess. */
  private hits: Array<{ start: number; end: number; index: number }> = [];
  /** Where the selected row was drawn in the last frame: the ScrollView has none of its own. */
  private cursorLine = 0;
  setData(data: TreeViewData): void {
    this.data = data;
    this.projection = projectTreeView(data.root, data.anchor.anchor, data.anchor.depth, data.brain);
    this.refreshFacts();
    this.selectAfter(this.selectedIndex);
  }

  /**
   * The facts that live outside the tree: mtimes, git status, which files are
   * pinned, and which notes have drifted. Recomputed whenever the data does, so
   * the view shows what is true now rather than what was true at the last scan.
   */
  private refreshFacts(): void {
    const projection = this.projection;
    if (projection === undefined || this.data === undefined) return;
    const brain = this.data.brain;

    // Unpinned files first: the head is the only place a pinned file's bytes
    // live, so a pinned file's mtime is not what the agent read (§5.1).
    this.pinnedFiles.clear();
    for (const file of brain.files) {
      this.pinnedFiles.set(resolve(this.data.root, file.path), { stale: file.stale === true });
    }

    // The same list the state block calls stale, not a second opinion: a note
    // the tree marks drifted and the block does not would be two harnesses
    // disagreeing about one file (§5.5).
    this.staleNotes.clear();
    for (const mark of liveStaleMarks(brain, this.data.root)) this.staleNotes.add(mark.label);

    const paths: string[] = [];
    const collect = (entry: TreeEntry, level: number): void => {
      if (level > projection.depth) return;
      for (const child of entry.children ?? []) {
        paths.push(child.path);
        collect(child, level + 1);
      }
    };
    collect(projection.entry, 1);
    this.git = gitStatuses(this.data.root, paths);
  }

  private handleOfNode(id: string): string | undefined {
    const brain = this.data?.brain;
    return brain === undefined ? undefined : handleOf(brain.handles, "atlas", id);
  }

  private mtimeOf(path: string): number | undefined {
    const held = this.mtimes.get(path);
    if (held !== undefined) return held;
    try {
      const mtime = statSync(path).mtimeMs;
      this.mtimes.set(path, mtime);
      return mtime;
    } catch {
      // A file that cannot be stat'd has no mtime to offer; it is not a fact.
      return undefined;
    }
  }

  private noteFor(entry: TreeEntry): string | undefined {
    const attached = this.projection?.attached.get(entry.path);
    return attached?.[0];
  }

  private isPinned(entry: TreeEntry): boolean {
    return this.pinnedFiles.has(entry.path);
  }

  /** The rows the cursor walks: the tree, flattened, with folded directories standing for their subtrees. */
  private buildRows(): Row[] {
    const rows: Row[] = [];
    const projection = this.projection;
    if (projection === undefined) return rows;
    const walk = (entry: TreeEntry, level: number, last: boolean[]): void => {
      if (level > projection.depth) return;
      const children = entry.children ?? [];
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child === undefined) continue;
        const atEnd = index === children.length - 1;
        const folded = child.directory && this.folded.has(child.path);
        // What a fold is hiding, so the row can say so instead of just looking dead.
        let hidden = 0;
        if (folded) {
          const count = (node: TreeEntry, below: number): void => {
            if (below > projection.depth) return;
            for (const grandchild of node.children ?? []) {
              hidden += 1;
              count(grandchild, below + 1);
            }
          };
          count(child, level + 1);
        }
        rows.push({ entry: child, level, last: [...last, atEnd], folded, hidden });
        if (!folded) walk(child, level + 1, [...last, atEnd]);
      }
    };
    walk(projection.entry, 1, []);
    if (!this.showPinnedOnly) return rows;
    return rows.filter((row) => !row.entry.directory && this.isPinned(row.entry));
  }

  private visibleRows(): Row[] {
    const rows = this.buildRows();
    if (this.filterText.trim().length === 0) return rows;
    const query = this.filterText.toLowerCase();
    return rows.filter((row) => row.entry.name.toLowerCase().includes(query));
  }

  private selectedRow(): Row | undefined {
    return this.visibleRows()[this.selectedIndex];
  }

  private selectAfter(index: number): void {
    const count = this.visibleRows().length;
    this.selectedIndex = count === 0 ? 0 : Math.max(0, Math.min(count - 1, index));
  }

  /**
   * The note the detail pane has open, if `t` opened one. Only the cursor's own
   * keys open it: moving onto a file shows the file, because a pane that changes
   * subject as you walk is a pane you cannot read.
   */
  private shownNote(): { entry: TreeEntry; handle: string } | undefined {
    const selected = this.selectedRow();
    if (this.detailNote !== undefined) {
      const found = this.data?.brain.atlas.find((node) => this.handleOfNode(node.id) === this.detailNote);
      if (found !== undefined) {
        const attached = found.attachments.find((attachment) => attachment.kind === "file");
        const path = attached?.kind === "file" ? resolve(this.data?.root ?? "", attached.path) : selected?.entry.path ?? "";
        return { entry: this.projection?.entry ?? { name: "", path, directory: false, size: 0 }, handle: this.detailNote };
      }
    }
    return undefined;
  }

  /** `t` over a file: open the note attached to it, or leave the detail on the selection. */
  private toggleNote(): void {
    const selected = this.selectedRow();
    if (selected === undefined || selected.entry.directory) {
      this.detailNote = undefined;
      return;
    }
    const handle = this.noteFor(selected.entry);
    this.detailNote = handle === undefined ? undefined : this.detailNote === handle ? undefined : handle;
  }

  handleInput(data: string): void {
    if (this.filtering) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.filtering = false;
        this.filterText = "";
        this.selectAfter(0);
        return;
      }
      if (matchesKey(data, "enter")) {
        this.filtering = false;
        return;
      }
      if (matchesKey(data, "backspace")) {
        this.filterText = this.filterText.slice(0, -1);
        this.selectAfter(0);
        return;
      }
      if (data.length === 1) {
        this.filterText += data;
        this.selectAfter(0);
      }
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onBack?.();
      return;
    }
    if (data === "/") {
      this.filtering = true;
      this.filterText = "";
      return;
    }
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.selectedIndex = Math.min(this.visibleRows().length - 1, this.selectedIndex + 1);
      this.detailNote = undefined;
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.detailNote = undefined;
      return;
    }
    if (matchesKey(data, "g")) {
      this.selectedIndex = 0;
      this.detailNote = undefined;
      return;
    }
    if (data === "G") {
      this.selectedIndex = Math.max(0, this.visibleRows().length - 1);
      this.detailNote = undefined;
      return;
    }
    // `h`/`l` fold and unfold rather than navigate: in a tree, the hierarchy is
    // the thing you are moving through, and broot's folds are what keep it small.
    if (matchesKey(data, "h") || matchesKey(data, "left")) {
      this.foldAt(true);
      return;
    }
    if (matchesKey(data, "l") || matchesKey(data, "right") || matchesKey(data, "enter") || matchesKey(data, "space")) {
      this.foldAt(false);
      return;
    }
    if (matchesKey(data, "t")) {
      this.toggleNote();
      return;
    }
    if (matchesKey(data, "f")) {
      this.showPinnedOnly = !this.showPinnedOnly;
      this.selectAfter(0);
      this.detailNote = undefined;
      return;
    }
  }

  /** Fold the selected directory, or unfold it. On a file, on a fold, the parent closes. */
  private foldAt(fold: boolean): void {
    const selected = this.selectedRow();
    if (selected === undefined) return;
    if (selected.entry.directory) {
      if (fold) this.folded.add(selected.entry.path);
      else this.folded.delete(selected.entry.path);
      return;
    }
    // A file has nothing to fold, so `h` closes the directory it is in: one key
    // still moves you up a level in the hierarchy.
    if (!fold) return;
    const parent = selected.entry.path.slice(0, selected.entry.path.lastIndexOf("/"));
    if (parent.length === 0) return;
    this.folded.add(parent);
    this.selectAfter(this.selectedIndex);
  }

  handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent): import("@earendil-works/pi-tui").TuiMouseEventResult | undefined {
    if (event.type === "wheel") return undefined; // the scroll view owns the wheel
    if (event.type === "press") return { handled: true, focus: true };
    if (event.type !== "click") return undefined;
    const hit = this.hits.find((range) => event.y >= range.start && event.y < range.end);
    if (hit === undefined) return undefined;
    this.selectedIndex = hit.index;
    this.detailNote = undefined;
    return { handled: true, render: true, focus: true };
  }

  invalidate(): void {
    // Stateless rendering from the projection.
  }

  /** The anchor as the agent thinks of it: `.` at the root, else the path inside it. */
  private anchorLabel(): string {
    if (this.data === undefined || this.projection === undefined) return ".";
    const rel = relative(resolve(this.data.root), this.projection.anchor);
    return rel === "" ? "." : rel;
  }

  /** The branch cells that lead to a row, the way broot draws them. */
  private branch(last: boolean[]): string {
    if (last.length === 0) return "";
    const lead = last
      .slice(0, -1)
      .map((ended) => (ended ? "   " : "│  "))
      .join("");
    return `${lead}${last[last.length - 1] ? "└─ " : "├─ "}`;
  }

  private renderRow(row: Row, width: number, selected: boolean): string[] {
    const cursor = selected ? tokens.accent("▌") : " ";
    const handle = this.projection?.handles.get(row.entry.path);
    // One cell between the handle and the name, so `F9` and `F10` line up: a
    // column that shifts at the tenth file is a column you cannot read down.
    const handleText = handle === undefined ? "" : `${handle.padEnd(3)} `;
    const branch = this.branch(row.last);
    const glyph = row.entry.directory ? (row.folded ? "▸" : "▾") : "·";
    const name = row.entry.directory ? `${row.entry.name}/` : row.entry.name;
    const painted = selected ? tokens.bold(tokens.text(name)) : tokens.text(name);

    // Marks sit beside the name, one glyph each, in the order they matter: what
    // the head is holding, what has drifted, what the repository says.
    const marks: string[] = [];
    if (this.isPinned(row.entry)) marks.push(tokens.pin("P"));
    const note = this.noteFor(row.entry);
    if (note !== undefined) {
      marks.push(this.staleNotes.has(note) ? tokens.warn(`${note}!`) : tokens.atlas(note));
    }
    const git = this.git?.get(relative(this.data?.root ?? "", row.entry.path));
    if (git !== undefined) marks.push(tokens.warn(git));
    if (row.folded && row.hidden > 0) marks.push(tokens.faint(`+${row.hidden}`));

    // The figures are right-aligned in their own column, so a column of sizes is
    // read down rather than scanned along — the sidebar's rule, applied here.
    const size = tokens.muted(formatSize(row.entry.size).padStart(6));
    const left = ` ${cursor} ${tokens.faint(branch)}${tokens.faint(glyph)} ${tokens.muted(handleText)}${painted}`;
    const head = truncateToWidth(left, Math.max(8, width - 10), "…");
    const tail = `${marks.length > 0 ? `${marks.join(" ")} ` : ""}${size}`;
    const gap = Math.max(1, width - visibleWidth(head) - visibleWidth(tail) - 1);
    const line = padLine(`${head}${" ".repeat(gap)}${tail}`, width);
    return [selected ? tokens.selectedBg(line) : line];
  }

  private renderDetail(entry: TreeEntry, width: number): string[] {
    const lines: string[] = [];
    const handle = this.projection?.handles.get(entry.path) ?? "—";
    const rel = this.data === undefined ? entry.path : relative(resolve(this.data.root), entry.path);
    const size = this.projection?.sizes.get(entry.path) ?? entry.size;
    const mtime = this.mtimeOf(entry.path);

    lines.push(padLine(` ${tokens.bold(tokens.accent(`[${handle}]`))} ${tokens.bold(entry.directory ? `${rel}/` : rel)}`, width));
    lines.push(padLine(` ${tokens.faint(`${entry.directory ? "directory" : "file"} · ${formatSize(size)}${mtime === undefined ? "" : ` · ${new Date(mtime).toISOString()}`}`)}`, width));

    // A pinned file is the one fact worth a sentence: the head is holding a copy
    // of it, and that copy is what the agent reads rather than the file (§5.1).
    if (this.pinnedFiles.has(entry.path)) {
      const held = this.pinnedFiles.get(entry.path);
      lines.push(
        padLine(
          ` ${tokens.pin("P")} ${tokens.text("pinned — the head holds this file, read again at every collapse")}${held?.stale === true ? ` ${tokens.warn("· stale: the file is gone or has changed")}` : ""}`,
          width,
        ),
      );
    }

    const attached = this.projection?.attached.get(entry.path) ?? [];
    if (attached.length > 0) {
      // The notes that name this file, and whether each still matches it. This is
      // what the agent acts on: a note whose file moved on is the stale mark.
      for (const noteHandle of attached) {
        const node = this.data?.brain.atlas.find((candidate) => this.handleOfNode(candidate.id) === noteHandle);
        const drifted = this.staleNotes.has(noteHandle);
        lines.push(
          padLine(
            ` ${tokens.atlas(noteHandle)} ${tokens.text(node?.title ?? "(note)")}${drifted ? ` ${tokens.warn("· stale: the file changed after this note")}` : ""}`,
            width,
          ),
        );
      }
    }

    const git = this.git?.get(relative(this.data?.root ?? "", entry.path));
    if (git !== undefined) lines.push(padLine(` ${tokens.faint("git")} ${tokens.warn(git)}`, width));

    // What the agent can do with it, said in the tool's own terms, so the view
    // teaches the interface rather than describing it.
    const usable: string[] = [];
    const depth = this.projection === undefined ? "" : ` depth ${this.projection.depth}`;
    if (entry.directory) {
      usable.push(`\`tree ${handle}${depth}\` anchors the block here`);
    } else {
      usable.push(`\`read ${handle}\``);
      // A file's directory has its own handle, and anchoring the block there is
      // how the agent widens from one file to what holds it — the move the tree
      // makes natural, so the pane names it.
      const parent = this.projection?.handles.get(resolve(entry.path, ".."));
      if (parent !== undefined) usable.push(`\`tree ${parent}${depth}\` anchors the block on its directory`);
    }
    usable.push("`pin` keeps it", "`mark` retires it");
    lines.push(padLine(` ${tokens.faint(usable.join(" · "))}`, width));
    return lines;
  }

  private renderNote(handle: string, width: number): string[] {
    const node = this.data?.brain.atlas.find((candidate) => this.handleOfNode(candidate.id) === handle);
    if (node === undefined) return [];
    const lines: string[] = [];
    lines.push(padLine(` ${tokens.atlas(handle)} ${tokens.bold(node.title)}${node.pinned !== undefined ? ` ${tokens.pin("P")}` : ""}${this.staleNotes.has(handle) ? ` ${tokens.warn("· stale")}` : ""}`, width));
    for (const line of wrapTextWithAnsi(node.text, Math.max(8, width - 3))) lines.push(padLine(`  ${tokens.text(line)}`, width));
    for (const link of node.links) {
      const linked = link;
      lines.push(padLine(`  ${tokens.faint("link")} ${tokens.atlas(linked)}`, width));
    }
    const createdAt = new Date(node.createdAt).toISOString();
    const updatedAt = new Date(node.updatedAt).toISOString();
    lines.push(padLine(`  ${tokens.faint(`created ${createdAt} · updated ${updatedAt}`)}`, width));
    return lines;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    this.hits = [];
    this.rows = this.visibleRows();

    // The header states the anchor the way the block does, because the agent and
    // the person are looking at the same thing.
    const name = tokens.bold(tokens.text("TREE"));
    const anchor = `${tokens.text(this.anchorLabel())} ${tokens.faint(`depth ${this.projection?.depth ?? 1}`)}`;
    const files = this.rows.filter((row) => !row.entry.directory).length;
    const folders = this.rows.filter((row) => row.entry.directory).length;
    const figure = `${tokens.faint(`${folders} ${folders === 1 ? "dir" : "dirs"} · ${files} ${files === 1 ? "file" : "files"}`)}`;
    const filter = this.filtering
      ? ` ${tokens.accent(`/${this.filterText}█`)}`
      : this.filterText.length > 0
        ? ` ${tokens.accent(`/${this.filterText}`)}`
        : "";
    const pinnedOnly = this.showPinnedOnly ? ` ${tokens.pin("· pinned only")}` : "";
    const left = ` ${name} ${tokens.faint("·")} ${anchor} ${figure}${filter}${pinnedOnly}`;
    const right = `${tokens.faint("j/k move · h/l fold · t note · f pinned · / filter ")}`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    lines.push(tokens.panel(padLine(`${left}${" ".repeat(gap)}${right}`, width)));
    lines.push(padLine("", width));

    if (this.projection === undefined || this.data === undefined) {
      lines.push(`  ${tokens.muted("No project tree yet.")}`);
      this.onCursorLine?.(0);
      return lines;
    }
    if (this.rows.length === 0) {
      lines.push(
        `  ${tokens.muted(
          this.filterText.length > 0
            ? `Nothing here matches “${this.filterText}”.`
            : this.showPinnedOnly
              ? "Nothing in this tree is pinned."
              : "This directory is empty, or everything in it is ignored.",
        )}`,
      );
      this.cursorLine = 0;
      this.onCursorLine?.(0);
      return lines;
    }

    const selected = this.selectedRow();
    const note = this.shownNote();

    // Two panes where there is room, one where there is not: the project may
    // narrow the terminal, and a tree that loses its hierarchy is not a tree.
    if (width >= 72) {
      const listWidth = Math.min(46, Math.floor(width * 0.46));
      const detailWidth = Math.max(24, width - listWidth - 2);
      const listLines: string[] = [];
      const listStart = lines.length;
      this.rows.forEach((row, index) => {
        const start = lines.length + listLines.length;
        const rendered = this.renderRow(row, listWidth, index === this.selectedIndex);
        if (index === this.selectedIndex) this.cursorLine = listStart + listLines.length;
        listLines.push(...rendered);
        this.hits.push({ start, end: start + rendered.length, index });
      });

      const detail = note === undefined ? this.renderDetail(selected?.entry ?? this.projection.entry, detailWidth) : this.renderNote(note.handle, detailWidth);
      const height = Math.max(listLines.length, detail.length);
      for (let row = 0; row < height; row += 1) {
        const leftCell = listLines[row] ?? padLine("", listWidth);
        const rightCell = detail[row] ?? padLine("", detailWidth);
        lines.push(`${padLine(leftCell, listWidth)}${tokens.seam("│")}${padLine(rightCell, detailWidth)}`);
      }
      this.onCursorLine?.(this.cursorLine);
      return lines;
    }

    // One pane: what the cursor is on, then the tree. The details go above the
    // list because below it they are past the end of a real directory — the row
    // you selected, and the facts about it, should not be at opposite ends of
    // the pane. The tree is the thing with a cursor, so it scrolls.
    if (selected !== undefined) {
      lines.push(...this.renderDetail(selected.entry, width));
      lines.push(padLine("", width));
    }
    for (const [index, row] of this.rows.entries()) {
      const start = lines.length;
      const rendered = this.renderRow(row, width, index === this.selectedIndex);
      if (index === this.selectedIndex) this.cursorLine = start;
      lines.push(...rendered);
      this.hits.push({ start, end: start + rendered.length, index });
    }
    this.onCursorLine?.(this.cursorLine);
    return lines;
  }
}
