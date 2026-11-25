/**
 * The `jobs` book (§8): live view and interactive console for persistent piped
 * processes (`J1`, `J2`, …).
 *
 * Shared live with the agent: every line the agent sends echoes here (`> …`),
 * and every line the person types here goes to the child's stdin and shows up
 * on the agent's next `proc` read / `<carto-state>` unread count.
 *
 * Follows the split-pane shape of `AtlasView` and `LedgerView`: a header row,
 * a job list on the left, live scrollable output on the right, and a bottom
 * input bar for stdin or starting a new command.
 */
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type ScrollView,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { formatExit, type JobLine, type JobSnapshot } from "../runtime/jobs.js";
import { canvasLine, padLine, surfaceLine, tokens } from "./tokens.js";

export type JobsInputMode = "browse" | "send" | "start";

const GUTTER = "  ";

function keyBadge(key: string): string {
  return tokens.handleBadge(` ${key} `);
}

function statusBadge(job: JobSnapshot): string {
  if (job.status === "running") {
    return job.unreadLines > 0
      ? tokens.warn(`● running · ${job.unreadLines} unread`)
      : tokens.agent("● running");
  }
  const code = formatExit(job.exitCode, job.exitSignal);
  return job.exitCode === 0 && job.exitSignal === null
    ? tokens.muted(`○ exited(${code})`)
    : tokens.danger(`○ exited(${code})`);
}

function shortStatus(job: JobSnapshot): string {
  if (job.status === "running") {
    return job.unreadLines > 0 ? tokens.warn(`● ${job.unreadLines}`) : tokens.agent("●");
  }
  return tokens.faint(`○ ${formatExit(job.exitCode, job.exitSignal)}`);
}

function renderJobLine(line: JobLine): string {
  if (line.kind === "stdin") return `${tokens.accent(">")} ${tokens.text(line.text)}`;
  if (line.kind === "stderr") return `${tokens.danger("[stderr]")} ${tokens.text(line.text)}`;
  if (line.kind === "system") return tokens.muted(`· ${line.text}`);
  return tokens.text(line.text);
}

export class JobsView implements Component, Focusable {
  focused = false;
  onBack?: () => void;
  onFocus?: () => void;
  onChange?: () => void;
  onStart?: (command: string) => void;
  onSend?: (handle: string, input: string) => void;
  onSignal?: (handle: string, signal: "SIGINT" | "SIGTERM") => void;
  onStop?: (handle: string) => void;

  private jobs: JobSnapshot[] = [];
  private selectedHandle: string | undefined;
  private mode: JobsInputMode = "browse";
  private readonly input = new Input();
  private listScroll?: ScrollView;
  private detailScroll?: ScrollView;
  private rowHandles: Array<string | undefined> = [];
  private lastOutputKey = "";

  readonly headerPane: Component;
  readonly listPane: Component;
  readonly detailPane: Component;
  readonly inputPane: Component;

  constructor() {
    this.input.onSubmit = (value) => {
      if (this.mode === "start") {
        const command = value.trim();
        this.input.setValue("");
        this.mode = "browse";
        this.input.focused = false;
        if (command.length > 0) this.onStart?.(command);
        this.onChange?.();
        return;
      }
      if (this.mode === "send") {
        const current = this.selectedJob();
        this.input.setValue("");
        if (current !== undefined && current.status === "running") {
          this.onSend?.(current.handle, value);
        }
        this.onChange?.();
      }
    };
    this.input.onEscape = () => {
      this.exitTyping();
    };

    this.headerPane = {
      invalidate: () => undefined,
      render: (width: number) => this.renderHeader(width),
    };
    this.listPane = {
      invalidate: () => undefined,
      render: (width: number) => this.renderList(width),
      handleMouse: (event: TuiMouseEvent) => this.handleListMouse(event),
    };
    this.detailPane = {
      invalidate: () => undefined,
      render: (width: number) => this.renderDetail(width),
      handleMouse: (event: TuiMouseEvent) => {
        if (event.type === "press") {
          this.onFocus?.();
          return { handled: true };
        }
        return undefined;
      },
    };
    this.inputPane = {
      invalidate: () => undefined,
      render: (width: number) => this.renderInputBar(width),
      handleMouse: (event: TuiMouseEvent) => {
        if (event.type === "click") {
          this.onFocus?.();
          if (this.mode === "browse") {
            if (this.selectedJob()?.status === "running") this.enterSend();
            else this.enterStart();
          }
          return { handled: true, render: true };
        }
        return undefined;
      },
    };
  }

  attachScrolls(listScroll: ScrollView, detailScroll: ScrollView): void {
    this.listScroll = listScroll;
    this.detailScroll = detailScroll;
  }

  isTyping(): boolean {
    return this.mode !== "browse";
  }

  inputMode(): JobsInputMode {
    return this.mode;
  }

  selectedJob(): JobSnapshot | undefined {
    if (this.jobs.length === 0) return undefined;
    const found = this.selectedHandle === undefined
      ? undefined
      : this.jobs.find((job) => job.handle === this.selectedHandle);
    return found ?? this.jobs[0];
  }

  /** The selected job and its retained output, including an unfinished line. */
  selectedText(): string | undefined {
    const job = this.selectedJob();
    if (job === undefined) return undefined;
    const output = job.lines.map((line) => line.text).join("\n");
    return `${job.handle} ${job.label} (${job.status})\n$ ${job.command}\n${output}${output.length > 0 && job.pendingPartial.length > 0 ? "\n" : ""}${job.pendingPartial}`;
  }

  selectedHandleName(): string | undefined {
    return this.selectedJob()?.handle;
  }

  setData(jobs: readonly JobSnapshot[]): void {
    const previous = this.selectedJob();
    const wasFollowing = this.detailScroll === undefined || this.detailScroll.isFollowingEnd;
    this.jobs = [...jobs];
    if (this.selectedHandle !== undefined && !this.jobs.some((job) => job.handle === this.selectedHandle)) {
      this.selectedHandle = this.jobs[0]?.handle;
    } else if (this.selectedHandle === undefined && this.jobs.length > 0) {
      this.selectedHandle = this.jobs[0]?.handle;
    }
    const current = this.selectedJob();
    if (this.mode === "send" && (current === undefined || current.status !== "running")) {
      this.mode = "browse";
      this.input.focused = false;
    }
    const nextKey = current === undefined
      ? ""
      : `${current.handle}:${current.lines.length}:${current.pendingPartial.length}:${current.status}`;
    if (nextKey !== this.lastOutputKey) {
      this.lastOutputKey = nextKey;
      if (previous?.handle !== current?.handle || wasFollowing) {
        this.detailScroll?.scrollToEnd();
      }
    }
  }

  enterSend(): boolean {
    const job = this.selectedJob();
    if (job === undefined || job.status !== "running") return false;
    this.mode = "send";
    this.input.setValue("");
    this.input.focused = true;
    this.onChange?.();
    return true;
  }

  enterStart(): void {
    this.mode = "start";
    this.input.setValue("");
    this.input.focused = true;
    this.onChange?.();
  }

  exitTyping(): void {
    if (this.mode === "browse") return;
    this.mode = "browse";
    this.input.setValue("");
    this.input.focused = false;
    this.onChange?.();
  }

  signalSelected(signal: "SIGINT" | "SIGTERM" = "SIGINT"): boolean {
    const job = this.selectedJob();
    if (job === undefined || job.status !== "running") return false;
    this.onSignal?.(job.handle, signal);
    return true;
  }

  stopSelected(): boolean {
    const job = this.selectedJob();
    if (job === undefined) return false;
    this.onStop?.(job.handle);
    return true;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (this.mode !== "browse") {
      if (matchesKey(data, "escape")) {
        this.exitTyping();
        return;
      }
      this.input.focused = true;
      this.input.handleInput(data);
      this.onChange?.();
      return;
    }

    if (matchesKey(data, "escape")) {
      this.onBack?.();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
      this.detailScroll?.scrollBy(-10);
      return;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
      this.detailScroll?.scrollBy(10);
      return;
    }
    if (matchesKey(data, "enter") || data === "i") {
      if (this.selectedJob()?.status === "running") {
        this.enterSend();
      } else if (this.jobs.length === 0) {
        this.enterStart();
      }
      return;
    }
    if (data === "n") {
      this.enterStart();
      return;
    }
    if (data === "s") {
      this.signalSelected("SIGINT");
      return;
    }
    if (data === "d" || data === "x") {
      this.stopSelected();
    }
  }

  private moveSelection(delta: number): void {
    if (this.jobs.length === 0) return;
    const current = this.selectedJob();
    const index = current === undefined ? 0 : this.jobs.findIndex((job) => job.handle === current.handle);
    const next = Math.max(0, Math.min(this.jobs.length - 1, index + delta));
    const chosen = this.jobs[next];
    if (chosen !== undefined && chosen.handle !== this.selectedHandle) {
      this.selectedHandle = chosen.handle;
      this.detailScroll?.scrollToEnd();
      this.keepSelectionVisible(next);
      this.onChange?.();
    }
  }

  private keepSelectionVisible(index: number): void {
    if (this.listScroll === undefined) return;
    const viewport = this.listScroll.viewportHeight;
    if (viewport <= 0) return;
    const top = this.listScroll.scrollTop;
    if (index < top) this.listScroll.scrollTo(index);
    else if (index >= top + viewport) this.listScroll.scrollTo(index - viewport + 1);
  }

  private handleListMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press") {
      this.onFocus?.();
      return { handled: true };
    }
    if (event.type === "click") {
      const handle = this.rowHandles[event.y];
      if (handle !== undefined && handle !== this.selectedHandle) {
        this.selectedHandle = handle;
        this.detailScroll?.scrollToEnd();
        this.onFocus?.();
        this.onChange?.();
        return { handled: true, render: true };
      }
    }
    return undefined;
  }

  private renderHeader(width: number): string[] {
    const running = this.jobs.filter((job) => job.status === "running").length;
    const total = this.jobs.length;
    const count =
      total === 0
        ? tokens.faint("none")
        : running === total
          ? tokens.agent(`${running} running`)
          : `${tokens.agent(`${running} running`)}${tokens.faint(` · ${total - running} exited`)}`;
    const hint =
      this.mode === "send"
        ? tokens.accent("typing stdin · enter send · esc done")
        : this.mode === "start"
          ? tokens.accent("start command · enter run · esc cancel")
          : tokens.faint("n start · i send · s sigint · d stop");
    const left = `${GUTTER}${tokens.bold(tokens.text("jobs"))}  ${count}`;
    const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(hint) - 2);
    const line = visibleWidth(left) + visibleWidth(hint) + 4 <= width
      ? `${left}${" ".repeat(gap)}${hint}`
      : truncateToWidth(left, width, tokens.faint("…"));
    return [
      canvasLine(line, width),
      canvasLine(tokens.rule(`${GUTTER}${"─".repeat(Math.max(1, width - GUTTER.length * 2))}`), width),
    ];
  }

  private renderList(width: number): string[] {
    this.rowHandles = [];
    if (this.jobs.length === 0) {
      return [
        canvasLine("", width),
        canvasLine(`${GUTTER}${tokens.faint("No persistent jobs.")}`, width),
        canvasLine(`${GUTTER}${tokens.faint("Press n to start one,")}`, width),
        canvasLine(`${GUTTER}${tokens.faint("or let Carto call proc.")}`, width),
      ];
    }
    const selected = this.selectedJob()?.handle;
    const lines: string[] = [];
    for (const job of this.jobs) {
      this.rowHandles.push(job.handle);
      const isSelected = job.handle === selected;
      const badge = shortStatus(job);
      const handleText = isSelected ? tokens.bold(tokens.accent(job.handle)) : tokens.accent(job.handle);
      const badgeWidth = visibleWidth(badge);
      const prefix = `${GUTTER}${handleText} `;
      const labelRoom = Math.max(4, width - visibleWidth(prefix) - badgeWidth - 3);
      const label = truncateToWidth(job.label, labelRoom, "…");
      const gap = Math.max(1, width - visibleWidth(prefix) - visibleWidth(label) - badgeWidth - 1);
      const row = `${prefix}${isSelected ? tokens.bold(tokens.text(label)) : tokens.text(label)}${" ".repeat(gap)}${badge}`;
      lines.push(isSelected ? tokens.selectedBg(padLine(row, width)) : canvasLine(row, width));
    }
    return lines;
  }

  private renderDetail(width: number): string[] {
    const job = this.selectedJob();
    const inner = Math.max(10, width - GUTTER.length * 2);
    if (job === undefined) {
      return [
        canvasLine("", width),
        canvasLine(`${GUTTER}${tokens.muted("Persistent piped processes live in memory and survive context collapse.")}`, width),
        canvasLine(`${GUTTER}${tokens.faint("Commands started here or by Carto's `proc` tool share the same live output.")}`, width),
      ];
    }

    const pidText = job.pid === undefined ? "" : tokens.faint(` · pid ${job.pid}`);
    const head = `${GUTTER}${tokens.bold(tokens.accent(job.handle))} ${tokens.bold(tokens.text(job.label))}  ${statusBadge(job)}${pidText}`;
    const cmdLine = `${GUTTER}${tokens.faint("$")} ${tokens.muted(truncateToWidth(job.command, Math.max(8, inner - 2), "…"))}`;
    const divider = `${GUTTER}${tokens.rule("─".repeat(inner))}`;
    const out: string[] = [
      canvasLine(truncateToWidth(head, width, "…"), width),
      canvasLine(truncateToWidth(cmdLine, width, "…"), width),
      canvasLine(divider, width),
    ];

    if (job.lines.length === 0 && job.pendingPartial.length === 0) {
      out.push(canvasLine(`${GUTTER}${tokens.faint("(no output yet)")}`, width));
      return out;
    }

    for (const line of job.lines) {
      const rendered = renderJobLine(line);
      for (const wrapped of wrapTextWithAnsi(rendered, inner)) {
        out.push(canvasLine(`${GUTTER}${wrapped}`, width));
      }
    }
    if (job.pendingPartial.length > 0) {
      for (const wrapped of wrapTextWithAnsi(tokens.text(job.pendingPartial), inner)) {
        out.push(canvasLine(`${GUTTER}${wrapped}`, width));
      }
    }
    return out;
  }

  private renderInputBar(width: number): string[] {
    const inner = Math.max(10, width - 2);
    const job = this.selectedJob();

    if (this.mode === "start") {
      const prompt = tokens.bold(tokens.accent("start $ "));
      const promptWidth = visibleWidth(prompt);
      const rendered = this.input.render(Math.max(8, inner - promptWidth))[0] ?? "";
      return [
        surfaceLine(` ${tokens.faint("new job in project root")}  ${keyBadge("enter")} ${tokens.faint("run")}  ${keyBadge("esc")} ${tokens.faint("cancel")}`, width),
        surfaceLine(` ${prompt}${rendered}`, width),
      ];
    }

    if (this.mode === "send" && job !== undefined) {
      const prompt = tokens.bold(tokens.accent(`${job.handle} > `));
      const promptWidth = visibleWidth(prompt);
      const rendered = this.input.render(Math.max(8, inner - promptWidth))[0] ?? "";
      return [
        surfaceLine(` ${tokens.faint(`stdin → ${job.handle} "${job.label}"`)}  ${keyBadge("enter")} ${tokens.faint("send line")}  ${keyBadge("esc")} ${tokens.faint("done")}`, width),
        surfaceLine(` ${prompt}${rendered}`, width),
      ];
    }

    const hint =
      job === undefined
        ? `${keyBadge("n")} ${tokens.muted("start a job")}`
        : job.status === "running"
          ? `${keyBadge("i")} ${tokens.muted(`send stdin to ${job.handle}`)}   ${keyBadge("s")} ${tokens.muted("SIGINT")}   ${keyBadge("d")} ${tokens.muted("stop")}   ${keyBadge("n")} ${tokens.muted("new job")}`
          : `${keyBadge("d")} ${tokens.muted(`remove ${job.handle}`)}   ${keyBadge("n")} ${tokens.muted("new job")}`;
    return [surfaceLine(` ${truncateToWidth(hint, inner, "…")}`, width)];
  }

  /** Narrow-terminal fallback: header + job list + selected detail stacked. */
  render(width: number): string[] {
    return [
      ...this.renderHeader(width),
      ...this.renderList(width),
      canvasLine("", width),
      ...this.renderDetail(width),
    ];
  }
}
