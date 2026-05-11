import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { colorAgentText } from "./agent-colors.js";
import type { LiveSubagentRegistry } from "./live-registry.js";
import { TranscriptView } from "./transcript-view.js";
import { formatRunLabel, getRunShortId, type SubagentRunRecord } from "./transcript-types.js";

function statusIcon(status: string): string {
	switch (status) {
		case "running":
			return "⏳";
		case "done":
			return "✓";
		case "aborted":
			return "⏹";
		default:
			return "✗";
	}
}

function shortCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function parseMouseWheelDelta(data: string): number | undefined {
	// SGR mouse mode: ESC [ < button ; col ; row M/m. Wheel up/down are 64/65,
	// with modifier bits possibly added.
	const sgr = data.match(/^\x1b\[<(\d+);\d+;\d+[mM]$/);
	if (sgr) {
		const button = Number(sgr[1]);
		const base = button & ~28; // strip shift/meta/ctrl bits (4, 8, 16)
		if (base === 64) return -3;
		if (base === 65) return 3;
	}

	// Normal xterm mouse mode: ESC [ M Cb Cx Cy, where Cb = 32 + button.
	if (data.startsWith("\x1b[M") && data.length >= 6) {
		const button = data.charCodeAt(3) - 32;
		const base = button & ~28;
		if (base === 64) return -3;
		if (base === 65) return 3;
	}

	return undefined;
}

export class SubagentOverlay implements Component {
	private selectedIndex = -1;
	private scrollOffset = 0;
	private expanded = false;
	private stickToBottom = true;
	private transcriptView = new TranscriptView();
	private unsubscribe?: () => void;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: () => void,
		private registry: LiveSubagentRegistry,
		private initialRunId?: string,
	) {
		this.enableMouseReporting();
		this.unsubscribe = registry.subscribe(() => {
			this.transcriptView.invalidate();
			this.tui.requestRender();
		});
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const height = Math.max(8, this.tui.terminal.rows || 24);
		const runs = this.registry.getRunsSortedByStartTime();
		if (runs.length === 0) return this.renderEmpty(safeWidth, height);
		if (this.selectedIndex < 0) {
			const initialIndex = this.initialRunId ? runs.findIndex((run) => run.id === this.initialRunId) : -1;
			this.selectedIndex = initialIndex >= 0 ? initialIndex : runs.length - 1;
		}
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, runs.length - 1));
		const run = runs[this.selectedIndex];

		const header = this.renderHeader(run, runs.length, safeWidth);
		const footer = this.renderFooter(safeWidth);
		const bodyHeight = Math.max(1, height - header.length - footer.length);
		const body = this.transcriptView.renderRun(run, safeWidth, {
			tui: this.tui,
			theme: this.theme,
			expanded: this.expanded,
		});
		const maxScroll = Math.max(0, body.length - bodyHeight);
		if (this.stickToBottom) this.scrollOffset = maxScroll;
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
		while (visibleBody.length < bodyHeight) visibleBody.push("");
		return this.padToHeight([...header, ...visibleBody, ...footer], safeWidth, height);
	}

	handleInput(data: string): void {
		const wheelDelta = parseMouseWheelDelta(data);
		if (wheelDelta !== undefined) {
			this.scrollBy(wheelDelta);
			return;
		}

		if (matchesKey(data, "ctrl+shift+o") || matchesKey(data, "alt+o") || matchesKey(data, Key.escape) || data === "q") {
			this.done();
			return;
		}
		if (matchesKey(data, "ctrl+o")) {
			this.expanded = !this.expanded;
			this.transcriptView.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.selectRelative(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.selectRelative(1);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollBy(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollBy(-Math.max(5, this.tui.terminal.rows - 6));
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(Math.max(5, this.tui.terminal.rows - 6));
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.scrollOffset = 0;
			this.stickToBottom = false;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.stickToBottom = true;
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		this.transcriptView.invalidate();
	}

	dispose(): void {
		this.disableMouseReporting();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private selectRelative(delta: number): void {
		const runs = this.registry.getRunsSortedByStartTime();
		if (runs.length === 0) return;
		if (this.selectedIndex < 0) this.selectedIndex = runs.length - 1;
		this.selectedIndex = (this.selectedIndex + delta + runs.length) % runs.length;
		this.scrollOffset = 0;
		this.stickToBottom = true;
		this.transcriptView.invalidate();
		this.tui.requestRender();
	}

	private scrollBy(delta: number): void {
		this.scrollOffset = Math.max(0, this.scrollOffset + delta);
		this.stickToBottom = false;
		this.tui.requestRender();
	}

	private enableMouseReporting(): void {
		// Capture wheel events while the fullscreen overlay is focused. Without this,
		// many terminals scroll their scrollback buffer, revealing the parent session
		// behind the overlay. SGR mode keeps coordinates parseable.
		this.tui.terminal.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
	}

	private disableMouseReporting(): void {
		this.tui.terminal.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
	}

	private renderHeader(run: SubagentRunRecord, total: number, width: number): string[] {
		const borderColor = run.agentColor || "borderAccent";
		const top = colorAgentText(this.theme, borderColor, "─".repeat(Math.max(0, width)), "borderAccent");
		const runLabel = formatRunLabel(run.agent, run.id);
		const agentName = this.theme.bold(colorAgentText(this.theme, run.agentColor, runLabel, "toolTitle"));
		const title = `${this.theme.bold(this.theme.fg("accent", "Subagents"))} ${this.theme.fg("muted", `${this.selectedIndex + 1}/${total}`)} ${statusIcon(run.status)} ${agentName} ${this.theme.fg("muted", `[${run.mode}]`)} ${run.model ? this.theme.fg("dim", run.model) : ""}`;
		const ctx = `${this.theme.fg("muted", "id:")} ${this.theme.fg("dim", getRunShortId(run.id))} ${this.theme.fg("muted", "cwd:")} ${this.theme.fg("dim", shortCwd(run.cwd || process.cwd()))}`;
		const help = this.theme.fg(
			"dim",
			"←/→ agent · ↑/↓ scroll · PgUp/PgDn · Ctrl+O expand · Alt+O/Esc/q back",
		);
		return [top, truncateToWidth(title, width), truncateToWidth(ctx, width), truncateToWidth(help, width), top];
	}

	private renderFooter(width: number): string[] {
		const state = this.expanded ? "expanded" : "collapsed";
		const line = this.theme.fg("borderAccent", "─".repeat(Math.max(0, width)));
		return [line, truncateToWidth(this.theme.fg("dim", `View: ${state}`), width)];
	}

	private renderEmpty(width: number, height: number): string[] {
		const line = this.theme.fg("borderAccent", "─".repeat(Math.max(0, width)));
		const lines = [
			line,
			truncateToWidth(this.theme.bold(this.theme.fg("accent", "Subagents")), width),
			truncateToWidth(this.theme.fg("muted", "No subagent runs found in this session yet."), width),
			truncateToWidth(this.theme.fg("dim", "Esc, Alt+O, or q to return."), width),
			line,
		];
		return this.padToHeight(lines, width, height);
	}

	private padToHeight(lines: string[], width: number, height: number): string[] {
		const out = lines.slice(0, height).map((line) => this.padLine(line, width));
		while (out.length < height) out.push(" ".repeat(width));
		return out;
	}

	private padLine(line: string, width: number): string {
		const truncated = truncateToWidth(line, width);
		const pad = Math.max(0, width - visibleWidth(truncated));
		return truncated + " ".repeat(pad);
	}
}
