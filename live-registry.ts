import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TranscriptStorage } from "./transcript-storage.js";
import {
	type FinishRunInput,
	type HistoricalResultLike,
	type StartRunInput,
	appendCoalescedTranscriptEvent,
	type TranscriptAppendResult,
	type StoredTranscriptEvent,
	type SubagentRunRecord,
	statusFromExit,
	runMatchesPrefix,
	type ChildSessionRef,
	type TranscriptSegmentRef,
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

const MAX_LIVE_EVENT_MUTATIONS = 512;

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

export interface BackgroundJobRunInput {
	id: string;
	agent: string;
	task: string;
	status: "running" | "completed" | "failed" | "cancelled";
	startedAt: string | number;
	completedAt?: string | number;
	result?: string;
	error?: string;
	cwd?: string;
	parentToolCallId?: string;
}

export interface SubagentInputController {
	steer(message: string): Promise<void>;
	followUp(message: string): Promise<void>;
	/** Placeholder for future pi RPC dequeue support. */
	dequeue?(): Promise<void>;
}

export interface SubagentInputState {
	pendingSteeringMessageTexts?: string[];
	pendingFollowUpMessageTexts?: string[];
	pendingSteeringMessages?: number;
	pendingFollowUpMessages?: number;
	pendingInputMessages?: number;
	inputErrorMessage?: string;
}

export class LiveSubagentRegistry {
	private runs = new Map<string, SubagentRunRecord>();
	private subscribers = new Set<() => void>();
	private abortControllers = new Map<string, AbortController>();
	private inputControllers = new Map<string, SubagentInputController>();
	private cancelledRunIds = new Set<string>();

	private touch(run: SubagentRunRecord): void {
		run.revision = (run.revision ?? 0) + 1;
	}

	private recordLiveEventMutation(run: SubagentRunRecord, result: TranscriptAppendResult): void {
		const sequence = (run.liveEventMutationSequence ?? 0) + 1;
		const mutations = run.liveEventMutations ?? [];
		mutations.push({ ...result, revision: run.revision ?? 0, sequence });
		if (mutations.length > MAX_LIVE_EVENT_MUTATIONS) {
			mutations.splice(0, mutations.length - MAX_LIVE_EVENT_MUTATIONS);
		}
		run.liveEventMutations = mutations;
		run.liveEventMutationSequence = sequence;
	}

	startRun(input: StartRunInput): SubagentRunRecord {
		const id = input.runId ?? `${input.parentToolCallId}:${input.mode}:${input.index ?? input.step ?? 0}:${input.agent}:${randomUUID()}`;
		const run: SubagentRunRecord = {
			id,
			parentToolCallId: input.parentToolCallId,
			mode: input.mode,
			agent: input.agent,
			agentSource: input.agentSource,
			agentColor: input.agentColor,
			task: input.task,
			cwd: input.cwd,
			step: input.step,
			index: input.index,
			model: input.model,
			status: "running",
			startedAt: Date.now(),
			liveEvents: [],
			revision: 0,
			liveEventMutations: [],
			liveEventMutationSequence: 0,
			replayEvents: [],
		};
		this.runs.set(run.id, run);
		this.notify();
		return run;
	}

	recordEvent(runId: string, event: StoredTranscriptEvent): void {
		const run = this.runs.get(runId);
		if (!run) return;
		const appendResult = appendCoalescedTranscriptEvent(run.liveEvents, cloneEvent(event));
		this.touch(run);
		this.recordLiveEventMutation(run, appendResult);
		this.notify();
	}

	recordReplayEvent(runId: string, event: StoredTranscriptEvent): void {
		const run = this.runs.get(runId);
		if (!run) return;
		run.replayEvents.push(cloneEvent(event));
		this.touch(run);
	}

	attachTranscriptRef(runId: string, ref: TranscriptStorageRef | undefined): void {
		const run = this.runs.get(runId);
		if (!run || !ref) return;
		run.transcriptRef = ref;
		this.touch(run);
		this.notify();
	}

	attachTranscriptSegment(runId: string, segment: TranscriptSegmentRef | undefined): void {
		const run = this.runs.get(runId);
		if (!run || !segment) return;
		run.transcriptSegments = [...(run.transcriptSegments ?? []).filter((s) => s.index !== segment.index), segment].sort(
			(a, b) => a.index - b.index,
		);
		if (!run.transcriptRef) run.transcriptRef = segment;
		this.touch(run);
		this.notify();
	}

	attachChildSessionRef(runId: string, ref: ChildSessionRef | undefined): void {
		const run = this.runs.get(runId);
		if (!run || !ref) return;
		run.childSessionRef = ref;
		this.touch(run);
		this.notify();
	}

	attachAbortController(runId: string, controller: AbortController): void {
		this.abortControllers.set(runId, controller);
	}

	detachAbortController(runId: string, controller?: AbortController): void {
		if (controller && this.abortControllers.get(runId) !== controller) return;
		this.abortControllers.delete(runId);
	}

	attachInputController(runId: string, controller: SubagentInputController): void {
		this.inputControllers.set(runId, controller);
	}

	detachInputController(runId: string, controller?: SubagentInputController): void {
		if (controller && this.inputControllers.get(runId) !== controller) return;
		this.inputControllers.delete(runId);
	}

	getInputController(runId: string): SubagentInputController | undefined {
		return this.inputControllers.get(runId);
	}

	updateInputState(runId: string, state: SubagentInputState): void {
		const run = this.runs.get(runId);
		if (!run) return;

		const steeringTextsUpdated = state.pendingSteeringMessageTexts !== undefined;
		const followUpTextsUpdated = state.pendingFollowUpMessageTexts !== undefined;

		if (steeringTextsUpdated) {
			run.pendingSteeringMessageTexts = [...state.pendingSteeringMessageTexts!];
			run.pendingSteeringMessages = run.pendingSteeringMessageTexts.length;
		} else if (state.pendingSteeringMessages !== undefined) {
			run.pendingSteeringMessages = Math.max(0, state.pendingSteeringMessages);
			if (run.pendingSteeringMessages === 0) run.pendingSteeringMessageTexts = [];
		}

		if (followUpTextsUpdated) {
			run.pendingFollowUpMessageTexts = [...state.pendingFollowUpMessageTexts!];
			run.pendingFollowUpMessages = run.pendingFollowUpMessageTexts.length;
		} else if (state.pendingFollowUpMessages !== undefined) {
			run.pendingFollowUpMessages = Math.max(0, state.pendingFollowUpMessages);
			if (run.pendingFollowUpMessages === 0) run.pendingFollowUpMessageTexts = [];
		}

		if (state.pendingInputMessages !== undefined) {
			run.pendingInputMessages = Math.max(0, state.pendingInputMessages);
		} else if (steeringTextsUpdated || followUpTextsUpdated) {
			run.pendingInputMessages = (run.pendingSteeringMessages ?? 0) + (run.pendingFollowUpMessages ?? 0);
		}
		if ("inputErrorMessage" in state) run.inputErrorMessage = state.inputErrorMessage;
		this.touch(run);
		this.notify();
	}

	cancelRun(runId: string, reason = "Cancelled from subagent overlay"): boolean {
		const run = this.runs.get(runId);
		if (!run || (run.status !== "running" && run.status !== "cancelling")) return false;
		const controller = this.abortControllers.get(runId);
		if (!controller) return false;

		if (run.status !== "cancelling") {
			run.status = "cancelling";
			run.stopReason = "aborted";
			run.cancelRequestedAt = Date.now();
			this.cancelledRunIds.add(run.id);
			this.touch(run);
			this.notify();
		}

		if (!controller.signal.aborted) controller.abort(reason);
		return true;
	}

	markRunRunning(runId: string): void {
		const run = this.runs.get(runId);
		if (!run) return;
		run.status = "running";
		run.errorMessage = undefined;
		run.cancelRequestedAt = undefined;
		this.cancelledRunIds.delete(runId);
		this.touch(run);
		this.notify();
	}

	setTranscriptStorageError(runId: string, error: string | undefined): void {
		const run = this.runs.get(runId);
		if (!run || !error) return;
		run.transcriptStorageError = error;
		this.touch(run);
		this.notify();
	}

	finishRun(runId: string, result: FinishRunInput): void {
		const run = this.runs.get(runId);
		if (!run) return;
		const wasRunningOrCancelling = run.status === "running" || run.status === "cancelling";
		run.status = result.status;
		run.exitCode = result.exitCode;
		run.stopReason = result.stopReason;
		run.errorMessage = result.errorMessage;
		run.stderr = result.stderr;
		run.endedAt = Date.now();
		if ((result.status === "aborted" || result.status === "cancelled") && !run.cancelRequestedAt) run.cancelRequestedAt = run.endedAt;
		if ((result.status === "aborted" || result.status === "cancelled") && wasRunningOrCancelling) this.cancelledRunIds.add(run.id);
		this.abortControllers.delete(runId);
		this.touch(run);
		this.notify();
	}

	recordBackgroundJobResult(input: BackgroundJobRunInput): SubagentRunRecord {
		const existing = this.runs.get(input.id);
		const startedAt = safeTimestamp(input.startedAt, existing?.startedAt ?? Date.now());
		const terminal = input.status !== "running";
		const completedAt = input.completedAt ? safeTimestamp(input.completedAt, Date.now()) : undefined;
		const endedAt = terminal ? (completedAt ?? existing?.endedAt ?? Date.now()) : existing?.endedAt;
		const status = input.status === "completed" ? "completed" : input.status === "cancelled" ? "cancelled" : input.status === "failed" ? "failed" : "running";
		const resultOutput =
			input.status === "failed"
				? (input.error ?? existing?.resultOutput ?? "(no error captured)")
				: input.status === "cancelled"
					? (input.result ?? existing?.resultOutput ?? "(no partial output captured)")
					: input.status === "completed"
						? (input.result ?? existing?.resultOutput ?? "(no result captured)")
						: existing?.resultOutput;
		const run: SubagentRunRecord = existing ?? {
			id: input.id,
			parentToolCallId: input.parentToolCallId ?? input.id,
			mode: "single",
			agent: input.agent,
			agentSource: "unknown",
			task: input.task,
			cwd: input.cwd ?? process.cwd(),
			status,
			startedAt,
			liveEvents: [],
			revision: 0,
			liveEventMutations: [],
			liveEventMutationSequence: 0,
			replayEvents: [],
		};
		run.agent = input.agent || run.agent;
		run.task = input.task || run.task;
		run.cwd = input.cwd ?? run.cwd;
		run.parentToolCallId = input.parentToolCallId ?? run.parentToolCallId;
		run.status = status;
		run.startedAt = startedAt;
		run.endedAt = endedAt;
		run.exitCode = input.status === "completed" ? 0 : input.status === "failed" ? 1 : input.status === "cancelled" ? 130 : run.exitCode;
		run.stopReason = input.status === "cancelled" ? "aborted" : input.status === "failed" ? "error" : run.stopReason;
		run.errorMessage = input.status === "failed" ? input.error : run.errorMessage;
		run.resultOutput = resultOutput;
		if (input.status === "cancelled") this.cancelledRunIds.add(run.id);
		this.runs.set(run.id, run);
		this.abortControllers.delete(run.id);
		this.touch(run);
		this.notify();
		return run;
	}

	getRun(runId: string): SubagentRunRecord | undefined {
		return this.runs.get(runId);
	}

	getRunsSortedByStartTime(): SubagentRunRecord[] {
		return Array.from(this.runs.values()).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	}

	getCancelledRuns(initialRunIds?: ReadonlySet<string>): SubagentRunRecord[] {
		return this.getRunsSortedByStartTime().filter((run) => this.cancelledRunIds.has(run.id) && (!initialRunIds || initialRunIds.has(run.id)));
	}

	getRunsByPrefix(query: string): SubagentRunRecord[] {
		const trimmed = query.trim();
		if (!trimmed) return [];
		return this.getRunsSortedByStartTime().filter((run) => runMatchesPrefix(run, trimmed));
	}

	findRunsByPrefix(query: string): SubagentRunRecord[] {
		return this.getRunsByPrefix(query);
	}

	clearRuns(): void {
		this.runs.clear();
		this.abortControllers.clear();
		this.inputControllers.clear();
		this.cancelledRunIds.clear();
		this.notify();
	}

	async hydrateFromSessionEntries(entries: readonly SessionEntry[], storage: TranscriptStorage): Promise<void> {
		this.runs.clear();
		this.inputControllers.clear();
		this.cancelledRunIds.clear();
		for (const entry of entries) {
			const anyEntry = entry as any;
			const fallbackStartedAt = safeTimestamp(anyEntry.timestamp, Date.now());

			if (anyEntry.type === "custom" && anyEntry.customType === "subagent-run-update" && anyEntry.data?.result) {
				await this.hydrateResult(anyEntry.data.result as HistoricalResultLike, "single", anyEntry.id || "custom", fallbackStartedAt, 0, storage);
				continue;
			}

			const customType = anyEntry.customType ?? anyEntry.message?.customType;
			const customData = anyEntry.data ?? anyEntry.message?.details;
			if (customType === "subagent-jobs-result" && customData?.job?.id) {
				this.recordBackgroundJobResult(customData.job as BackgroundJobRunInput);
				continue;
			}

			if (anyEntry.type !== "message") continue;
			const message = anyEntry.message;
			if (!message || message.role !== "toolResult") continue;
			const details = message.details;
			if (!details) continue;

			if (message.toolName === "subagent" && Array.isArray(details.results)) {
				const mode = details.mode === "parallel" || details.mode === "chain" || details.mode === "single" ? details.mode : "single";
				const startedAt = safeTimestamp(anyEntry.timestamp, message.timestamp ?? Date.now());
				for (let index = 0; index < details.results.length; index++) {
					await this.hydrateResult(details.results[index] as HistoricalResultLike, mode, message.toolCallId || anyEntry.id || "historical", startedAt, index, storage);
				}
			} else if (message.toolName === "subagent_continue" && details.result) {
				const result = details.result as HistoricalResultLike;
				await this.hydrateResult(result, "single", message.toolCallId || anyEntry.id || "continue", fallbackStartedAt, result.index ?? 0, storage);
			}
		}
		this.notify();
	}

	private async hydrateResult(
		result: HistoricalResultLike,
		mode: "single" | "parallel" | "chain",
		parentToolCallId: string,
		fallbackStartedAt: number,
		index: number,
		storage: TranscriptStorage,
	): Promise<void> {
		if (!result || typeof result.agent !== "string") return;
		const runId = result.runId || `${parentToolCallId}:${mode}:${index}:${result.agent}`;
		let loadedEvents: StoredTranscriptEvent[] | undefined;
		if (Array.isArray(result.transcriptSegments) && result.transcriptSegments.length > 0) {
			loadedEvents = await storage.loadTranscriptSegments(result.transcriptSegments);
		}
		if (!loadedEvents && result.transcriptRef) {
			loadedEvents = await storage.loadTranscript(result.transcriptRef);
		}
		const replayEvents = Array.isArray(result.replayEvents) ? result.replayEvents : messagesToReplayEvents(result.messages);
		const liveEvents = loadedEvents && loadedEvents.length > 0 ? loadedEvents : replayEvents;
		const existing = this.runs.get(runId);
		if (existing) {
			const replacingLiveEvents = liveEvents.length > 0 && liveEvents !== existing.liveEvents;
			existing.liveEvents = liveEvents.length > 0 ? liveEvents : existing.liveEvents;
			if (replacingLiveEvents) {
				existing.liveEventMutations = [];
				existing.liveEventMutationSequence = 0;
			}
			existing.replayEvents = replayEvents.length > 0 ? replayEvents : existing.replayEvents;
			existing.transcriptRef = result.transcriptRef ?? existing.transcriptRef;
			existing.transcriptSegments = result.transcriptSegments ?? existing.transcriptSegments;
			existing.childSessionRef = result.childSessionRef ?? existing.childSessionRef;
			existing.status = statusFromExit(result.exitCode, result.stopReason);
			existing.exitCode = result.exitCode ?? existing.exitCode;
			existing.stopReason = result.stopReason ?? existing.stopReason;
			existing.errorMessage = result.errorMessage ?? existing.errorMessage;
			existing.stderr = result.stderr ?? existing.stderr;
			existing.endedAt = fallbackStartedAt;
			this.touch(existing);
			return;
		}
		const run: SubagentRunRecord = {
			id: runId,
			parentToolCallId,
			mode,
			agent: result.agent,
			agentSource: result.agentSource ?? "unknown",
			agentColor: result.agentColor,
			task: result.task ?? "",
			cwd: result.cwd ?? "",
			step: result.step,
			index: result.index ?? index,
			model: result.model,
			status: statusFromExit(result.exitCode, result.stopReason),
			startedAt: resultStartedAt(result, fallbackStartedAt + index),
			revision: 0,
			liveEventMutations: [],
			liveEventMutationSequence: 0,
			endedAt: fallbackStartedAt,
			exitCode: result.exitCode,
			stopReason: result.stopReason,
			errorMessage: result.errorMessage,
			stderr: result.stderr,
			liveEvents,
			replayEvents,
			transcriptRef: result.transcriptRef,
			transcriptSegments: result.transcriptSegments,
			childSessionRef: result.childSessionRef,
			transcriptStorageError: result.transcriptStorageError,
		};
		this.runs.set(run.id, run);
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
