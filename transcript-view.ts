import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderPlainTranscript } from "./compatibility.js";
import { TranscriptAdapter } from "./transcript-adapter.js";
import type { StoredTranscriptEvent, SubagentRunRecord, TranscriptEventMutation } from "./transcript-types.js";

export interface TranscriptViewOptions {
	tui: TUI;
	theme: Theme;
	expanded: boolean;
	showImages?: boolean;
	imageWidthCells?: number;
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
}

export interface TranscriptViewport {
	scrollOffset: number;
	height: number;
	stickToBottom: boolean;
}

export interface TranscriptViewportResult {
	lines: string[];
	totalLines: number;
	scrollOffset: number;
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
	observedMutationSequence: number;
	expanded: boolean;
	nativeFailed: boolean;
}

export class TranscriptView {
	private state?: IncrementalState;
	private cachedRenderKey: string | undefined;
	private cachedViewport: TranscriptViewportResult | undefined;

	renderRun(run: SubagentRunRecord, width: number, options: TranscriptViewOptions): string[] {
		return this.renderRunViewport(
			run,
			width,
			{ scrollOffset: 0, height: Number.MAX_SAFE_INTEGER, stickToBottom: false },
			options,
		).lines;
	}

	renderRunViewport(
		run: SubagentRunRecord,
		width: number,
		viewport: TranscriptViewport,
		options: TranscriptViewOptions,
	): TranscriptViewportResult {
		const safeWidth = Math.max(1, Math.floor(width));
		const safeHeight = Math.max(0, Math.floor(viewport.height));
		if (run.resultOutput !== undefined) return this.renderResultOutputViewport(run, safeWidth, viewport);
		const selected = this.selectEvents(run);
		const adapterKey = this.buildAdapterKey(run, options);
		let state = this.ensureState(run, selected, adapterKey, options);

		if (!state.nativeFailed) {
			try {
				this.applyExpanded(state, options.expanded);
				this.consumeIncremental(state, selected, run);
				if (state.adapter.hasFailed()) throw new Error("Native adapter failed");

				const renderVersion = state.adapter.getRenderVersion();
				const totalLines = state.adapter.getLineCount(safeWidth);
				if (totalLines === 0 && safeHeight > 0) {
					this.cachedRenderKey = undefined;
					this.cachedViewport = undefined;
					return this.renderPlainViewport(run, safeWidth, viewport, options);
				}

				const scrollOffset = this.resolveScrollOffset(viewport, totalLines, safeHeight);
				const renderKey = this.buildRenderKey(
					run,
					selected,
					adapterKey,
					safeWidth,
					safeHeight,
					scrollOffset,
					options,
					false,
					renderVersion,
				);
				if (this.cachedRenderKey === renderKey && this.cachedViewport) return this.cachedViewport;

				const viewportRender = state.adapter.renderViewport(safeWidth, scrollOffset, safeHeight);
				const result: TranscriptViewportResult = {
					lines: viewportRender.lines,
					totalLines: viewportRender.totalLines,
					scrollOffset,
				};
				this.cachedRenderKey = renderKey;
				this.cachedViewport = result;
				return result;
			} catch {
				state.nativeFailed = true;
				this.cachedRenderKey = undefined;
				this.cachedViewport = undefined;
			}
		}

		return this.renderPlainViewport(run, safeWidth, viewport, options);
	}

	invalidate(): void {
		this.state = undefined;
		this.cachedRenderKey = undefined;
		this.cachedViewport = undefined;
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
		height: number,
		scrollOffset: number,
		options: TranscriptViewOptions,
		nativeFailed: boolean,
		renderVersion: number,
	): string {
		return [
			adapterKey,
			nativeFailed ? "plain" : "native",
			selected.source,
			run.status,
			renderVersion,
			selected.events.length,
			run.transcriptRef?.sha256 ?? "no-ref",
			run.transcriptStorageError?.length ?? 0,
			run.errorMessage?.length ?? 0,
			run.stderr?.length ?? 0,
			options.expanded ? "expanded" : "collapsed",
			width,
			height,
			scrollOffset,
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
			this.hasIncompatibleConsumedReplacement(state, selected, run);

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
			observedRevision: run.revision ?? 0,
			observedMutationSequence: selected.source === "live" ? (run.liveEventMutationSequence ?? 0) : 0,
			expanded: options.expanded,
			nativeFailed: false,
		};
		this.state = next;
		this.cachedRenderKey = undefined;
		this.cachedViewport = undefined;
		return next;
	}

	private applyExpanded(state: IncrementalState, expanded: boolean): void {
		if (state.expanded === expanded) return;
		state.expanded = expanded;
		state.adapter.setExpanded(expanded);
		this.cachedRenderKey = undefined;
		this.cachedViewport = undefined;
	}

	private hasIncompatibleConsumedReplacement(
		state: IncrementalState | undefined,
		selected: SelectedEvents,
		run: SubagentRunRecord,
	): boolean {
		if (!state || state.consumedCount === 0) return false;
		const replacementIndices = this.getReplacementIndicesSince(state, selected, run);
		if (replacementIndices === undefined) return this.hasIncompatibleConsumedReplacementByFullScan(state, selected.events);

		for (const index of replacementIndices) {
			if (index < 0 || index >= state.consumedCount || index >= selected.events.length) continue;
			const previous = state.consumedRefs[index];
			const next = selected.events[index];
			if (previous === next) continue;
			if (this.requiresRebuildForReplacement(previous, next)) return true;
		}
		return false;
	}

	private hasIncompatibleConsumedReplacementByFullScan(state: IncrementalState, events: StoredTranscriptEvent[]): boolean {
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

	private consumeIncremental(state: IncrementalState, selected: SelectedEvents, run: SubagentRunRecord): void {
		const events = selected.events;
		const replacementIndices = this.getReplacementIndicesSince(state, selected, run);
		if (replacementIndices === undefined) {
			this.reconsumeChangedConsumedEventsByFullScan(state, events);
		} else {
			for (const index of replacementIndices) {
				this.reconsumeChangedEventAtIndex(state, events, index);
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
		state.observedRevision = run.revision ?? state.observedRevision;
		state.observedMutationSequence = selected.source === "live" ? (run.liveEventMutationSequence ?? state.observedMutationSequence) : 0;
	}

	private reconsumeChangedConsumedEventsByFullScan(state: IncrementalState, events: StoredTranscriptEvent[]): void {
		const comparableCount = Math.min(state.consumedCount, events.length);
		for (let i = 0; i < comparableCount; i++) {
			this.reconsumeChangedEventAtIndex(state, events, i);
			if (state.adapter.hasFailed()) break;
		}
	}

	private reconsumeChangedEventAtIndex(state: IncrementalState, events: StoredTranscriptEvent[], index: number): void {
		if (index < 0 || index >= state.consumedCount || index >= events.length) return;
		const event = events[index];
		if (event === state.consumedRefs[index]) return;
		state.adapter.consume(event);
		state.consumedRefs[index] = event;
	}

	private getReplacementIndicesSince(
		state: IncrementalState,
		selected: SelectedEvents,
		run: SubagentRunRecord,
	): number[] | undefined {
		if (selected.source !== "live") return [];

		const currentSequence = run.liveEventMutationSequence ?? 0;
		const observedSequence = state.observedMutationSequence;
		if (currentSequence === observedSequence) return [];
		if (currentSequence < observedSequence) return undefined;

		const mutations = (run.liveEventMutations ?? [])
			.filter((mutation) => mutation.sequence > observedSequence && mutation.sequence <= currentSequence)
			.sort((a, b) => a.sequence - b.sequence);
		if (!this.mutationLogIsComplete(mutations, observedSequence, currentSequence)) return undefined;

		const indices = new Set<number>();
		for (const mutation of mutations) {
			if (mutation.replaced) indices.add(mutation.index);
		}
		return [...indices].sort((a, b) => a - b);
	}

	private mutationLogIsComplete(
		mutations: TranscriptEventMutation[],
		observedSequence: number,
		currentSequence: number,
	): boolean {
		if (currentSequence === observedSequence) return true;
		if (mutations.length !== currentSequence - observedSequence) return false;
		let expected = observedSequence + 1;
		for (const mutation of mutations) {
			if (mutation.sequence !== expected) return false;
			expected++;
		}
		return true;
	}

	private resolveScrollOffset(viewport: TranscriptViewport, totalLines: number, height: number): number {
		const maxScroll = Math.max(0, totalLines - height);
		if (viewport.stickToBottom) return maxScroll;
		return Math.max(0, Math.min(Math.floor(viewport.scrollOffset), maxScroll));
	}

	private renderResultOutputViewport(
		run: SubagentRunRecord,
		width: number,
		viewport: TranscriptViewport,
	): TranscriptViewportResult {
		this.state = undefined;
		this.cachedRenderKey = undefined;
		this.cachedViewport = undefined;
		const safeHeight = Math.max(0, Math.floor(viewport.height));
		const output = run.resultOutput?.trimEnd() || "(no result captured)";
		const lines = this.wrapPlainLines(output.split(/\r?\n/), width);
		const totalLines = lines.length;
		const scrollOffset = this.resolveScrollOffset({ ...viewport, stickToBottom: false }, totalLines, safeHeight);
		return {
			lines: safeHeight > 0 ? lines.slice(scrollOffset, scrollOffset + safeHeight) : [],
			totalLines,
			scrollOffset,
		};
	}

	private renderPlainViewport(
		run: SubagentRunRecord,
		width: number,
		viewport: TranscriptViewport,
		options: TranscriptViewOptions,
	): TranscriptViewportResult {
		const safeHeight = Math.max(0, Math.floor(viewport.height));
		const lines = this.wrapPlainLines(renderPlainTranscript(run, options.theme), width);
		const totalLines = lines.length;
		const scrollOffset = this.resolveScrollOffset(viewport, totalLines, safeHeight);
		return {
			lines: safeHeight > 0 ? lines.slice(scrollOffset, scrollOffset + safeHeight) : [],
			totalLines,
			scrollOffset,
		};
	}

	private wrapPlainLines(lines: string[], width: number): string[] {
		const wrapped: string[] = [];
		for (const line of lines) {
			const parts = wrapTextWithAnsi(line, width);
			if (parts.length === 0) wrapped.push("");
			else wrapped.push(...parts);
		}
		return wrapped;
	}
}
