import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderPlainTranscript } from "./compatibility.js";
import { TranscriptAdapter } from "./transcript-adapter.js";
import type { StoredTranscriptEvent, SubagentRunRecord } from "./transcript-types.js";

export interface TranscriptViewOptions {
	tui: TUI;
	theme: Theme;
	expanded: boolean;
	showImages?: boolean;
	imageWidthCells?: number;
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
}

type EventSource = "live" | "replay";

interface SelectedEvents {
	events: StoredTranscriptEvent[];
	source: EventSource;
}

interface IncrementalState {
	adapter: TranscriptAdapter;
	adapterKey: string;
	tui: TUI;
	events: StoredTranscriptEvent[];
	eventSource: EventSource;
	consumedCount: number;
	consumedRefs: StoredTranscriptEvent[];
	observedRevision: number;
	expanded: boolean;
	nativeFailed: boolean;
}

export class TranscriptView {
	private state?: IncrementalState;
	private cachedRenderKey: string | undefined;
	private cachedLines: string[] = [];

	renderRun(run: SubagentRunRecord, width: number, options: TranscriptViewOptions): string[] {
		const safeWidth = Math.max(1, width);
		const selected = this.selectEvents(run);
		const adapterKey = this.buildAdapterKey(run, options);
		const revision = run.revision ?? 0;
		const preRenderKey = this.buildRenderKey(run, selected, adapterKey, safeWidth, options, this.state?.nativeFailed ?? false);
		if (this.cachedRenderKey === preRenderKey) return this.cachedLines;

		const state = this.ensureState(run, selected, adapterKey, options);
		let lines: string[];

		if (!state.nativeFailed) {
			try {
				this.applyExpanded(state, options.expanded);
				this.consumeIncremental(state, selected.events, revision);
				if (state.adapter.hasFailed()) throw new Error("Native adapter failed");
				lines = state.adapter.render(safeWidth);
				if (lines.length === 0) lines = renderPlainTranscript(run, options.theme);
			} catch {
				state.nativeFailed = true;
				lines = renderPlainTranscript(run, options.theme);
			}
		} else {
			lines = renderPlainTranscript(run, options.theme);
		}

		const renderKey = this.buildRenderKey(run, selected, adapterKey, safeWidth, options, state.nativeFailed);
		this.cachedRenderKey = renderKey;
		this.cachedLines = this.wrapLines(lines, safeWidth);
		return this.cachedLines;
	}

	invalidate(): void {
		this.state = undefined;
		this.cachedRenderKey = undefined;
		this.cachedLines = [];
	}

	private selectEvents(run: SubagentRunRecord): SelectedEvents {
		if (run.liveEvents.length > 0) return { events: run.liveEvents, source: "live" };
		return { events: run.replayEvents, source: "replay" };
	}

	private buildAdapterKey(run: SubagentRunRecord, options: TranscriptViewOptions): string {
		return [
			run.id,
			run.cwd || process.cwd(),
			options.showImages ?? true,
			options.imageWidthCells ?? 60,
			options.hideThinkingBlock ?? false,
			options.hiddenThinkingLabel ?? "Thinking...",
		].join("|");
	}

	private buildRenderKey(
		run: SubagentRunRecord,
		selected: SelectedEvents,
		adapterKey: string,
		width: number,
		options: TranscriptViewOptions,
		nativeFailed: boolean,
	): string {
		return [
			adapterKey,
			nativeFailed ? "plain" : "native",
			selected.source,
			run.status,
			run.revision ?? 0,
			selected.events.length,
			run.transcriptRef?.sha256 ?? "no-ref",
			run.transcriptStorageError?.length ?? 0,
			run.errorMessage?.length ?? 0,
			run.stderr?.length ?? 0,
			options.expanded ? "expanded" : "collapsed",
			width,
		].join("|");
	}

	private ensureState(
		run: SubagentRunRecord,
		selected: SelectedEvents,
		adapterKey: string,
		options: TranscriptViewOptions,
	): IncrementalState {
		const state = this.state;
		const mustRebuild =
			!state ||
			state.adapterKey !== adapterKey ||
			state.tui !== options.tui ||
			state.eventSource !== selected.source ||
			state.events !== selected.events ||
			state.consumedCount > selected.events.length ||
			this.hasIncompatibleConsumedReplacement(state, selected.events);

		if (!mustRebuild && state) return state;

		const next: IncrementalState = {
			adapter: new TranscriptAdapter({
				tui: options.tui,
				cwd: run.cwd || process.cwd(),
				expanded: options.expanded,
				showImages: options.showImages ?? true,
				imageWidthCells: options.imageWidthCells ?? 60,
				hideThinkingBlock: options.hideThinkingBlock ?? false,
				hiddenThinkingLabel: options.hiddenThinkingLabel ?? "Thinking...",
			}),
			adapterKey,
			tui: options.tui,
			events: selected.events,
			eventSource: selected.source,
			consumedCount: 0,
			consumedRefs: [],
			observedRevision: -1,
			expanded: options.expanded,
			nativeFailed: false,
		};
		this.state = next;
		this.cachedRenderKey = undefined;
		return next;
	}

	private applyExpanded(state: IncrementalState, expanded: boolean): void {
		if (state.expanded === expanded) return;
		state.expanded = expanded;
		state.adapter.setExpanded(expanded);
	}

	private hasIncompatibleConsumedReplacement(state: IncrementalState | undefined, events: StoredTranscriptEvent[]): boolean {
		if (!state) return false;
		const comparableCount = Math.min(state.consumedCount, events.length);
		for (let i = 0; i < comparableCount; i++) {
			const previous = state.consumedRefs[i];
			const next = events[i];
			if (previous === next) continue;
			if (this.requiresRebuildForReplacement(previous, next)) return true;
		}
		return false;
	}

	private requiresRebuildForReplacement(previous: StoredTranscriptEvent | undefined, next: StoredTranscriptEvent | undefined): boolean {
		if (!previous || !next) return false;
		if (!this.isAssistantMessageEvent(previous) || !this.isAssistantMessageEvent(next)) return false;
		return this.toolCallSignature(previous) !== this.toolCallSignature(next);
	}

	private isAssistantMessageEvent(event: StoredTranscriptEvent): boolean {
		if (event.type !== "message_update" && event.type !== "message_end") return false;
		return (event.message as any)?.role === "assistant";
	}

	private toolCallSignature(event: StoredTranscriptEvent): string {
		const content = (event.message as any)?.content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((part) => part?.type === "toolCall")
			.map((part) => `${String(part.id ?? "")}:${String(part.name ?? "")}`)
			.join("|");
	}

	private consumeIncremental(state: IncrementalState, events: StoredTranscriptEvent[], revision: number): void {
		if (revision !== state.observedRevision) {
			const comparableCount = Math.min(state.consumedCount, events.length);
			for (let i = 0; i < comparableCount; i++) {
				const event = events[i];
				if (event === state.consumedRefs[i]) continue;
				state.adapter.consume(event);
				state.consumedRefs[i] = event;
				if (state.adapter.hasFailed()) break;
			}
		}

		if (!state.adapter.hasFailed() && events.length > state.consumedCount) {
			const startIndex = state.consumedCount;
			const consumed = state.adapter.consumeMany(events, startIndex);
			for (let i = startIndex; i < startIndex + consumed; i++) {
				state.consumedRefs[i] = events[i];
			}
			state.consumedCount += consumed;
		}

		state.consumedRefs.length = state.consumedCount;
		state.observedRevision = revision;
	}

	private wrapLines(lines: string[], width: number): string[] {
		const wrapped: string[] = [];
		for (const line of lines) {
			const parts = wrapTextWithAnsi(line, width);
			if (parts.length === 0) wrapped.push("");
			else wrapped.push(...parts);
		}
		return wrapped;
	}
}
