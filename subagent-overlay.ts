import { CustomEditor, FooterComponent, getSelectListTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { colorAgentText } from "./agent-colors.js";
import type { LiveSubagentRegistry } from "./live-registry.js";
import { createFooterDataAdapter, createFooterSessionAdapter, type SubagentOverlayHostContext } from "./subagent-overlay-context.js";
import { TranscriptView } from "./transcript-view.js";
import { formatRunLabel, getRunShortId, type SubagentRunRecord } from "./transcript-types.js";

function statusIcon(status: string): string {
	switch (status) {
		case "running":
			return "⏳";
		case "cancelling":
			return "⏹";
		case "done":
		case "completed":
			return "✓";
		case "aborted":
		case "cancelled":
			return "⏹";
		default:
			return "✗";
	}
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m`;
}

function elapsedMs(run: SubagentRunRecord, preferCancelTime = false): number {
	const end = preferCancelTime && run.cancelRequestedAt ? run.cancelRequestedAt : (run.endedAt ?? Date.now());
	return Math.max(0, end - run.startedAt);
}

function isLiveStatus(status: string): boolean {
	return status === "running" || status === "cancelling";
}

function canCancelStatus(status: string): boolean {
	return status === "running" || status === "cancelling";
}

function shortCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function formatKeyText(key: string): string {
	return key
		.split("+")
		.map((part) => {
			if (part === "ctrl") return "Ctrl";
			if (part === "alt") return "Alt";
			if (part === "shift") return "Shift";
			if (part === "super") return "Super";
			if (part === "pageUp") return "PgUp";
			if (part === "pageDown") return "PgDn";
			return part.length === 1 ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
		})
		.join("+");
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
	private footer: FooterComponent;
	private selectedText?: SelectionRange;
	private selectionStart?: SelectionPoint;
	private selectionEnd?: SelectionPoint;
	private selectedPlainText?: string;
	private isSelecting = false;
	private selectionMoved = false;
	private copyNotice?: { message: string; color: "success" | "warning" | "error" };
	private copyNoticeTimer?: ReturnType<typeof setTimeout>;
	private cancelRequestedRunId?: string;
	private cancelConfirmationRunId?: string;
	private notifiedCancelledRunIds = new Set<string>();
	private cancelCloseTimer?: ReturnType<typeof setTimeout>;
	private cancelCloseTriggered = false;
	private editorsByRunId = new Map<string, CustomEditor>();
	private inputHistoryByRunId = new Map<string, string[]>();
	private unsubscribe?: () => void;
	private renderTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private done: () => void,
		private registry: LiveSubagentRegistry,
		private host: SubagentOverlayHostContext,
		private initialRunId?: string,
		private onCancelledRun?: (runId: string) => void,
	) {
		this.footer = new FooterComponent(createFooterSessionAdapter(this.host), createFooterDataAdapter(this.host));
		this.enableMouseReporting();
		this.setTextCursor();
		this.unsubscribe = registry.subscribe(() => {
			this.scheduleRender();
			this.maybeCloseAfterCancelledRun();
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
		const statusLines = this.renderStatusLine(run, safeWidth);
		let pendingLines = this.renderPendingMessages(run, safeWidth);
		const footer = this.renderFooter(safeWidth);
		const rawInputLines = this.renderInputEditor(run, safeWidth);
		const maxInputLines = Math.max(0, height - header.length - pendingLines.length - statusLines.length - footer.length - 1);
		const inputLines = rawInputLines.slice(0, maxInputLines);
		const maxPendingLines = Math.max(0, height - header.length - statusLines.length - inputLines.length - footer.length - 1);
		pendingLines = pendingLines.slice(0, maxPendingLines);
		const bodyHeight = Math.max(1, height - header.length - pendingLines.length - statusLines.length - inputLines.length - footer.length);
		const viewport = this.transcriptView.renderRunViewport(
			run,
			safeWidth,
			{
				scrollOffset: this.scrollOffset,
				height: bodyHeight,
				stickToBottom: isLiveStatus(run.status) && this.stickToBottom,
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
		return this.padToHeight([...header, ...visibleBody, ...pendingLines, ...statusLines, ...inputLines, ...footer], safeWidth, height);
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

		if (this.shouldCloseAfterCancel()) return;

		const run = this.getSelectedRun();
		const editor = run && isLiveStatus(run.status) ? this.getEditorForRun(run) : undefined;
		const hasInputController = Boolean(run && this.registry.getInputController(run.id));
		const editorHasText = Boolean(editor && editor.getText().length > 0);
		const confirmCancelWithCtrlC = matchesKey(data, "ctrl+c") && (!this.selectedText || this.cancelConfirmationRunId === run?.id);
		const confirmCancelWithX = !hasInputController && (matchesKey(data, "x") || data === "X");
		if ((confirmCancelWithX || confirmCancelWithCtrlC) && run && canCancelStatus(run.status)) {
			this.cancelSelectedRun();
			return;
		}

		if (this.cancelConfirmationRunId) {
			this.cancelConfirmationRunId = undefined;
			this.scheduleRender();
			return;
		}

		if (matchesKey(data, "ctrl+c")) {
			if (this.selectedText) this.copySelection();
			return;
		}

		if (matchesKey(data, "ctrl+shift+o") || matchesKey(data, "alt+o") || matchesKey(data, Key.escape) || (!hasInputController && data === "q")) {
			this.done();
			return;
		}
		if (matchesKey(data, "ctrl+o")) {
			this.expanded = !this.expanded;
			this.clearSelection();
			this.tui.requestRender();
			return;
		}
		if (editor && this.matchesFollowUp(data)) {
			void this.submitEditorText("followUp", run);
			return;
		}
		if (editor && this.matchesMessageSubmit(data) && !editor.isShowingAutocomplete()) {
			void this.submitEditorText("steer", run);
			return;
		}
		if (this.matchesDequeue(data)) {
			if (run) void this.dequeueInput(run);
			return;
		}
		if (matchesKey(data, Key.left) && !editorHasText) {
			this.selectRelative(-1);
			return;
		}
		if (matchesKey(data, Key.right) && !editorHasText) {
			this.selectRelative(1);
			return;
		}
		if (matchesKey(data, Key.up) && !this.shouldRouteVerticalToEditor(run, editor)) {
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(data, Key.down) && !this.shouldRouteVerticalToEditor(run, editor)) {
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
		if (matchesKey(data, Key.home) && !editorHasText) {
			this.scrollOffset = 0;
			this.stickToBottom = false;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.end) && !editorHasText) {
			this.scrollOffset = this.getMaxScroll();
			this.stickToBottom = true;
			this.tui.requestRender();
			return;
		}

		if (editor) {
			this.clearSelection();
			editor.handleInput(data);
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		this.transcriptView.invalidate();
		this.footer.invalidate();
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
		if (this.cancelCloseTimer) {
			clearTimeout(this.cancelCloseTimer);
			this.cancelCloseTimer = undefined;
		}
		this.disableMouseReporting();
		this.restoreCursor();
		this.footer.dispose();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private getEditorForRun(run: SubagentRunRecord): CustomEditor {
		let editor = this.editorsByRunId.get(run.id);
		if (!editor) {
			editor = new CustomEditor(
				this.tui,
				{
					borderColor: (text: string) => colorAgentText(this.theme, run.agentColor, text, "borderAccent"),
					selectList: getSelectListTheme(),
				},
				this.keybindings,
				{ paddingX: 1 },
			);
			editor.onSubmit = (text) => {
				void this.submitInputText("steer", run, text, editor!);
			};
			this.editorsByRunId.set(run.id, editor);
		}
		return editor;
	}

	private renderInputEditor(run: SubagentRunRecord, width: number): string[] {
		if (!isLiveStatus(run.status)) {
			for (const candidate of this.editorsByRunId.values()) candidate.focused = false;
			return [];
		}
		const editor = this.getEditorForRun(run);
		for (const candidate of this.editorsByRunId.values()) candidate.focused = candidate === editor;
		editor.disableSubmit = !this.registry.getInputController(run.id);
		return editor.render(width);
	}

	private matchesFollowUp(data: string): boolean {
		return this.keybindings.matches(data, "app.message.followUp");
	}

	private matchesMessageSubmit(data: string): boolean {
		return this.matchesOptionalAppKey(data, "app.message.submit") || matchesKey(data, Key.enter) || matchesKey(data, Key.return);
	}

	private matchesDequeue(data: string): boolean {
		return this.keybindings.matches(data, "app.message.dequeue") || matchesKey(data, Key.alt("up"));
	}

	private matchesOptionalAppKey(data: string, keybinding: string): boolean {
		const matches = this.keybindings.matches as (data: string, keybinding: string) => boolean;
		return matches.call(this.keybindings, data, keybinding);
	}

	private keyText(keybinding: string, fallback: string): string {
		const getKeys = this.keybindings.getKeys as (keybinding: string) => string[];
		const [first] = getKeys.call(this.keybindings, keybinding);
		return first ? formatKeyText(first) : fallback;
	}

	private shouldRouteVerticalToEditor(run: SubagentRunRecord | undefined, editor: CustomEditor | undefined): boolean {
		if (!run || !editor) return false;
		if (editor.getText().length > 0) return true;
		return (this.inputHistoryByRunId.get(run.id)?.length ?? 0) > 0;
	}

	private rememberInput(runId: string, text: string, editor: CustomEditor): void {
		editor.addToHistory(text);
		const history = this.inputHistoryByRunId.get(runId) ?? [];
		history.push(text);
		if (history.length > 50) history.splice(0, history.length - 50);
		this.inputHistoryByRunId.set(runId, history);
	}

	private async submitEditorText(kind: "steer" | "followUp", run: SubagentRunRecord): Promise<void> {
		const editor = this.getEditorForRun(run);
		const text = editor.getExpandedText().trim();
		if (!text) return;
		editor.setText("");
		await this.submitInputText(kind, run, text, editor);
	}

	private async submitInputText(kind: "steer" | "followUp", run: SubagentRunRecord, text: string, editor: CustomEditor): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.rememberInput(run.id, trimmed, editor);
		this.clearSelection();
		this.stickToBottom = true;
		this.scrollOffset = this.getMaxScroll();
		this.tui.requestRender();

		const controller = this.registry.getInputController(run.id);
		if (!controller) {
			this.showCopyNotice("Input unavailable for this run", "warning");
			return;
		}

		try {
			if (kind === "steer") await controller.steer(trimmed);
			else await controller.followUp(trimmed);
			this.showCopyNotice(kind === "steer" ? "Steering sent" : "Follow-up queued", "success");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showCopyNotice(`Input failed: ${message}`, "error");
		}
	}

	private async dequeueInput(run: SubagentRunRecord): Promise<void> {
		const controller = this.registry.getInputController(run.id);
		if (!controller?.dequeue) {
			this.showCopyNotice("Input unavailable for this run", "warning");
			return;
		}

		try {
			const result = await controller.dequeue();
			const queuedMessages = [...result.steering, ...result.followUp].filter((message) => message.trim().length > 0);
			if (queuedMessages.length === 0) {
				this.showCopyNotice("No queued messages to restore", "warning");
				return;
			}

			const editor = this.getEditorForRun(run);
			const queuedText = queuedMessages.join("\n\n");
			const currentText = editor.getText();
			const combinedText = [queuedText, currentText].filter((text) => text.trim()).join("\n\n");
			editor.setText(combinedText);
			this.clearSelection();
			this.stickToBottom = true;

			if (result.usedLocalFallback) {
				this.showCopyNotice(`Restored ${queuedMessages.length} - Using local queue (child Pi RPC doesn't support dequeue yet)`, "warning");
			} else {
				this.showCopyNotice(`Restored ${queuedMessages.length} queued message${queuedMessages.length > 1 ? "s" : ""} to editor`, "success");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showCopyNotice(`Dequeue failed: ${message}`, "error");
		}
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
		this.cancelConfirmationRunId = undefined;
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

	private getSelectedRun(): SubagentRunRecord | undefined {
		const runs = this.registry.getRunsSortedByStartTime();
		if (runs.length === 0) return undefined;
		const index = this.selectedIndex < 0 ? runs.length - 1 : Math.max(0, Math.min(this.selectedIndex, runs.length - 1));
		return runs[index];
	}

	private shouldCloseAfterCancel(): boolean {
		return this.maybeCloseAfterCancelledRun();
	}

	private maybeCloseAfterCancelledRun(): boolean {
		if (!this.cancelRequestedRunId || this.cancelCloseTriggered) return false;
		const run = this.registry.getRun(this.cancelRequestedRunId);
		if (!run || run.status === "running" || run.status === "cancelling") return false;
		this.cancelCloseTriggered = true;
		if (this.cancelCloseTimer) {
			clearTimeout(this.cancelCloseTimer);
			this.cancelCloseTimer = undefined;
		}
		this.notifyCancelledRun(run.id);
		this.done();
		return true;
	}

	private notifyCancelledRun(runId: string): void {
		if (this.notifiedCancelledRunIds.has(runId)) return;
		this.notifiedCancelledRunIds.add(runId);
		try {
			this.onCancelledRun?.(runId);
		} catch {
			/* keep overlay input handling resilient to callback errors */
		}
	}

	private cancelSelectedRun(): void {
		const run = this.getSelectedRun();
		if (!run) return;
		if (run.status === "cancelling") {
			this.cancelConfirmationRunId = undefined;
			this.showCopyNotice("Already cancelling...", "warning");
			return;
		}
		if (run.status !== "running") {
			this.cancelConfirmationRunId = undefined;
			this.showCopyNotice("Only running agents can be cancelled", "warning");
			return;
		}

		if (this.cancelConfirmationRunId !== run.id) {
			this.cancelConfirmationRunId = run.id;
			this.scheduleRender();
			return;
		}

		const cancelled = this.registry.cancelRun(run.id);
		this.cancelConfirmationRunId = undefined;
		if (cancelled) {
			this.cancelRequestedRunId = run.id;
			this.cancelCloseTriggered = false;
			this.scheduleCloseAfterCancel(run.id);
			this.clearSelection();
			this.stickToBottom = true;
			this.transcriptView.invalidate();
		}
		this.showCopyNotice(cancelled ? "Cancelling..." : "Unable to cancel this run", cancelled ? "warning" : "error");
		this.tui.requestRender();
	}

	private scheduleCloseAfterCancel(runId: string): void {
		if (this.cancelCloseTimer) clearTimeout(this.cancelCloseTimer);
		this.cancelCloseTimer = setTimeout(() => {
			this.cancelCloseTimer = undefined;
			if (!this.disposed && this.cancelRequestedRunId === runId) this.maybeCloseAfterCancelledRun();
		}, 3000);
		(this.cancelCloseTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
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

	private setTextCursor(): void {
		process.stdout.write("\x1b[5 q");
	}

	private restoreCursor(): void {
		process.stdout.write("\x1b[ q");
	}

	private renderHeader(run: SubagentRunRecord, total: number, width: number): string[] {
		const borderColor = run.agentColor || "borderAccent";
		const top = colorAgentText(this.theme, borderColor, "─".repeat(Math.max(0, width)), "borderAccent");
		const runLabel = formatRunLabel(run.agent, run.id);
		const agentName = this.theme.bold(colorAgentText(this.theme, run.agentColor, runLabel, "toolTitle"));
		const statusText = this.renderStatusText(run);
		const title = `${this.theme.bold(this.theme.fg("accent", "Subagents"))} ${this.theme.fg("muted", `${this.selectedIndex + 1}/${total}`)} ${statusIcon(run.status)} ${statusText} ${agentName} ${this.theme.fg("muted", `[${run.mode}]`)} ${run.model ? this.theme.fg("dim", run.model) : ""}`;
		const elapsed = formatDuration(elapsedMs(run, (run.status === "aborted" || run.status === "cancelled") && Boolean(run.cancelRequestedAt)));
		const displayId = run.id.startsWith("bg_") ? run.id : getRunShortId(run.id);
		const ctx = `${this.theme.fg("muted", "id:")} ${this.theme.fg("dim", displayId)} ${this.theme.fg("muted", "elapsed:")} ${this.theme.fg("dim", elapsed)} ${this.theme.fg("muted", "cwd:")} ${this.theme.fg("dim", shortCwd(run.cwd || process.cwd()))}`;
		const submitKey = this.keyText("app.message.submit", this.keyText("tui.input.submit", "Enter"));
		const followUpKey = this.keyText("app.message.followUp", "Alt+Enter");
		const newLineKey = this.keyText("tui.input.newLine", "Shift+Enter");
		const helpText = isLiveStatus(run.status)
			? `${submitKey} steer · ${followUpKey} follow-up · ${newLineKey} newline · PgUp/PgDn scroll · Ctrl+C cancel · Ctrl+O expand · Alt+O/Esc back`
			: "←/→ agent · ↑/↓ scroll · drag select · Ctrl+C copy · Alt+O/Esc/q back";
		const help = this.theme.fg("dim", helpText);
		return [top, truncateToWidth(title, width), truncateToWidth(ctx, width), truncateToWidth(help, width), top];
	}

	private renderStatusText(run: SubagentRunRecord): string {
		switch (run.status) {
			case "running":
				return this.theme.fg("warning", "Running");
			case "cancelling":
				return this.theme.fg("warning", "Cancelling...");
			case "done":
				return this.theme.fg("success", "Done");
			case "completed":
				return this.theme.fg("success", "Completed");
			case "aborted":
			case "cancelled":
				return this.theme.fg("warning", "Cancelled (partial result)");
			default:
				return this.theme.fg("error", "Failed");
		}
	}

	private renderPendingMessages(run: SubagentRunRecord, width: number): string[] {
		const steeringMessages = run.pendingSteeringMessageTexts ?? [];
		const followUpMessages = run.pendingFollowUpMessageTexts ?? [];
		if (steeringMessages.length === 0 && followUpMessages.length === 0) return [];

		const lines = [""];
		const renderMessage = (label: string, message: string) => {
			const compactMessage = message.replace(/\s+/g, " ").trim();
			return truncateToWidth(this.theme.fg("dim", `${label}: ${compactMessage}`), width);
		};
		for (const message of steeringMessages) lines.push(renderMessage("Steering", message));
		for (const message of followUpMessages) lines.push(renderMessage("Follow-up", message));
		const dequeueKey = this.keyText("app.message.dequeue", "Alt+Up");
		lines.push(truncateToWidth(this.theme.fg("dim", `↳ ${dequeueKey} to edit queued messages`), width));
		return lines;
	}

	private renderStatusLine(run: SubagentRunRecord, width: number): string[] {
		const state = this.expanded ? "expanded" : "collapsed";
		const notice = this.copyNotice ? ` · ${this.theme.fg(this.copyNotice.color, this.copyNotice.message)}` : "";
		const pendingParts: string[] = [];
		if (run.pendingSteeringMessages) pendingParts.push(`${run.pendingSteeringMessages} steering`);
		if (run.pendingFollowUpMessages) pendingParts.push(`${run.pendingFollowUpMessages} follow-up`);
		if (!pendingParts.length && run.pendingInputMessages) pendingParts.push(`${run.pendingInputMessages} queued`);
		const pending = pendingParts.length ? ` · ${this.theme.fg("warning", `queued: ${pendingParts.join(", ")}`)}` : "";
		const submitKey = this.keyText("app.message.submit", this.keyText("tui.input.submit", "Enter"));
		const followUpKey = this.keyText("app.message.followUp", "Alt+Enter");
		const inputState = isLiveStatus(run.status)
			? this.theme.fg("dim", `Input: ${submitKey} steer · ${followUpKey} follow-up`)
			: this.theme.fg("dim", "Input hidden for terminal run");
		const inputError = run.inputErrorMessage ? ` · ${this.theme.fg("error", run.inputErrorMessage)}` : "";
		let status = `${this.theme.fg("dim", run.resultOutput !== undefined ? "View: full result" : `View: ${state}`)} · ${inputState}${pending}${inputError}${notice}`;
		if (this.cancelConfirmationRunId === run.id) {
			status = this.theme.fg(
				"warning",
				"⚠️ Confirm cancel? Press Ctrl+C again to cancel (or any other key to dismiss)",
			);
		} else if (run.status === "cancelling") {
			status = `${this.theme.fg("warning", `Cancelling... elapsed ${formatDuration(elapsedMs(run))}`)}${notice}`;
		} else if ((run.status === "aborted" || run.status === "cancelled") && run.id === this.cancelRequestedRunId) {
			status = `${this.theme.fg("warning", `Cancelled after ${formatDuration(elapsedMs(run, true))}`)} ${this.theme.fg("dim", "- Press any key to close")}`;
		}
		return [truncateToWidth(status, width)];
	}

	private renderFooter(width: number): string[] {
		return this.footer.render(width);
	}

	private renderEmpty(width: number, height: number): string[] {
		const line = this.theme.fg("borderAccent", "─".repeat(Math.max(0, width)));
		const footer = this.renderFooter(width);
		const lines = [
			line,
			truncateToWidth(this.theme.bold(this.theme.fg("accent", "Subagents")), width),
			truncateToWidth(this.theme.fg("muted", "No subagent runs found in this session yet."), width),
			truncateToWidth(this.theme.fg("dim", "Esc, Alt+O, or q to return."), width),
			line,
		];
		const filler = Array.from({ length: Math.max(0, height - lines.length - footer.length) }, () => "");
		return this.padToHeight([...lines, ...filler, ...footer], width, height);
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
