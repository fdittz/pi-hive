import { execFileSync } from "node:child_process";
import type {
	AgentSession,
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { SubagentRunRecord } from "./transcript-types.js";

/**
 * Host data SubagentOverlay needs to render the same footer used by the main pi chat.
 * Keep this adapter narrow so the overlay does not depend on pi internals.
 */
export interface SubagentOverlayHostContext {
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager" | "modelRegistry" | "model" | "getContextUsage">;
	pi: Pick<ExtensionAPI, "getThinkingLevel">;
	footerData?: ReadonlyFooterDataProvider;
}

export function createFooterSessionAdapter(host: SubagentOverlayHostContext): AgentSession {
	return {
		get state() {
			return {
				model: host.ctx.model,
				thinkingLevel: host.pi.getThinkingLevel(),
			};
		},
		sessionManager: host.ctx.sessionManager,
		modelRegistry: host.ctx.modelRegistry,
		getContextUsage: () => host.ctx.getContextUsage(),
	} as unknown as AgentSession;
}

export function createFooterDataAdapter(host: SubagentOverlayHostContext): ReadonlyFooterDataProvider {
	if (host.footerData) return host.footerData;

	let cachedBranch: string | null | undefined;
	const statuses = new Map<string, string>();

	return {
		getGitBranch(): string | null {
			cachedBranch ??= readGitBranch(host.ctx.cwd);
			return cachedBranch;
		},
		getExtensionStatuses(): ReadonlyMap<string, string> {
			return statuses;
		},
		getAvailableProviderCount(): number {
			return countAvailableProviders(host.ctx.modelRegistry);
		},
		onBranchChange(): () => void {
			// Extension UI does not expose pi's internal footer data provider here.
			// Keep the method for FooterComponent compatibility; branch is refreshed on reopen.
			return () => undefined;
		},
	};
}

export interface SubagentFooterSnapshot {
	entries: Array<{ type: "message"; message: any }>;
	contextUsage: { tokens: number | null; contextWindow: number; percent: number | null };
	cwd: string;
	model: string | undefined;
}

interface AssistantMessageCandidate {
	message: any;
	index: number;
}

const subagentFooterSnapshotCache = new Map<string, { revision: number; snapshot: SubagentFooterSnapshot }>();
const emptySubagentContextUsage: SubagentFooterSnapshot["contextUsage"] = { tokens: null, contextWindow: 0, percent: null };

export function collectSubagentFooterSnapshot(run: SubagentRunRecord): SubagentFooterSnapshot {
	const finalizedMessages = collectMessageEndAssistantMessages(run);
	const agentEndMessages = finalizedMessages.length === 0 ? collectAgentEndAssistantMessages(run) : [];
	const streamingMessages = finalizedMessages.length === 0 && agentEndMessages.length === 0 ? collectLatestMessageUpdateAssistantMessages(run) : [];
	const messages = dedupeAssistantMessages(
		finalizedMessages.length > 0 ? finalizedMessages : agentEndMessages.length > 0 ? agentEndMessages : streamingMessages,
	).filter((message) => message.usage != null);

	const entries = messages.map((message) => ({
		type: "message" as const,
		message: {
			role: "assistant",
			usage: {
				input: numericUsageField(message.usage, "input"),
				output: numericUsageField(message.usage, "output"),
				cacheRead: numericUsageField(message.usage, "cacheRead"),
				cacheWrite: numericUsageField(message.usage, "cacheWrite"),
				cost: {
					total: numericUsageField(message.usage?.cost, "total"),
				},
			},
		},
	}));

	let contextUsage: SubagentFooterSnapshot["contextUsage"] = { ...emptySubagentContextUsage };
	for (const message of messages) {
		const tokens = nullableNumericUsageField(message.usage, "totalTokens");
		const contextWindow = numericUsageField(message.usage, "contextWindow");
		contextUsage = {
			tokens,
			contextWindow,
			percent: tokens !== null && contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
		};
	}

	return {
		entries,
		contextUsage,
		cwd: run.cwd,
		model: run.model,
	};
}

export function createSubagentFooterSessionAdapter(
	host: SubagentOverlayHostContext,
	getRun: () => SubagentRunRecord | undefined,
): AgentSession {
	return {
		get state() {
			const run = getRun();
			return {
				model: {
					id: run?.model ?? "subagent",
					provider: parseSubagentProvider(run?.model),
					contextWindow: 0,
					reasoning: false,
				},
				thinkingLevel: "off",
			};
		},
		sessionManager: {
			getCwd(): string {
				return getRun()?.cwd ?? "";
			},
			getSessionName(): undefined {
				return undefined;
			},
			getEntries(): SubagentFooterSnapshot["entries"] {
				const run = getRun();
				return run ? getCachedSubagentFooterSnapshot(run).entries : [];
			},
		},
		modelRegistry: host.ctx.modelRegistry,
		getContextUsage(): SubagentFooterSnapshot["contextUsage"] {
			const run = getRun();
			return run ? getCachedSubagentFooterSnapshot(run).contextUsage : { ...emptySubagentContextUsage };
		},
	} as unknown as AgentSession;
}

export function createSubagentFooterDataAdapter(
	host: SubagentOverlayHostContext,
	getRun: () => SubagentRunRecord | undefined,
): ReadonlyFooterDataProvider {
	void host;
	const branchCache = new Map<string, string | null>();
	const statuses = new Map<string, string>();

	return {
		getGitBranch(): string | null {
			const cwd = getRun()?.cwd ?? "";
			if (!branchCache.has(cwd)) branchCache.set(cwd, readGitBranch(cwd));
			return branchCache.get(cwd) ?? null;
		},
		getExtensionStatuses(): ReadonlyMap<string, string> {
			return statuses;
		},
		getAvailableProviderCount(): number {
			return 1;
		},
		onBranchChange(): () => void {
			return () => undefined;
		},
	};
}

function collectMessageEndAssistantMessages(run: SubagentRunRecord): AssistantMessageCandidate[] {
	const candidates: AssistantMessageCandidate[] = [];
	for (let index = 0; index < run.liveEvents.length; index++) {
		const event = run.liveEvents[index] as any;
		if (event?.type === "message_end" && isAssistantMessage(event.message)) {
			candidates.push({ message: event.message, index });
		}
	}
	return candidates;
}

function collectAgentEndAssistantMessages(run: SubagentRunRecord): AssistantMessageCandidate[] {
	const candidates: AssistantMessageCandidate[] = [];
	for (let eventIndex = 0; eventIndex < run.liveEvents.length; eventIndex++) {
		const event = run.liveEvents[eventIndex] as any;
		if (event?.type !== "agent_end" || !Array.isArray(event.messages)) continue;
		for (let messageIndex = 0; messageIndex < event.messages.length; messageIndex++) {
			const message = event.messages[messageIndex];
			if (isAssistantMessage(message)) candidates.push({ message, index: eventIndex * 100_000 + messageIndex });
		}
	}
	return candidates;
}

function collectLatestMessageUpdateAssistantMessages(run: SubagentRunRecord): AssistantMessageCandidate[] {
	const byStream = new Map<string, AssistantMessageCandidate>();
	for (let index = 0; index < run.liveEvents.length; index++) {
		const event = run.liveEvents[index] as any;
		if (event?.type !== "message_update" || !isAssistantMessage(event.message)) continue;
		const key = messageDedupKey(event.message, index);
		if (byStream.has(key)) byStream.delete(key);
		byStream.set(key, { message: event.message, index });
	}
	return Array.from(byStream.values());
}

function dedupeAssistantMessages(candidates: AssistantMessageCandidate[]): any[] {
	const byMessage = new Map<string, AssistantMessageCandidate>();
	for (const candidate of candidates) {
		const key = messageDedupKey(candidate.message, candidate.index);
		if (byMessage.has(key)) byMessage.delete(key);
		byMessage.set(key, candidate);
	}
	return Array.from(byMessage.values()).map((candidate) => candidate.message);
}

function isAssistantMessage(message: unknown): message is { role: "assistant"; usage?: unknown } {
	return typeof message === "object" && message !== null && (message as any).role === "assistant";
}

function messageDedupKey(message: any, index: number): string {
	return typeof message?.id === "string" && message.id.length > 0 ? `id:${message.id}` : `index:${index}`;
}

function numericUsageField(value: any, field: string): number {
	const fieldValue = value?.[field];
	return typeof fieldValue === "number" && Number.isFinite(fieldValue) ? fieldValue : 0;
}

function nullableNumericUsageField(value: any, field: string): number | null {
	const fieldValue = value?.[field];
	return typeof fieldValue === "number" && Number.isFinite(fieldValue) ? fieldValue : null;
}

function getCachedSubagentFooterSnapshot(run: SubagentRunRecord): SubagentFooterSnapshot {
	const cached = subagentFooterSnapshotCache.get(run.id);
	if (cached?.revision === run.revision) return cached.snapshot;
	const snapshot = collectSubagentFooterSnapshot(run);
	subagentFooterSnapshotCache.set(run.id, { revision: run.revision, snapshot });
	return snapshot;
}

function parseSubagentProvider(model: string | undefined): string {
	if (!model) return "subagent";
	const trimmed = model.trim();
	const parenthesized = trimmed.match(/\(([^()]+)\)\s*$/)?.[1]?.trim();
	const candidate = parenthesized || trimmed;
	const slashIndex = candidate.indexOf("/");
	if (slashIndex <= 0) return "subagent";
	return candidate.slice(0, slashIndex).trim() || "subagent";
}

function countAvailableProviders(modelRegistry: ExtensionContext["modelRegistry"]): number {
	try {
		return new Set(modelRegistry.getAvailable().map((model) => model.provider)).size;
	} catch {
		return 1;
	}
}

function readGitBranch(cwd: string): string | null {
	try {
		const branch = execFileSync("git", ["branch", "--show-current"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 500,
		}).trim();
		if (branch) return branch;

		const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 500,
		}).trim();
		return head ? "detached" : null;
	} catch {
		return null;
	}
}
