import type { Message } from "@earendil-works/pi-ai";

export type SubagentRunStatus = "running" | "done" | "failed" | "aborted";
export type SubagentRunMode = "single" | "parallel" | "chain";
export type AgentSource = "package" | "user" | "project" | "unknown";

export interface StoredTranscriptEvent {
	type: string;
	[key: string]: unknown;
}

export interface TranscriptStorageRef {
	kind: "gzip-jsonl-v1";
	relativePath: string;
	absolutePath?: string;
	sha256: string;
	eventCount: number;
	uncompressedBytes: number;
	compressedBytes: number;
	createdAt: number;
}

export interface TranscriptSegmentRef extends TranscriptStorageRef {
	index: number;
}

export interface ChildSessionRef {
	kind: "pi-session-jsonl-v1";
	relativePath: string;
	absolutePath?: string;
	createdAt: number;
}

export interface TranscriptPersistResult {
	ref?: TranscriptStorageRef;
	error?: string;
}

export interface SubagentRunRecord {
	id: string;
	parentToolCallId: string;
	mode: SubagentRunMode;
	agent: string;
	agentSource: AgentSource;
	agentColor?: string;
	task: string;
	cwd: string;
	step?: number;
	index?: number;
	model?: string;
	status: SubagentRunStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
	stderr?: string;

	/** Live event stream, with high-frequency updates coalesced while a run is active. */
	liveEvents: StoredTranscriptEvent[];

	/** Incremented whenever render-relevant run state changes. */
	revision: number;

	/** Compact replay events safe to persist into session details as fallback. */
	replayEvents: StoredTranscriptEvent[];

	/** Full transcript sidecar reference, available after a run finishes and storage succeeds. */
	transcriptRef?: TranscriptStorageRef;

	/** Transcript segments, used when a run is continued after the initial process exits. */
	transcriptSegments?: TranscriptSegmentRef[];

	/** Real child pi session used to continue this subagent run. Missing means view-only. */
	childSessionRef?: ChildSessionRef;

	/** Storage failure message, if full gzip persistence failed but normal tool execution continued. */
	transcriptStorageError?: string;
}

export interface StartRunInput {
	parentToolCallId: string;
	mode: SubagentRunMode;
	agent: string;
	agentSource: AgentSource;
	agentColor?: string;
	task: string;
	cwd: string;
	step?: number;
	index?: number;
	model?: string;
}

export interface FinishRunInput {
	status: SubagentRunStatus;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
	stderr?: string;
}

export interface HistoricalResultLike {
	runId?: string;
	agent: string;
	agentSource?: AgentSource;
	agentColor?: string;
	task: string;
	cwd?: string;
	exitCode?: number;
	messages?: Message[];
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	stderr?: string;
	step?: number;
	index?: number;
	replayEvents?: StoredTranscriptEvent[];
	transcriptRef?: TranscriptStorageRef;
	transcriptSegments?: TranscriptSegmentRef[];
	childSessionRef?: ChildSessionRef;
	transcriptStorageError?: string;
}

export function hasMessage(event: StoredTranscriptEvent): event is StoredTranscriptEvent & { message: Message } {
	return typeof event === "object" && event !== null && "message" in event;
}

function eventMessage(event: StoredTranscriptEvent): any | undefined {
	return hasMessage(event) ? (event.message as any) : undefined;
}

function messageIdentity(event: StoredTranscriptEvent): { id?: string; role?: string } | undefined {
	const message = eventMessage(event);
	if (!message || typeof message !== "object") return undefined;
	const id = typeof message.id === "string" ? message.id : undefined;
	const role = typeof message.role === "string" ? message.role : undefined;
	return id || role ? { id, role } : undefined;
}

function sameMessageStream(a: StoredTranscriptEvent, b: StoredTranscriptEvent): boolean {
	const left = messageIdentity(a);
	const right = messageIdentity(b);
	if (!left || !right) return false;
	if (left.id && right.id) return left.id === right.id;
	return Boolean(left.role && right.role && left.role === right.role);
}

function findPendingMessageUpdateIndex(events: StoredTranscriptEvent[], event: StoredTranscriptEvent): number {
	for (let i = events.length - 1; i >= 0; i--) {
		const existing = events[i];
		if (existing.type === "message_update" && sameMessageStream(existing, event)) return i;
		if ((existing.type === "message_start" || existing.type === "message_end") && sameMessageStream(existing, event)) break;
	}
	return -1;
}

function findPendingToolUpdateIndex(events: StoredTranscriptEvent[], toolCallId: unknown): number {
	if (!toolCallId) return -1;
	for (let i = events.length - 1; i >= 0; i--) {
		const existing = events[i];
		if (existing.toolCallId !== toolCallId) continue;
		if (existing.type === "tool_execution_update") return i;
		if (existing.type === "tool_execution_start" || existing.type === "tool_execution_end") break;
	}
	return -1;
}

export function appendCoalescedTranscriptEvent(events: StoredTranscriptEvent[], event: StoredTranscriptEvent): void {
	let replacementIndex = -1;
	if (event.type === "message_update") {
		replacementIndex = findPendingMessageUpdateIndex(events, event);
	} else if (event.type === "tool_execution_update") {
		replacementIndex = findPendingToolUpdateIndex(events, event.toolCallId);
	}
	if (replacementIndex >= 0) events[replacementIndex] = event;
	else events.push(event);
}

export function shouldPersistReplayEvent(event: StoredTranscriptEvent): boolean {
	// Keep session details compact. The full stream, including high-frequency and aggregate
	// lifecycle events, is persisted in the gzip sidecar. The fallback only needs finalized
	// messages plus tool start/end events to reconstruct a useful transcript.
	switch (event.type) {
		case "message_end":
		case "tool_execution_start":
		case "tool_execution_end":
		case "tool_result_end":
			return true;
		default:
			return false;
	}
}

export function statusFromExit(exitCode: number | undefined, stopReason?: string): SubagentRunStatus {
	if (stopReason === "aborted") return "aborted";
	if (exitCode === undefined || exitCode === -1) return "running";
	if (exitCode === 0 && stopReason !== "error") return "done";
	return "failed";
}

export function getRunUuid(runId: string | undefined): string {
	if (!runId) return "";
	return runId.split(":").pop() || runId;
}

export function getRunShortId(runId: string | undefined, length = 8): string {
	const compact = getRunUuid(runId).replace(/-/g, "");
	return compact.slice(0, Math.max(1, length));
}

export function formatRunLabel(agent: string, runId: string | undefined, length = 8): string {
	const shortId = getRunShortId(runId, length);
	return shortId ? `${agent}@${shortId}` : agent;
}

export function runMatchesPrefix(run: Pick<SubagentRunRecord, "id" | "agent">, query: string): boolean {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return false;
	const shortId = getRunShortId(run.id, 32).toLowerCase();
	const uuid = getRunUuid(run.id).toLowerCase();
	const full = run.id.toLowerCase();
	const label = formatRunLabel(run.agent, run.id, 32).toLowerCase();
	return (
		shortId.startsWith(normalized) ||
		uuid.startsWith(normalized) ||
		full.includes(normalized) ||
		label.startsWith(normalized)
	);
}
