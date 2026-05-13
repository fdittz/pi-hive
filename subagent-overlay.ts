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

type MouseEventKind = "down" | "drag" | "up" | "wheel";

interface ParsedMouseEvent {
	kind: MouseEventKind;
	col: number;
	row: number;
	wheelDelta?: number;
}

interface SelectionPoint {
	row: number;
	col: number;
}

interface SelectionRange {
	start: SelectionPoint;
	end: SelectionPoint;
}

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const MAX_OSC52_ENCODED_LENGTH = 100_000;

function parseMouseEvent(data: string): ParsedMouseEvent | undefined {
	// SGR mouse mode: ESC [ < button ; col ; row M/m. Wheel up/down are 64/65,
	// with modifier bits possibly added. Coordinates are 1-based terminal cells.
	const sgr = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])$/);
	if (sgr) {
		const button = Number(sgr[1]);
		const col = Number(sgr[2]);
		const row = Number(sgr[3]);
		const final = sgr[4];
		const withoutModifiers = button & ~28; // strip shift/meta/ctrl bits (4, 8, 16)
		if (withoutModifiers === 64) return { kind: "wheel", col, row, wheelDelta: -3 };
		if (withoutModifiers === 65) return { kind: "wheel", col, row, wheelDelta: 3 };
		if (final === "m") return { kind: "up", col, row };
		if ((button & 32) !== 0 && (button & 3) === 0) return { kind: "drag", col, row };
		if ((button & 3) === 0) return { kind: "down", col, row };
		return undefined;
	}

	// Normal xterm mouse mode: ESC [ M Cb Cx Cy, where Cb = 32 + button.
	if (data.startsWith("\x1b[M") && data.length >= 6) {
		const button = data.charCodeAt(3) - 32;
		const col = data.charCodeAt(4) - 32;
		const row = data.charCodeAt(5) - 32;
		const withoutModifiers = button & ~28;
		if (withoutModifiers === 64) return { kind: "wheel", col, row, wheelDelta: -3 };
		if (withoutModifiers === 65) return { kind: "wheel", col, row, wheelDelta: 3 };
		if ((button & 3) === 3) return { kind: "up", col, row };
		if ((button & 32) !== 0 && (button & 3) === 0) return { kind: "drag", col, row };
		if ((button & 3) === 0) return { kind: "down", col, row };
	}

	return undefined;
}

function parseMouseWheelDelta(data: string): number | undefined {
	const event = parseMouseEvent(data);
	return event?.kind === "wheel" ? event.wheelDelta : undefined;
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function compareSelectionPoints(a: SelectionPoint, b: SelectionPoint): number {
	if (a.row !== b.row) return a.row - b.row;
	return a.col - b.col;
}

function selectionPointsEqual(a: SelectionPoint | undefined, b: SelectionPoint | undefined): boolean {
	return Boolean(a && b && a.row === b.row && a.col === b.col);
}

function slicePlainByCells(text: string, start: number, end: number): string {
	if (end <= start) return "";
	let col = 0;
	let out = "";
	for (const char of text) {
		const width = Math.max(0, visibleWidth(char));
		const nextCol = col + width;
		if (width === 0) {
			if (col >= start && col < end) out += char;
		} else if (nextCol > start && col < end && col >= start && nextCol <= end) {
			out += char;
		}
		col = nextCol;
		if (col >= end) break;
	}
	return out;
}

export class SubagentOverlay implements Component {
	private selectedIndex = -1;
	private scrollOffset = 0;
	private lastTotalLines = 0;
	private lastBodyHeight = 1;
	private lastBodyTopRow = 5;
	private lastWidth = 20;
	private lastBodyLines: string[] = [];
	private lastRenderScrollOffset = 0;
	private expanded = false;
	private stickToBottom = true;
	private transcriptView = new TranscriptView();
	private selectedText?: SelectionRange;
	private selectionStart?: SelectionPoint;
	private selectionEnd?: SelectionPoint;
	private selectedPlainText?: string;
	private isSelecting = false;
	private selectionMoved = false;
	private copyNotice?: { message: string; color: "success" | "warning" | "error" };
	private copyNoticeTimer?: ReturnType<typeof setTimeout>;
	private unsubscribe?: () => void;
	private renderTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: () => void,
		private registry: LiveSubagentRegistry,
		private initialRunId?: string,
	) {
		this.enableMouseReporting();
		this.unsubscribe = registry.subscribe(() => {
			this.scheduleRender();
		});
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		this.lastWidth = safeWidth;
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
		const viewport = this.transcriptView.renderRunViewport(
			run,
			safeWidth,
			{
				scrollOffset: this.scrollOffset,
				height: bodyHeight,
				stickToBottom: this.stickToBottom,
			},
			{
				tui: this.tui,
				theme: this.theme,
				expanded: this.expanded,
			},
		);
		this.scrollOffset = viewport.scrollOffset;
		this.lastTotalLines = viewport.totalLines;
		this.lastBodyHeight = bodyHeight;
		this.lastBodyTopRow = header.length;
		this.lastRenderScrollOffset = viewport.scrollOffset;
		this.lastBodyLines = viewport.lines.slice(0, bodyHeight);
		const visibleBody = this.renderSelection(viewport.lines.slice());
		while (visibleBody.length < bodyHeight) visibleBody.push("");
		return this.padToHeight([...header, ...visibleBody, ...footer], safeWidth, height);
	}

	handleInput(data: string): void {
		const mouseEvent = parseMouseEvent(data);
		if (mouseEvent) {
			this.handleMouseEvent(mouseEvent);
			return;
		}

		const wheelDelta = parseMouseWheelDelta(data);
		if (wheelDelta !== undefined) {
			this.scrollBy(wheelDelta);
			return;
		}

		if (matchesKey(data, "ctrl+c")) {
			this.copySelection();
			return;
		}

		if (matchesKey(data, "ctrl+shift+o") || matchesKey(data, "alt+o") || matchesKey(data, Key.escape) || data === "q") {
			this.done();
			return;
		}
		if (matchesKey(data, "ctrl+o")) {
			this.expanded = !this.expanded;
			this.clearSelection();
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
			this.scrollOffset = this.getMaxScroll();
			this.stickToBottom = true;
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		this.transcriptView.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		if (this.copyNoticeTimer) {
			clearTimeout(this.copyNoticeTimer);
			this.copyNoticeTimer = undefined;
		}
		this.disableMouseReporting();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private scheduleRender(): void {
		if (this.disposed || this.renderTimer) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (!this.disposed) this.tui.requestRender();
		}, 33);
	}

	private selectRelative(delta: number): void {
		const runs = this.registry.getRunsSortedByStartTime();
		if (runs.length === 0) return;
		if (this.selectedIndex < 0) this.selectedIndex = runs.length - 1;
		this.selectedIndex = (this.selectedIndex + delta + runs.length) % runs.length;
		this.scrollOffset = 0;
		this.stickToBottom = true;
		this.clearSelection();
		this.transcriptView.invalidate();
		this.tui.requestRender();
	}

	private scrollBy(delta: number): void {
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, this.getMaxScroll()));
		this.stickToBottom = false;
		this.tui.requestRender();
	}

	private getMaxScroll(): number {
		return Math.max(0, this.lastTotalLines - this.lastBodyHeight);
	}

	private handleMouseEvent(event: ParsedMouseEvent): void {
		if (event.kind === "wheel") {
			if (event.wheelDelta !== undefined) this.scrollBy(event.wheelDelta);
			return;
		}

		if (event.kind === "down") {
			const point = this.mousePointToSelectionPoint(event);
			if (!point) return;
			this.selectionStart = point;
			this.selectionEnd = point;
			this.selectedText = undefined;
			this.selectedPlainText = undefined;
			this.isSelecting = true;
			this.selectionMoved = false;
			this.tui.requestRender();
			return;
		}

		if (event.kind === "drag") {
			if (!this.isSelecting || !this.selectionStart) return;
			const point = this.mousePointToSelectionPoint(event, true);
			if (!point) return;
			this.selectionEnd = point;
			this.selectionMoved = this.selectionMoved || !selectionPointsEqual(this.selectionStart, point);
			this.updateSelectedRange();
			this.tui.requestRender();
			return;
		}

		if (event.kind === "up") {
			if (!this.isSelecting || !this.selectionStart) return;
			const point = this.mousePointToSelectionPoint(event, true);
			if (point) {
				this.selectionEnd = point;
				this.selectionMoved = this.selectionMoved || !selectionPointsEqual(this.selectionStart, point);
			}
			if (this.selectionMoved) this.updateSelectedRange();
			else this.clearSelection();
			this.isSelecting = false;
			this.tui.requestRender();
		}
	}

	private mousePointToSelectionPoint(event: ParsedMouseEvent, clampBodyRow = false): SelectionPoint | undefined {
		let bodyRow = event.row - 1 - this.lastBodyTopRow;
		if (clampBodyRow) bodyRow = Math.max(0, Math.min(bodyRow, this.lastBodyHeight - 1));
		if (bodyRow < 0 || bodyRow >= this.lastBodyHeight) return undefined;
		const col = Math.max(0, Math.min(event.col - 1, this.lastWidth - 1));
		return { row: this.lastRenderScrollOffset + bodyRow, col };
	}

	private updateSelectedRange(): void {
		const range = this.getNormalizedSelectionRange();
		if (!range || compareSelectionPoints(range.start, range.end) >= 0) {
			this.selectedText = undefined;
			this.selectedPlainText = undefined;
			return;
		}
		this.selectedText = range;
		this.selectedPlainText = this.extractSelectedText(range);
	}

	private getNormalizedSelectionRange(): SelectionRange | undefined {
		if (!this.selectionStart || !this.selectionEnd) return undefined;
		const forward = compareSelectionPoints(this.selectionStart, this.selectionEnd) <= 0;
		const start = forward ? this.selectionStart : this.selectionEnd;
		const endBase = forward ? this.selectionEnd : this.selectionStart;
		return {
			start: { row: start.row, col: start.col },
			end: { row: endBase.row, col: Math.min(this.lastWidth, endBase.col + 1) },
		};
	}

	private renderSelection(lines: string[]): string[] {
		const range = this.selectedText;
		if (!range) return lines;
		return lines.map((line, index) => {
			const row = this.lastRenderScrollOffset + index;
			const lineRange = this.getLineSelectionRange(row, range, line);
			if (!lineRange) return line;
			return this.highlightLineSelection(line, lineRange.startCol, lineRange.endCol);
		});
	}

	private getLineSelectionRange(
		row: number,
		range: SelectionRange,
		line: string,
	): { startCol: number; endCol: number } | undefined {
		if (row < range.start.row || row > range.end.row) return undefined;
		const lineWidth = visibleWidth(stripAnsi(line));
		const startCol = row === range.start.row ? range.start.col : 0;
		const endCol = row === range.end.row ? range.end.col : lineWidth;
		const clampedStart = Math.max(0, Math.min(startCol, lineWidth));
		const clampedEnd = Math.max(0, Math.min(endCol, lineWidth));
		if (clampedEnd <= clampedStart) return undefined;
		return { startCol: clampedStart, endCol: clampedEnd };
	}

	private highlightLineSelection(line: string, startCol: number, endCol: number): string {
		const plain = stripAnsi(line);
		const prefix = slicePlainByCells(plain, 0, startCol);
		const selected = slicePlainByCells(plain, startCol, endCol);
		const suffix = slicePlainByCells(plain, endCol, visibleWidth(plain));
		return prefix + this.theme.bg("selectedBg", selected) + suffix;
	}

	private extractSelectedText(range: SelectionRange = this.selectedText!): string | undefined {
		if (!range) return undefined;
		const parts: string[] = [];
		for (let row = range.start.row; row <= range.end.row; row++) {
			const lineIndex = row - this.lastRenderScrollOffset;
			if (lineIndex < 0 || lineIndex >= this.lastBodyLines.length) return this.selectedPlainText;
			const plain = stripAnsi(this.lastBodyLines[lineIndex] ?? "");
			const lineWidth = visibleWidth(plain);
			const startCol = row === range.start.row ? Math.max(0, Math.min(range.start.col, lineWidth)) : 0;
			const endCol = row === range.end.row ? Math.max(0, Math.min(range.end.col, lineWidth)) : lineWidth;
			parts.push(slicePlainByCells(plain, startCol, endCol));
		}
		return parts.join("\n");
	}

	private copySelection(): void {
		const text = this.selectedPlainText ?? this.extractSelectedText();
		if (!this.selectedText || !text) return;
		const encoded = Buffer.from(text).toString("base64");
		if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
			this.showCopyNotice("Selection too large to copy", "warning");
			return;
		}
		process.stdout.write(`\x1b]52;c;${encoded}\x07`);
		this.showCopyNotice(`Copied ${[...text].length} characters`, "success");
	}

	private showCopyNotice(message: string, color: "success" | "warning" | "error"): void {
		this.copyNotice = { message, color };
		if (this.copyNoticeTimer) clearTimeout(this.copyNoticeTimer);
		this.copyNoticeTimer = setTimeout(() => {
			this.copyNotice = undefined;
			this.copyNoticeTimer = undefined;
			if (!this.disposed) this.tui.requestRender();
		}, 2000);
		this.tui.requestRender();
	}

	private clearSelection(): void {
		this.selectedText = undefined;
		this.selectionStart = undefined;
		this.selectionEnd = undefined;
		this.selectedPlainText = undefined;
		this.isSelecting = false;
		this.selectionMoved = false;
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
			"←/→ agent · ↑/↓ scroll · drag select · Ctrl+C copy · Ctrl+O expand · Alt+O/Esc/q back",
		);
		return [top, truncateToWidth(title, width), truncateToWidth(ctx, width), truncateToWidth(help, width), top];
	}

	private renderFooter(width: number): string[] {
		const state = this.expanded ? "expanded" : "collapsed";
		const line = this.theme.fg("borderAccent", "─".repeat(Math.max(0, width)));
		const notice = this.copyNotice ? ` · ${this.theme.fg(this.copyNotice.color, this.copyNotice.message)}` : "";
		return [line, truncateToWidth(`${this.theme.fg("dim", `View: ${state}`)}${notice}`, width)];
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
