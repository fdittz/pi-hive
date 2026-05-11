import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TranscriptStorage } from "./transcript-storage.js";
import {
	type FinishRunInput,
	type HistoricalResultLike,
	type StartRunInput,
	type StoredTranscriptEvent,
	type SubagentRunRecord,
	statusFromExit,
	type TranscriptStorageRef,
} from "./transcript-types.js";

function safeTimestamp(value: unknown, fallback = Date.now()): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return fallback;
}

function cloneEvent(event: StoredTranscriptEvent): StoredTranscriptEvent {
	return JSON.parse(JSON.stringify(event)) as StoredTranscriptEvent;
}

function messagesToReplayEvents(messages: Message[] | undefined): StoredTranscriptEvent[] {
	if (!Array.isArray(messages)) return [];
	const events: StoredTranscriptEvent[] = [];
	for (const message of messages) {
		events.push({ type: "message_start", message });
		events.push({ type: "message_end", message });
	}
	return events;
}

function resultStartedAt(result: HistoricalResultLike, fallback: number): number {
	const firstMessage = result.messages?.[0] as { timestamp?: unknown } | undefined;
	return safeTimestamp(firstMessage?.timestamp, fallback);
}

export class LiveSubagentRegistry {
	private runs = new Map<string, SubagentRunRecord>();
	private subscribers = new Set<() => void>();

	startRun(input: StartRunInput): SubagentRunRecord {
		const id = `${input.parentToolCallId}:${input.mode}:${input.index ?? input.step ?? 0}:${input.agent}:${randomUUID()}`;
		const run: SubagentRunRecord = {
			id,
			parentToolCallId: input.parentToolCallId,
			mode: input.mode,
			agent: input.agent,
			agentSource: input.agentSource,
			task: input.task,
			cwd: input.cwd,
			step: input.step,
			index: input.index,
			model: input.model,
			status: "running",
			startedAt: Date.now(),
			liveEvents: [],
			replayEvents: [],
		};
		this.runs.set(run.id, run);
		this.notify();
		return run;
	}

	recordEvent(runId: string, event: StoredTranscriptEvent): void {
		const run = this.runs.get(runId);
		if (!run) return;
		run.liveEvents.push(cloneEvent(event));
		this.notify();
	}

	recordReplayEvent(runId: string, event: StoredTranscriptEvent): void {
		const run = this.runs.get(runId);
		if (!run) return;
		run.replayEvents.push(cloneEvent(event));
	}

	attachTranscriptRef(runId: string, ref: TranscriptStorageRef | undefined): void {
		const run = this.runs.get(runId);
		if (!run || !ref) return;
		run.transcriptRef = ref;
		this.notify();
	}

	setTranscriptStorageError(runId: string, error: string | undefined): void {
		const run = this.runs.get(runId);
		if (!run || !error) return;
		run.transcriptStorageError = error;
		this.notify();
	}

	finishRun(runId: string, result: FinishRunInput): void {
		const run = this.runs.get(runId);
		if (!run) return;
		run.status = result.status;
		run.exitCode = result.exitCode;
		run.stopReason = result.stopReason;
		run.errorMessage = result.errorMessage;
		run.stderr = result.stderr;
		run.endedAt = Date.now();
		this.notify();
	}

	getRun(runId: string): SubagentRunRecord | undefined {
		return this.runs.get(runId);
	}

	getRunsSortedByStartTime(): SubagentRunRecord[] {
		return Array.from(this.runs.values()).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	}

	clearRuns(): void {
		this.runs.clear();
		this.notify();
	}

	async hydrateFromSessionEntries(entries: readonly SessionEntry[], storage: TranscriptStorage): Promise<void> {
		this.runs.clear();
		for (const entry of entries) {
			const anyEntry = entry as any;
			if (anyEntry.type !== "message") continue;
			const message = anyEntry.message;
			if (!message || message.role !== "toolResult" || message.toolName !== "subagent") continue;
			const details = message.details;
			if (!details || !Array.isArray(details.results)) continue;
			const mode = details.mode === "parallel" || details.mode === "chain" || details.mode === "single" ? details.mode : "single";
			const fallbackStartedAt = safeTimestamp(anyEntry.timestamp, message.timestamp ?? Date.now());
			for (let index = 0; index < details.results.length; index++) {
				const result = details.results[index] as HistoricalResultLike;
				if (!result || typeof result.agent !== "string") continue;
				const runId = result.runId || `${message.toolCallId || anyEntry.id || "historical"}:${mode}:${index}:${result.agent}`;
				if (this.runs.has(runId)) continue;

				let loadedEvents: StoredTranscriptEvent[] | undefined;
				if (result.transcriptRef) {
					loadedEvents = await storage.loadTranscript(result.transcriptRef);
				}
				const replayEvents = Array.isArray(result.replayEvents) ? result.replayEvents : messagesToReplayEvents(result.messages);
				const liveEvents = loadedEvents && loadedEvents.length > 0 ? loadedEvents : replayEvents;
				const run: SubagentRunRecord = {
					id: runId,
					parentToolCallId: message.toolCallId || "historical",
					mode,
					agent: result.agent,
					agentSource: result.agentSource ?? "unknown",
					task: result.task ?? "",
					cwd: result.cwd ?? "",
					step: result.step,
					index: result.index ?? index,
					model: result.model,
					status: statusFromExit(result.exitCode, result.stopReason),
					startedAt: resultStartedAt(result, fallbackStartedAt + index),
					endedAt: fallbackStartedAt,
					exitCode: result.exitCode,
					stopReason: result.stopReason,
					errorMessage: result.errorMessage,
					stderr: result.stderr,
					liveEvents,
					replayEvents,
					transcriptRef: result.transcriptRef,
					transcriptStorageError: result.transcriptStorageError,
				};
				this.runs.set(run.id, run);
			}
		}
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.subscribers.add(listener);
		return () => this.subscribers.delete(listener);
	}

	clearVolatileSubscribers(): void {
		this.subscribers.clear();
	}

	private notify(): void {
		for (const listener of this.subscribers) {
			try {
				listener();
			} catch {
				/* ignore subscriber errors */
			}
		}
	}
}
