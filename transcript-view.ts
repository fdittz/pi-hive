import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderPlainTranscript } from "./compatibility.js";
import { TranscriptAdapter } from "./transcript-adapter.js";
import type { SubagentRunRecord } from "./transcript-types.js";

export interface TranscriptViewOptions {
	tui: TUI;
	theme: Theme;
	expanded: boolean;
	showImages?: boolean;
	imageWidthCells?: number;
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
}

export class TranscriptView {
	private cachedKey: string | undefined;
	private cachedLines: string[] = [];

	renderRun(run: SubagentRunRecord, width: number, options: TranscriptViewOptions): string[] {
		const events = run.liveEvents.length > 0 ? run.liveEvents : run.replayEvents;
		const key = [
			run.id,
			run.status,
			events.length,
			run.transcriptRef?.sha256 ?? "no-ref",
			run.transcriptStorageError ?? "no-storage-error",
			options.expanded ? "expanded" : "collapsed",
			width,
		].join("|");
		if (this.cachedKey === key) return this.cachedLines;

		let lines: string[];
		try {
			const adapter = new TranscriptAdapter({
				tui: options.tui,
				cwd: run.cwd || process.cwd(),
				expanded: options.expanded,
				showImages: options.showImages ?? true,
				imageWidthCells: options.imageWidthCells ?? 60,
				hideThinkingBlock: options.hideThinkingBlock ?? false,
				hiddenThinkingLabel: options.hiddenThinkingLabel ?? "Thinking...",
			});
			for (const event of events) adapter.consume(event);
			if (adapter.hasFailed()) throw new Error("Native adapter failed");
			lines = adapter.render(width);
			if (lines.length === 0) lines = renderPlainTranscript(run, options.theme);
		} catch {
			lines = renderPlainTranscript(run, options.theme);
		}

		this.cachedKey = key;
		this.cachedLines = this.wrapLines(lines, Math.max(1, width));
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedKey = undefined;
		this.cachedLines = [];
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
