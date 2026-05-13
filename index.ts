/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { colorAgentText } from "./agent-colors.js";
import {
	getAutoDelegateConfig,
	setAutoDelegateConfig,
	setAutoDelegateEnabled,
	type AutoDelegateConfig,
} from "./auto-delegate.js";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { ChildSessionStorage } from "./child-session-storage.js";
import { findBestAgent, type AgentMatch } from "./delegate.js";
import { generateSubagentGuidance } from "./delegation-guidance.js";
import { getCompatibilityWarning } from "./compatibility.js";
import {
	confirmHandoff,
	decideHandoff,
	extractHandoffRequests,
	extractHandoffRequestsFromMessages,
	openSubagentHandoffConfig,
	shouldAskApprovalForHandoff,
} from "./handoff.js";
import { LiveSubagentRegistry } from "./live-registry.js";
import { loadSubagentModelConfig, resolveAgentModel } from "./model-overrides.js";
import { openSubagentModelSelector } from "./model-selector.js";
import { buildSubagentHeaderEnv, isSubagentChildProcess, registerSubagentRequestHeaders } from "./request-headers.js";
import { loadSubagentConfig } from "./subagent-config.js";
import { SubagentOverlay } from "./subagent-overlay.js";
import { TranscriptStorage } from "./transcript-storage.js";
import { appendCoalescedTranscriptEvent, formatRunLabel, shouldPersistReplayEvent, type ChildSessionRef, type StoredTranscriptEvent, type SubagentRunMode, type TranscriptSegmentRef, type TranscriptStorageRef } from "./transcript-types.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000;

function debugLog(message: string): void {
	if (process.env.PI_HIVE_DEBUG !== "1" && process.env.PI_SUBAGENT_DEBUG !== "1") return;
	console.error(`[pi-hive] ${message}`);
}

function debugPreview(text: string, maxLength = 320): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

const registry = new LiveSubagentRegistry();
const transcriptStorage = new TranscriptStorage();
const childSessionStorage = new ChildSessionStorage();
let activeOverlayClose: (() => void) | undefined;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface HandoffInfo {
	fromAgent: string;
	fromRunId?: string;
	reason?: string;
	depth: number;
}

interface SingleResult {
	runId?: string;
	agent: string;
	agentSource: "package" | "user" | "project" | "unknown";
	agentColor?: string;
	task: string;
	cwd?: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	index?: number;
	replayEvents?: StoredTranscriptEvent[];
	transcriptRef?: TranscriptStorageRef;
	transcriptSegments?: TranscriptSegmentRef[];
	childSessionRef?: ChildSessionRef;
	transcriptStorageError?: string;
	handoff?: HandoffInfo;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function withSequentialChainSteps(results: SingleResult[]): SingleResult[] {
	return results.map((result, index) =>
		result.step === index + 1 ? result : { ...result, step: index + 1 },
	);
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

type RunMeta = {
	parentToolCallId: string;
	mode: SubagentRunMode;
	index?: number;
	sessionFile?: string;
	parentModel?: { provider: string; id: string };
	parentThinking?: string;
	existingRunId?: string;
	continuation?: boolean;
	handoffDepth?: number;
	handoff?: HandoffInfo;
};

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	runMeta: RunMeta,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			handoff: runMeta.handoff,
		};
	}

	const effectiveCwd = cwd ?? defaultCwd;
	const modelConfig = loadSubagentModelConfig();
	const resolvedModel = resolveAgentModel(agent, runMeta.parentModel, modelConfig, runMeta.parentThinking);
	let run = runMeta.existingRunId ? registry.getRun(runMeta.existingRunId) : undefined;
	if (run) {
		registry.markRunRunning(run.id);
	} else {
		run = registry.startRun({
			parentToolCallId: runMeta.parentToolCallId,
			mode: runMeta.mode,
			agent: agentName,
			agentSource: agent.source,
			agentColor: agent.color,
			task,
			cwd: effectiveCwd,
			step,
			index: runMeta.index,
			model: resolvedModel.display,
		});
	}

	let childSessionPath: string | undefined;
	if (run.childSessionRef) {
		childSessionPath = childSessionStorage.resolveRef(run.childSessionRef);
	} else {
		const prepared = await childSessionStorage.prepareRunSession(run, runMeta.sessionFile);
		if (prepared) {
			childSessionPath = prepared.path;
			registry.attachChildSessionRef(run.id, prepared.ref);
		}
	}

	const args: string[] = ["--mode", "json", "-p"];
	if (childSessionPath) args.push("--session", childSessionPath);
	else args.push("--no-session");
	if (resolvedModel.modelArg) args.push("--model", resolvedModel.modelArg);
	if (resolvedModel.thinkingArg) args.push("--thinking", resolvedModel.thinkingArg);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		runId: run.id,
		agent: agentName,
		agentSource: agent.source,
		agentColor: agent.color,
		task,
		cwd: effectiveCwd,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: resolvedModel.display,
		step,
		index: runMeta.index,
		replayEvents: [],
		childSessionRef: run.childSessionRef,
		handoff: runMeta.handoff,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;
		let wasTimedOut = false;
		let childProc: ReturnType<typeof spawn> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const segmentEvents: StoredTranscriptEvent[] = [];

		const exitCode = await Promise.race([
			new Promise<number>((resolve) => {
				const invocation = getPiInvocation(args);
				const childEnv = {
					...process.env,
					...buildSubagentHeaderEnv({
						agent: agentName,
						runId: run.id,
						mode: runMeta.mode,
						source: agent.source,
						parentToolCallId: runMeta.parentToolCallId,
					}),
				};
				const proc = spawn(invocation.command, invocation.args, {
					cwd: effectiveCwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: childEnv,
				});
				childProc = proc;
				let buffer = "";

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}

					const transcriptEvent = event as StoredTranscriptEvent;
					appendCoalescedTranscriptEvent(segmentEvents, transcriptEvent);
					registry.recordEvent(run.id, transcriptEvent);
					if (shouldPersistReplayEvent(transcriptEvent)) {
						registry.recordReplayEvent(run.id, transcriptEvent);
					}

					if (event.type === "message_end" && event.message) {
						const msg = event.message as Message;
						currentResult.messages.push(msg);

						if (msg.role === "assistant") {
							currentResult.usage.turns++;
							const usage = msg.usage;
							if (usage) {
								currentResult.usage.input += usage.input || 0;
								currentResult.usage.output += usage.output || 0;
								currentResult.usage.cacheRead += usage.cacheRead || 0;
								currentResult.usage.cacheWrite += usage.cacheWrite || 0;
								currentResult.usage.cost += usage.cost?.total || 0;
								currentResult.usage.contextTokens = usage.totalTokens || 0;
							}
							if (!currentResult.model && msg.model) currentResult.model = msg.model;
							if (msg.stopReason) currentResult.stopReason = msg.stopReason;
							if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
						}
						emitUpdate();
					}

					if (event.type === "tool_result_end" && event.message) {
						currentResult.messages.push(event.message as Message);
						emitUpdate();
					}
				};

				proc.stdout.on("data", (data) => {
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) processLine(line);
				});

				proc.stderr.on("data", (data) => {
					currentResult.stderr += data.toString();
				});

				proc.on("close", (code) => {
					if (timeout) {
						clearTimeout(timeout);
						timeout = undefined;
					}
					if (!wasTimedOut && buffer.trim()) processLine(buffer);
					resolve(wasTimedOut ? 124 : code ?? 0);
				});

				proc.on("error", () => {
					if (timeout) {
						clearTimeout(timeout);
						timeout = undefined;
					}
					resolve(wasTimedOut ? 124 : 1);
				});

				if (signal) {
					const killProc = () => {
						wasAborted = true;
						proc.kill("SIGTERM");
						setTimeout(() => {
							if (!proc.killed) proc.kill("SIGKILL");
						}, 5000);
					};
					if (signal.aborted) killProc();
					else signal.addEventListener("abort", killProc, { once: true });
				}
			}),
			new Promise<number>((resolve) => {
				timeout = setTimeout(() => {
					wasTimedOut = true;
					const timeoutSeconds = Math.round(SUBAGENT_TIMEOUT_MS / 1000);
					const message = `Subagent timed out after ${timeoutSeconds} seconds`;
					currentResult.stopReason = "error";
					currentResult.errorMessage = message;
					currentResult.stderr += currentResult.stderr && !currentResult.stderr.endsWith("\n") ? `\n${message}\n` : `${message}\n`;
					if (childProc && !childProc.killed) childProc.kill("SIGKILL");
					resolve(124);
				}, SUBAGENT_TIMEOUT_MS);
				(timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
			}),
		]);
		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}

		currentResult.exitCode = exitCode;
		const finalOutput = getFinalOutput(currentResult.messages);
		debugLog(
			`runSingleAgent complete: agent=${agentName}; runId=${run.id}; exitCode=${exitCode}; stopReason=${currentResult.stopReason ?? "none"}; errorMessage=${currentResult.errorMessage ?? "none"}; stderrLength=${currentResult.stderr.length}; messages=${currentResult.messages.length}; finalOutputLength=${finalOutput.length}; hasHandoffKey=${/"(?:handoff|handoffs|delegate|delegates|delegations)"\s*:/.test(finalOutput)}; finalOutputTail=${JSON.stringify(debugPreview(finalOutput.slice(-1200)))}`,
		);
		const finalStatus = wasAborted
			? "aborted"
			: exitCode === 0 && currentResult.stopReason !== "error" && currentResult.stopReason !== "aborted"
				? "done"
				: currentResult.stopReason === "aborted"
					? "aborted"
					: "failed";
		registry.finishRun(run.id, {
			status: finalStatus,
			exitCode,
			stopReason: currentResult.stopReason,
			errorMessage: currentResult.errorMessage,
			stderr: currentResult.stderr,
		});
		const storedBeforePersist = registry.getRun(run.id)!;
		const segmentIndex = (storedBeforePersist.transcriptSegments?.length ?? 0) + 1;
		const persistResult = await transcriptStorage.persistRunSegment(storedBeforePersist, runMeta.sessionFile, segmentEvents, segmentIndex);
		if (persistResult.segment) registry.attachTranscriptSegment(run.id, persistResult.segment);
		if (persistResult.ref && segmentIndex === 1) registry.attachTranscriptRef(run.id, persistResult.ref);
		if (persistResult.error) registry.setTranscriptStorageError(run.id, persistResult.error);
		const storedRun = registry.getRun(run.id);
		currentResult.replayEvents = storedRun?.replayEvents ?? [];
		currentResult.transcriptRef = storedRun?.transcriptRef;
		currentResult.transcriptSegments = storedRun?.transcriptSegments;
		currentResult.childSessionRef = storedRun?.childSessionRef;
		currentResult.transcriptStorageError = storedRun?.transcriptStorageError;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

const SubagentContinueParams = Type.Object({
	run: Type.String({ description: "Run prefix, short id, full id, or agent@id label to continue" }),
	instruction: Type.Optional(Type.String({ description: "Optional continuation instruction" })),
});

function getSessionFile(ctx: ExtensionContext): string | undefined {
	const sessionManager = ctx.sessionManager as any;
	return typeof sessionManager.getSessionFile === "function" ? sessionManager.getSessionFile() : undefined;
}

async function openSubagentsOverlay(ctx: ExtensionContext, runQuery?: string): Promise<void> {
	if (!ctx.hasUI) return;
	if (activeOverlayClose) {
		activeOverlayClose();
		return;
	}
	let initialRunId: string | undefined;
	const query = runQuery?.trim();
	if (query) {
		const matches = registry.findRunsByPrefix(query);
		if (matches.length === 0) {
			ctx.ui.notify(`No subagent run matches "${query}".`, "warning");
			return;
		}
		if (matches.length > 1) {
			ctx.ui.notify(`Ambiguous subagent run prefix "${query}" (${matches.length} matches).`, "warning");
			return;
		}
		initialRunId = matches[0].id;
	}
	const warning = getCompatibilityWarning();
	if (warning) ctx.ui.notify(warning, "warning");
	try {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const close = () => done(undefined);
				activeOverlayClose = close;
				return new SubagentOverlay(tui, theme, close, registry, initialRunId);
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				},
			},
		);
	} finally {
		activeOverlayClose = undefined;
	}
}

function parseContinueArgs(args: string): { run: string; instruction?: string } | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;
	const [run, ...rest] = trimmed.split(/\s+/);
	return { run, instruction: rest.join(" ").trim() || undefined };
}

function shouldIncludeProjectAgentGuidance(prompt: string): boolean {
	const projectAgentTarget = String.raw`(?:project[-\s]?local\s+agents?|project agents?|\.pi\/agents)`;
	const negatedProjectAgentIntent = new RegExp(
		String.raw`\b(?:do\s+not|don't|dont|avoid|without|never|no)\b[^.!?\n]{0,80}${projectAgentTarget}\b`,
		"i",
	);
	if (negatedProjectAgentIntent.test(prompt)) return false;
	return /(?:\.pi\/agents|agentScope\s*[:=]\s*["']?(?:both|project)\b|\b(?:use|include|enable|list|show|discover|load)\s+(?:trusted\s+)?(?:project[-\s]?local\s+agents?|project agents?)\b)/i.test(prompt);
}

function formatAutoDelegateStatus(config: AutoDelegateConfig, options?: { offExact?: boolean }): string {
	if (config.enabled) return `✅ Auto-delegate is ON (threshold: ${config.confidenceThreshold}%)`;
	return options?.offExact ? "❌ Auto-delegate is OFF" : `❌ Auto-delegate is OFF (threshold: ${config.confidenceThreshold}%)`;
}

function parseAutoDelegateThreshold(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const normalized = value.trim().replace(/%$/, "");
	if (!/^\d{1,3}$/.test(normalized)) return undefined;
	const threshold = Number(normalized);
	if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) return undefined;
	return threshold;
}

async function handleAutoDelegateCommand(args: string, ctx: ExtensionContext): Promise<void> {
	const trimmed = args.trim();
	if (!trimmed) {
		const current = await getAutoDelegateConfig();
		await setAutoDelegateEnabled(!current.enabled);
		const updated = await getAutoDelegateConfig();
		ctx.ui.notify(formatAutoDelegateStatus(updated, { offExact: !updated.enabled }), "info");
		return;
	}

	const [rawAction, ...rest] = trimmed.split(/\s+/);
	const action = rawAction.toLowerCase();
	if (["on", "enable", "enabled", "true", "yes"].includes(action)) {
		await setAutoDelegateEnabled(true);
		ctx.ui.notify(formatAutoDelegateStatus(await getAutoDelegateConfig()), "info");
		return;
	}
	if (["off", "disable", "disabled", "false", "no"].includes(action)) {
		await setAutoDelegateEnabled(false);
		ctx.ui.notify("❌ Auto-delegate is OFF", "info");
		return;
	}
	if (action === "status") {
		ctx.ui.notify(formatAutoDelegateStatus(await getAutoDelegateConfig()), "info");
		return;
	}
	if (action === "threshold") {
		const threshold = parseAutoDelegateThreshold(rest[0]);
		if (threshold === undefined) {
			ctx.ui.notify("Usage: /auto-delegate threshold <0-100>", "warning");
			return;
		}
		await setAutoDelegateConfig({ confidenceThreshold: threshold });
		const updated = await getAutoDelegateConfig();
		ctx.ui.notify(
			updated.enabled
				? formatAutoDelegateStatus(updated)
				: `Auto-delegate threshold set to ${updated.confidenceThreshold}% (currently OFF)`,
			"info",
		);
		return;
	}

	ctx.ui.notify("Usage: /auto-delegate [on|off|status|threshold <0-100>]", "warning");
}

function parseAutoDelegateDirective(text: string): string | undefined {
	const trimmed = text.trim();
	const slashMatch = trimmed.match(/^\/(?:auto-delegate|delegate-auto)\b\s*(.*)$/i);
	if (slashMatch) return slashMatch[1]?.trim() ?? "";
	if (!trimmed || trimmed.includes("?")) return undefined;

	const target = String.raw`(?:auto[-\s]?delegat(?:e|ion)|automatic\s+agent\s+delegation)`;
	if (new RegExp(String.raw`^(?:please\s+)?(?:enable|activate)\s+${target}$`, "i").test(trimmed)) return "on";
	if (new RegExp(String.raw`^(?:please\s+)?(?:turn|switch)\s+on\s+${target}$`, "i").test(trimmed)) return "on";
	if (new RegExp(String.raw`^${target}\s+on$`, "i").test(trimmed)) return "on";
	if (new RegExp(String.raw`^(?:please\s+)?(?:disable|deactivate)\s+${target}$`, "i").test(trimmed)) return "off";
	if (new RegExp(String.raw`^(?:please\s+)?(?:turn|switch)\s+off\s+${target}$`, "i").test(trimmed)) return "off";
	if (new RegExp(String.raw`^${target}\s+off$`, "i").test(trimmed)) return "off";
	if (new RegExp(String.raw`^${target}\s+status$`, "i").test(trimmed)) return "status";

	const thresholdMatch =
		trimmed.match(new RegExp(String.raw`^(?:please\s+)?(?:set|change)\s+${target}\s+threshold\s+(?:to\s+)?(\d{1,3})%?$`, "i")) ??
		trimmed.match(new RegExp(String.raw`^${target}\s+threshold\s+(\d{1,3})%?$`, "i"));
	if (thresholdMatch) return `threshold ${thresholdMatch[1]}`;

	return undefined;
}

async function executeAutoDelegation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	match: AgentMatch,
	confidence: number,
	userMessage: string,
): Promise<void> {
	const header = `[AUTO-DELEGATED to ${match.name} (${confidence}% confidence)]`;

	try {
		const agentScope: AgentScope = "user";
		const discovery = discoverAgents(ctx.cwd, agentScope);
		const agents = discovery.agents;
		const sessionFile = getSessionFile(ctx);
		const parentModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		const parentThinking = pi.getThinkingLevel();
		const parentToolCallId = `auto-delegate:${Date.now()}`;
		const makeDetails = (mode: "single" | "chain") =>
			(results: SingleResult[]): SubagentDetails => ({
				mode,
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				results: mode === "chain" ? withSequentialChainSteps(results) : results,
			});

		ctx.ui.notify(header, "info");
		const result = await runSingleAgent(
			ctx.cwd,
			agents,
			match.name,
			match.suggestedTask,
			undefined,
			undefined,
			ctx.signal,
			undefined,
			makeDetails("single"),
			{ parentToolCallId, mode: "single", index: 0, sessionFile, parentModel, parentThinking },
		);
		const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
		const handoffResults = isError
			? []
			: await executeHandoffsForResult(
					ctx,
					agents,
					result,
					ctx.signal,
					undefined,
					makeDetails("chain"),
					{
						parentToolCallId,
						mode: "chain",
						index: 0,
						sessionFile,
						parentModel,
						parentThinking,
						handoffDepth: 0,
					},
				);
		const allResults = [result, ...handoffResults];
		const output = isError
			? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
			: getFinalOutput(result.messages) || "(no output)";
		const details = makeDetails(handoffResults.length > 0 ? "chain" : "single")(allResults);
		pi.sendMessage({
			customType: "auto-delegate-result",
			content: `${header}\n\nOriginal request: ${userMessage}\n\n${output}`,
			display: true,
			details: { header, agent: match.name, confidence, originalRequest: userMessage, isError, subagent: details },
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Auto-delegation failed: ${message}`, "error");
		debugLog(`Auto-delegation error: ${message}`);
		pi.sendMessage({
			customType: "auto-delegate-result",
			content: `${header}\n\nOriginal request: ${userMessage}\n\nAuto-delegation failed: ${message}`,
			display: true,
			details: { header, agent: match.name, confidence, originalRequest: userMessage, isError: true },
		});
	}
}

async function executeHandoffsForResult(
	ctx: ExtensionContext,
	agents: AgentConfig[],
	sourceResult: SingleResult,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	runMeta: RunMeta,
	displayBaseResults: SingleResult[] = [sourceResult],
): Promise<SingleResult[]> {
	const depth = runMeta.handoffDepth ?? 0;
	const output = getFinalOutput(sourceResult.messages);
	debugLog(
		`executeHandoffsForResult: source=${sourceResult.agent}; runId=${sourceResult.runId ?? "none"}; exitCode=${sourceResult.exitCode}; stopReason=${sourceResult.stopReason ?? "none"}; depth=${depth}; finalOutputLength=${output.length}; hasHandoffKey=${/"(?:handoff|handoffs|delegate|delegates|delegations)"\s*:/.test(output)}`,
	);
	if (sourceResult.exitCode !== 0 || sourceResult.stopReason === "error" || sourceResult.stopReason === "aborted") {
		debugLog(`executeHandoffsForResult: skipped for ${sourceResult.agent} because source run did not complete successfully`);
		return [];
	}
	const toolRequests = extractHandoffRequestsFromMessages(sourceResult.messages);
	const textRequests = toolRequests.length === 0 ? extractHandoffRequests(output) : [];
	const requests = [...toolRequests, ...textRequests];
	debugLog(
		`executeHandoffsForResult: extracted ${requests.length} request(s) from ${sourceResult.agent}; tool=${toolRequests.length}; text=${textRequests.length}`,
	);
	if (requests.length === 0) return [];
	const config = loadSubagentConfig();
	debugLog(
		`executeHandoffsForResult: loaded config handoff=${JSON.stringify(config.handoff)}; availableAgents=${agents.map((agent) => `${agent.name}:${agent.source}`).join(",")}`,
	);
	const sourceAgent = agents.find((agent) => agent.name === sourceResult.agent);
	if (!sourceAgent) {
		debugLog(`executeHandoffsForResult: source agent '${sourceResult.agent}' not found in discovered agents; skipping`);
		return [];
	}
	debugLog(
		`executeHandoffsForResult: sourceAgent=${sourceAgent.name}; source=${sourceAgent.source}; allowList=${JSON.stringify(sourceAgent.handoffAllowList ?? [])}`,
	);
	const childResults: SingleResult[] = [];
	for (let i = 0; i < requests.length; i++) {
		const request = requests[i];
		const targetAgent = agents.find((agent) => agent.name === request.agent);
		debugLog(
			`executeHandoffsForResult: evaluating request #${i + 1}/${requests.length}: ${sourceAgent.name} -> ${request.agent}; targetFound=${Boolean(targetAgent)}; taskLength=${request.task.length}; reason=${JSON.stringify(request.reason ?? "")}`,
		);
		const decision = decideHandoff(request, sourceAgent, targetAgent, config, depth, i);
		if (!decision.allowed || !targetAgent) {
			debugLog(`executeHandoffsForResult: request #${i + 1} skipped; reason=${decision.reason ?? "unknown"}`);
			if (ctx.hasUI && decision.reason) ctx.ui.notify(`Handoff skipped: ${decision.reason}`, "warning");
			continue;
		}
		if (await shouldAskApprovalForHandoff(ctx, request, sourceAgent, targetAgent, config)) {
			debugLog(`executeHandoffsForResult: requesting approval for ${sourceAgent.name} -> ${targetAgent.name}`);
			const ok = await confirmHandoff(ctx, request, sourceAgent, targetAgent);
			debugLog(`executeHandoffsForResult: approval ${ok ? "granted" : "denied"} for ${sourceAgent.name} -> ${targetAgent.name}`);
			if (!ok) continue;
		}
		const handoffTask = request.reason ? `${request.task}\n\nHandoff reason from ${sourceAgent.name}: ${request.reason}` : request.task;
		const visibleBefore = [...displayBaseResults, ...childResults];
		const handoffStep = visibleBefore.length + 1;
		const handoffInfo: HandoffInfo = {
			fromAgent: sourceAgent.name,
			depth: depth + 1,
			...(sourceResult.runId ? { fromRunId: sourceResult.runId } : {}),
			...(request.reason ? { reason: request.reason } : {}),
		};
		const handoffUpdate: OnUpdateCallback | undefined = onUpdate
			? (partial) => {
					const currentResult = partial.details?.results[partial.details.results.length - 1];
					if (!currentResult) {
						onUpdate(partial);
						return;
					}
					onUpdate({
						content: partial.content,
						details: makeDetails([...visibleBefore, currentResult]),
					});
				}
			: undefined;
		debugLog(`executeHandoffsForResult: executing handoff ${sourceAgent.name} -> ${targetAgent.name}; depth=${depth + 1}; step=${handoffStep}`);
		const result = await runSingleAgent(
			request.cwd || sourceResult.cwd || ctx.cwd,
			agents,
			targetAgent.name,
			handoffTask,
			request.cwd || sourceResult.cwd || ctx.cwd,
			handoffStep,
			signal,
			handoffUpdate,
			makeDetails,
			{
				parentToolCallId: `${sourceResult.runId ?? runMeta.parentToolCallId}:handoff:${i}`,
				mode: runMeta.mode,
				index: handoffStep - 1,
				sessionFile: runMeta.sessionFile,
				parentModel: runMeta.parentModel,
				parentThinking: runMeta.parentThinking,
				handoffDepth: (runMeta.handoffDepth ?? 0) + 1,
				handoff: handoffInfo,
			},
		);
		childResults.push(result);
		debugLog(
			`executeHandoffsForResult: handoff result ${targetAgent.name}; exitCode=${result.exitCode}; stopReason=${result.stopReason ?? "none"}; runId=${result.runId ?? "none"}`,
		);
		const nested = await executeHandoffsForResult(
			ctx,
			agents,
			result,
			signal,
			onUpdate,
			makeDetails,
			{
				...runMeta,
				parentToolCallId: result.runId ?? runMeta.parentToolCallId,
				handoffDepth: (runMeta.handoffDepth ?? 0) + 1,
			},
			[...displayBaseResults, ...childResults],
		);
		childResults.push(...nested);
	}
	return childResults;
}

async function continueSubagentRun(
	ctx: ExtensionContext,
	runQuery: string,
	instruction: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	parentToolCallId: string,
	parentThinking?: string,
): Promise<SingleResult> {
	const matches = registry.findRunsByPrefix(runQuery);
	if (matches.length === 0) throw new Error(`No subagent run matches "${runQuery}".`);
	if (matches.length > 1) throw new Error(`Ambiguous subagent run prefix "${runQuery}" (${matches.length} matches).`);
	const run = matches[0];
	if (!run.childSessionRef) {
		throw new Error(`Run ${formatRunLabel(run.agent, run.id)} was created before child sessions were enabled and is view-only.`);
	}
	const childSessionPath = childSessionStorage.resolveRef(run.childSessionRef);
	if (!childSessionPath || !fs.existsSync(childSessionPath)) {
		throw new Error(`Run ${formatRunLabel(run.agent, run.id)} has no readable child session file.`);
	}
	const discovery = discoverAgents(run.cwd || ctx.cwd, "both");
	const agents = discovery.agents;
	const task = instruction
		? `Continue from where you stopped. ${instruction}`
		: "Continue from where you stopped. Continue the previous task from the existing subagent session context.";
	const makeDetails = (_results: SingleResult[]): SubagentDetails => ({
		mode: run.mode,
		agentScope: "both",
		projectAgentsDir: discovery.projectAgentsDir,
		results: _results,
	});
	return runSingleAgent(
		run.cwd || ctx.cwd,
		agents,
		run.agent,
		task,
		run.cwd || ctx.cwd,
		run.step,
		signal,
		onUpdate,
		makeDetails,
		{
			parentToolCallId,
			mode: run.mode,
			index: run.index,
			sessionFile: getSessionFile(ctx),
			parentModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			parentThinking,
			existingRunId: run.id,
			continuation: true,
		},
	);
}

export default function (pi: ExtensionAPI) {
	const runningAsSubagent = isSubagentChildProcess();
	registerSubagentRequestHeaders(pi);
	debugLog(
		runningAsSubagent
			? `Detected child subagent process${process.env.PI_SUBAGENT_AGENT ? ` (${process.env.PI_SUBAGENT_AGENT})` : ""}; skipping subagent orchestration tools.`
			: "Detected parent pi process; registering subagent orchestration tools.",
	);

	pi.on("session_start", async (_event, ctx) => {
		await registry.hydrateFromSessionEntries(ctx.sessionManager.getBranch(), transcriptStorage);
	});

	pi.on("session_shutdown", async () => {
		activeOverlayClose?.();
		activeOverlayClose = undefined;
		registry.clearVolatileSubscribers();
	});

	pi.registerMessageRenderer("auto-delegate-result", (message, _options, theme) => {
		const details = message.details as { header?: string; isError?: boolean } | undefined;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
		const [firstLine, ...rest] = text.split("\n");
		const header = details?.header ?? firstLine ?? "[AUTO-DELEGATED]";
		const body = rest.join("\n").trim();
		const container = new Container();
		container.addChild(new Text(theme.fg(details?.isError ? "error" : "success", theme.bold(header)), 0, 0));
		if (body) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
		}
		return container;
	});

	const registerAutoDelegateCommand = (name: string) => {
		pi.registerCommand(name, {
			description: "Toggle automatic agent delegation",
			handler: async (args, ctx) => {
				await handleAutoDelegateCommand(args, ctx);
			},
		});
	};
	registerAutoDelegateCommand("auto-delegate");
	registerAutoDelegateCommand("delegate-auto");

	pi.registerCommand("subagents", {
		description: "Open the live/historical subagent view, optionally focused by run id prefix",
		handler: async (args, ctx) => {
			await openSubagentsOverlay(ctx, args);
		},
	});

	pi.registerCommand("subagent-model", {
		description: "Configure which model each subagent uses",
		handler: async (_args, ctx) => {
			await openSubagentModelSelector(ctx, "both", pi.getThinkingLevel());
		},
	});

	pi.registerCommand("subagent-handoff", {
		description: "Configure subagent handoff behavior",
		handler: async (_args, ctx) => {
			await openSubagentHandoffConfig(ctx);
		},
	});

	pi.registerCommand("subagent-continue", {
		description: "Continue a previous continuable subagent run by run id prefix",
		handler: async (args, ctx) => {
			const parsed = parseContinueArgs(args);
			if (!parsed) {
				ctx.ui.notify("Usage: /subagent-continue <run-prefix> [instruction]", "warning");
				return;
			}
			try {
				const result = await continueSubagentRun(
					ctx,
					parsed.run,
					parsed.instruction,
					ctx.signal,
					undefined,
					`command:${parsed.run}`,
					pi.getThinkingLevel(),
				);
				pi.appendEntry("subagent-run-update", { result });
				ctx.ui.notify(`Continued ${formatRunLabel(result.agent, result.runId)}.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});

	pi.registerShortcut("ctrl+shift+o", {
		description: "Open/close the live subagent view",
		handler: async (ctx) => {
			await openSubagentsOverlay(ctx);
		},
	});

	pi.registerShortcut("alt+o", {
		description: "Fallback: open/close the live subagent view",
		handler: async (ctx) => {
			await openSubagentsOverlay(ctx);
		},
	});

	const initialSubagentGuidance = generateSubagentGuidance(discoverAgents(process.cwd(), "user").agents);

	pi.on("before_agent_start", async (event, ctx) => {
		if (!event.systemPromptOptions.selectedTools?.includes("subagent")) return;
		const guidanceScope: AgentScope = shouldIncludeProjectAgentGuidance(event.prompt) ? "both" : "user";
		const dynamicGuidance = generateSubagentGuidance(discoverAgents(ctx.cwd, guidanceScope).agents);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${dynamicGuidance.promptSection}`,
		};
	});

	if (runningAsSubagent) {
		pi.registerTool({
			name: "handoff",
			label: "Handoff",
			description: "Request that another specialized agent continues the work after you finish. The parent process will invoke the target agent.",
			parameters: Type.Object({
				agent: Type.String({ description: "Name of the target agent to hand off to" }),
				task: Type.String({ description: "Task description for the target agent" }),
				reason: Type.Optional(Type.String({ description: "Why this handoff is needed" })),
			}),
			async execute(_toolCallId, params) {
				return {
					content: [
						{
							type: "text",
							text: `Handoff to "${params.agent}" registered. The parent process will invoke ${params.agent} after you finish.`,
						},
					],
				};
			},
		});
	} else {
		pi.on("input", async (event, ctx) => {
			if (event.source === "extension") return { action: "continue" };

			const directive = parseAutoDelegateDirective(event.text);
			if (directive !== undefined) {
				await handleAutoDelegateCommand(directive, ctx);
				return { action: "handled" };
			}

			const userMessage = event.text.trim();
			if (!userMessage || userMessage.startsWith("/") || (event.images?.length ?? 0) > 0) return { action: "continue" };

			const config = await getAutoDelegateConfig();
			if (!config.enabled || !config.autoExecute) return { action: "continue" };

			const match = await findBestAgent(userMessage);
			if (!match) return { action: "continue" };

			const confidence = Math.round(match.score * 100);
			if (confidence < config.confidenceThreshold) return { action: "continue" };

			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				const timeoutMs = 5 * 60 * 1000; // 5 minutos timeout
				await Promise.race([
					executeAutoDelegation(pi, ctx, match, confidence, userMessage),
					new Promise<never>((_, reject) => {
						timeout = setTimeout(() => reject(new Error("Auto-delegation timeout (5 minutes)")), timeoutMs);
					}),
				]);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Auto-delegation failed: ${message}`, "error");
				debugLog(`Auto-delegation error: ${message}`);
			} finally {
				if (timeout) clearTimeout(timeout);
			}
			return { action: "handled" };
		});

		pi.registerTool({
			name: "delegate",
			label: "Delegate",
			description:
				"Analyze your request and find the best specialized agent to handle it. Returns agent name, confidence score, and suggested task.",
			parameters: Type.Object({
				request: Type.String({
					description: "Your request or task description",
				}),
			}),
			async execute(_toolCallId, params) {
				const match = await findBestAgent(params.request);

				if (!match) {
					return {
						content: [
							{
								type: "text",
								text: "No suitable agent found for this request. Available agents: scout, planner, reviewer, worker, debugger",
							},
						],
					};
				}

				const confidence = (match.score * 100).toFixed(0);
				const reasoning = match.reasoning || "No explicit metadata matched; selected the top available agent.";
				return {
					content: [
						{
							type: "text",
							text: `Best agent: **${match.name}** (confidence: ${confidence}%)\n\nReasoning: ${reasoning}\n\nSuggested task: "${match.suggestedTask}"\n\nYou can now call the subagent tool with agent: "${match.name}" and the suggested task.`,
						},
					],
				};
			},
		});

		pi.registerTool({
			name: "subagent_continue",
			label: "Continue Subagent",
			description: "Continue a previous continuable subagent run by short run id, full id, or agent@id label.",
			promptSnippet: "Continue a previous subagent run by short run id or agent@id label",
			promptGuidelines: [
				"Use subagent_continue when the user asks to continue, resume, or pick up a previous subagent run by id, short id, or agent@id label.",
			],
			parameters: SubagentContinueParams,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const result = await continueSubagentRun(
					ctx,
					params.run,
					params.instruction,
					signal,
					onUpdate
						? (partial) => {
								onUpdate({ content: partial.content, details: { result: partial.details?.results[0] } });
							}
						: undefined,
					toolCallId,
					pi.getThinkingLevel(),
				);
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || `Continued ${formatRunLabel(result.agent, result.runId)}.` }],
					details: { result },
				};
			},
		});

		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description: [
				"Delegate tasks to specialized subagents with isolated context.",
				"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
				"Child subagents may request handoffs by calling the handoff tool; legacy JSON handoff output remains supported as a fallback.",
				'Default agent scope is "user" (from ~/.pi/agent/agents).',
				'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
			].join(" "),
			promptSnippet: initialSubagentGuidance.promptSnippet,
			promptGuidelines: initialSubagentGuidance.promptGuidelines,
			parameters: SubagentParams,

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const agentScope: AgentScope = params.agentScope ?? "user";
				const discovery = discoverAgents(ctx.cwd, agentScope);
				const agents = discovery.agents;
				const confirmProjectAgents = params.confirmProjectAgents ?? true;
				const sessionFile = getSessionFile(ctx);
				const parentModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
				const parentThinking = pi.getThinkingLevel();

				const hasChain = (params.chain?.length ?? 0) > 0;
				const hasTasks = (params.tasks?.length ?? 0) > 0;
				const hasSingle = Boolean(params.agent && params.task);
				const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

				const makeDetails =
					(mode: "single" | "parallel" | "chain") =>
					(results: SingleResult[]): SubagentDetails => ({
						mode,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results: mode === "chain" ? withSequentialChainSteps(results) : results,
					});

				if (modeCount !== 1) {
					const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
					return {
						content: [
							{
								type: "text",
								text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
							},
						],
						details: makeDetails("single")([]),
					};
				}

				if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
					const requestedAgentNames = new Set<string>();
					if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
					if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
					if (params.agent) requestedAgentNames.add(params.agent);

					const projectAgentsRequested = Array.from(requestedAgentNames)
						.map((name) => agents.find((a) => a.name === name))
						.filter((a): a is AgentConfig => a?.source === "project");

					if (projectAgentsRequested.length > 0) {
						const names = projectAgentsRequested.map((a) => a.name).join(", ");
						const dir = discovery.projectAgentsDir ?? "(unknown)";
						const ok = await ctx.ui.confirm(
							"Run project-local agents?",
							`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
						);
						if (!ok)
							return {
								content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
								details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
							};
					}
				}

				if (params.chain && params.chain.length > 0) {
					const results: SingleResult[] = [];
					let previousOutput = "";

					for (let i = 0; i < params.chain.length; i++) {
						const step = params.chain[i];
						const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

						// Create update callback that includes all previous results
						const chainUpdate: OnUpdateCallback | undefined = onUpdate
							? (partial) => {
									// Combine completed results with current streaming result
									const currentResult = partial.details?.results[0];
									if (currentResult) {
										const allResults = [...results, currentResult];
										onUpdate({
											content: partial.content,
											details: makeDetails("chain")(allResults),
										});
									}
								}
							: undefined;

						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							step.agent,
							taskWithContext,
							step.cwd,
							i + 1,
							signal,
							chainUpdate,
							makeDetails("chain"),
							{ parentToolCallId: toolCallId, mode: "chain", index: i, sessionFile, parentModel, parentThinking },
						);
						results.push(result);

						const isError =
							result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
						if (isError) {
							const errorMsg =
								result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
							return {
								content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
								details: makeDetails("chain")(results),
								isError: true,
							};
						}
						const handoffResults = await executeHandoffsForResult(
							ctx,
							agents,
							result,
							signal,
							onUpdate,
							makeDetails("chain"),
							{
								parentToolCallId: toolCallId,
								mode: "chain",
								index: i,
								sessionFile,
								parentModel,
								parentThinking,
								handoffDepth: 0,
							},
							results,
						);
						results.push(...handoffResults);
						previousOutput = getFinalOutput(result.messages);
					}
					return {
						content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
						details: makeDetails("chain")(results),
					};
				}

				if (params.tasks && params.tasks.length > 0) {
					if (params.tasks.length > MAX_PARALLEL_TASKS)
						return {
							content: [
								{
									type: "text",
									text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
								},
							],
							details: makeDetails("parallel")([]),
						};

					// Track all results for streaming updates
					const allResults: SingleResult[] = new Array(params.tasks.length);

					// Initialize placeholder results
					for (let i = 0; i < params.tasks.length; i++) {
						allResults[i] = {
							agent: params.tasks[i].agent,
							agentSource: "unknown",
							task: params.tasks[i].task,
							exitCode: -1, // -1 = still running
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						};
					}

					const emitParallelUpdate = () => {
						if (onUpdate) {
							const running = allResults.filter((r) => r.exitCode === -1).length;
							const done = allResults.filter((r) => r.exitCode !== -1).length;
							onUpdate({
								content: [
									{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
								],
								details: makeDetails("parallel")([...allResults]),
							});
						}
					};

					const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							t.agent,
							t.task,
							t.cwd,
							undefined,
							signal,
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
							{ parentToolCallId: toolCallId, mode: "parallel", index, sessionFile, parentModel, parentThinking },
						);
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					});

					const handoffResults: SingleResult[] = [];
					for (const result of results) {
						if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") continue;
						handoffResults.push(
							...(await executeHandoffsForResult(
								ctx,
								agents,
								result,
								signal,
								onUpdate,
								makeDetails("parallel"),
								{
									parentToolCallId: toolCallId,
									mode: "parallel",
									sessionFile,
									parentModel,
									parentThinking,
									handoffDepth: 0,
								},
								[...results, ...handoffResults],
							)),
						);
					}
					const allParallelResults = [...results, ...handoffResults];
					const successCount = allParallelResults.filter((r) => r.exitCode === 0).length;
					const summaries = allParallelResults.map((r) => {
						const output = getFinalOutput(r.messages);
						const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
						return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
					});
					return {
						content: [
							{
								type: "text",
								text: `Parallel: ${successCount}/${allParallelResults.length} succeeded\n\n${summaries.join("\n\n")}`,
							},
						],
						details: makeDetails("parallel")(allParallelResults),
					};
				}

				if (params.agent && params.task) {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						params.agent,
						params.task,
						params.cwd,
						undefined,
						signal,
						onUpdate,
						makeDetails("single"),
						{ parentToolCallId: toolCallId, mode: "single", index: 0, sessionFile, parentModel, parentThinking },
					);
					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
							details: makeDetails("single")([result]),
							isError: true,
						};
					}
					const handoffResults = await executeHandoffsForResult(
						ctx,
						agents,
						result,
						signal,
						onUpdate,
						makeDetails("chain"),
						{
							parentToolCallId: toolCallId,
							mode: "chain",
							index: 0,
							sessionFile,
							parentModel,
							parentThinking,
							handoffDepth: 0,
						},
					);
					const allResults = [result, ...handoffResults];
					return {
						content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
						details: makeDetails(handoffResults.length > 0 ? "chain" : "single")(allResults),
					};
				}

				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
					details: makeDetails("single")([]),
				};
			},

			renderCall(args, theme, _context) {
				const scope: AgentScope = args.agentScope ?? "user";
				if (args.chain && args.chain.length > 0) {
					let text =
						theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", `chain (${args.chain.length} steps)`) +
						theme.fg("muted", ` [${scope}]`);
					for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
						const step = args.chain[i];
						// Clean up {previous} placeholder for display
						const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
						const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
						text +=
							"\n  " +
							theme.fg("muted", `${i + 1}.`) +
							" " +
							theme.fg("accent", step.agent) +
							theme.fg("dim", ` ${preview}`);
					}
					if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
					return new Text(text, 0, 0);
				}
				if (args.tasks && args.tasks.length > 0) {
					let text =
						theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
						theme.fg("muted", ` [${scope}]`);
					for (const t of args.tasks.slice(0, 3)) {
						const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
						text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
					}
					if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
					return new Text(text, 0, 0);
				}
				const agentName = args.agent || "...";
				const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", agentName) +
					theme.fg("muted", ` [${scope}]`);
				text += `\n  ${theme.fg("dim", preview)}`;
				return new Text(text, 0, 0);
			},

			renderResult(result, { expanded }, theme, _context) {
				const details = result.details as SubagentDetails | undefined;
				if (!details || details.results.length === 0) {
					const text = result.content[0];
					return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
				}

				const mdTheme = getMarkdownTheme();
				const renderAgentName = (r: SingleResult) => colorAgentText(theme, r.agentColor, formatRunLabel(r.agent, r.runId), "accent");
				const renderAgentTitle = (r: SingleResult) => theme.bold(colorAgentText(theme, r.agentColor, formatRunLabel(r.agent, r.runId), "toolTitle"));

				const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
					const toShow = limit ? items.slice(-limit) : items;
					const skipped = limit && items.length > limit ? items.length - limit : 0;
					let text = "";
					if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
					for (const item of toShow) {
						if (item.type === "text") {
							const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
							text += `${theme.fg("toolOutput", preview)}\n`;
						} else {
							text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
						}
					}
					return text.trimEnd();
				};

				if (details.mode === "single" && details.results.length === 1) {
					const r = details.results[0];
					const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
					const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					const finalOutput = getFinalOutput(r.messages);

					if (expanded) {
						const container = new Container();
						let header = `${icon} ${renderAgentTitle(r)}${theme.fg("muted", ` (${r.agentSource})`)}`;
						if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
						container.addChild(new Text(header, 0, 0));
						if (isError && r.errorMessage)
							container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
						container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
						if (displayItems.length === 0 && !finalOutput) {
							container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
						} else {
							for (const item of displayItems) {
								if (item.type === "toolCall")
									container.addChild(
										new Text(
											theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
											0,
											0,
										),
									);
							}
							if (finalOutput) {
								container.addChild(new Spacer(1));
								container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
							}
						}
						const usageStr = formatUsageStats(r.usage, r.model);
						if (usageStr) {
							container.addChild(new Spacer(1));
							container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
						}
						return container;
					}

					let text = `${icon} ${renderAgentTitle(r)}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
					else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else {
						text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
						if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
					return new Text(text, 0, 0);
				}

				const aggregateUsage = (results: SingleResult[]) => {
					const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
					for (const r of results) {
						total.input += r.usage.input;
						total.output += r.usage.output;
						total.cacheRead += r.usage.cacheRead;
						total.cacheWrite += r.usage.cacheWrite;
						total.cost += r.usage.cost;
						total.turns += r.usage.turns;
					}
					return total;
				};

				if (details.mode === "chain") {
					const successCount = details.results.filter((r) => r.exitCode === 0).length;
					const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const hasHandoff = details.results.some((r) => r.handoff);
					const chainTitle = hasHandoff ? "chain + handoff " : "chain ";
					const renderHandoffNote = (r: SingleResult) =>
						r.handoff ? theme.fg("muted", ` [handoff from ${r.handoff.fromAgent}]`) : "";

					if (expanded) {
						const container = new Container();
						container.addChild(
							new Text(
								icon +
									" " +
									theme.fg("toolTitle", theme.bold(chainTitle)) +
									theme.fg("accent", `${successCount}/${details.results.length} steps`),
								0,
								0,
							),
						);

						for (let index = 0; index < details.results.length; index++) {
							const r = details.results[index];
							const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
							const displayItems = getDisplayItems(r.messages);
							const finalOutput = getFinalOutput(r.messages);

							container.addChild(new Spacer(1));
							container.addChild(
								new Text(
									`${theme.fg("muted", `─── Step ${index + 1}: `) + renderAgentName(r)} ${rIcon}${renderHandoffNote(r)}`,
									0,
									0,
								),
							);
							container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

							// Show tool calls
							for (const item of displayItems) {
								if (item.type === "toolCall") {
									container.addChild(
										new Text(
											theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
											0,
											0,
										),
									);
								}
							}

							// Show final output as markdown
							if (finalOutput) {
								container.addChild(new Spacer(1));
								container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
							}

							const stepUsage = formatUsageStats(r.usage, r.model);
							if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
						}

						const usageStr = formatUsageStats(aggregateUsage(details.results));
						if (usageStr) {
							container.addChild(new Spacer(1));
							container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
						}
						return container;
					}

					// Collapsed view
					let text =
						icon +
						" " +
						theme.fg("toolTitle", theme.bold(chainTitle)) +
						theme.fg("accent", `${successCount}/${details.results.length} steps`);
					for (let index = 0; index < details.results.length; index++) {
						const r = details.results[index];
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						text += `\n\n${theme.fg("muted", `─── Step ${index + 1}: `)}${renderAgentName(r)} ${rIcon}${renderHandoffNote(r)}`;
						if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
						else text += `\n${renderDisplayItems(displayItems, 5)}`;
					}
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
					text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
					return new Text(text, 0, 0);
				}

				if (details.mode === "parallel") {
					const running = details.results.filter((r) => r.exitCode === -1).length;
					const successCount = details.results.filter((r) => r.exitCode === 0).length;
					const failCount = details.results.filter((r) => r.exitCode > 0).length;
					const isRunning = running > 0;
					const icon = isRunning
						? theme.fg("warning", "⏳")
						: failCount > 0
							? theme.fg("warning", "◐")
							: theme.fg("success", "✓");
					const status = isRunning
						? `${successCount + failCount}/${details.results.length} done, ${running} running`
						: `${successCount}/${details.results.length} tasks`;
					const hasHandoff = details.results.some((r) => r.handoff);
					const parallelTitle = hasHandoff ? "parallel + handoff " : "parallel ";
					const renderHandoffNote = (r: SingleResult) =>
						r.handoff ? theme.fg("muted", ` [handoff from ${r.handoff.fromAgent}]`) : "";

					if (expanded && !isRunning) {
						const container = new Container();
						container.addChild(
							new Text(
								`${icon} ${theme.fg("toolTitle", theme.bold(parallelTitle))}${theme.fg("accent", status)}`,
								0,
								0,
							),
						);

						for (const r of details.results) {
							const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
							const displayItems = getDisplayItems(r.messages);
							const finalOutput = getFinalOutput(r.messages);

							container.addChild(new Spacer(1));
							container.addChild(
								new Text(`${theme.fg("muted", "─── ") + renderAgentName(r)} ${rIcon}${renderHandoffNote(r)}`, 0, 0),
							);
							container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

							// Show tool calls
							for (const item of displayItems) {
								if (item.type === "toolCall") {
									container.addChild(
										new Text(
											theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
											0,
											0,
										),
									);
								}
							}

							// Show final output as markdown
							if (finalOutput) {
								container.addChild(new Spacer(1));
								container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
							}

							const taskUsage = formatUsageStats(r.usage, r.model);
							if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
						}

						const usageStr = formatUsageStats(aggregateUsage(details.results));
						if (usageStr) {
							container.addChild(new Spacer(1));
							container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
						}
						return container;
					}

					// Collapsed view (or still running)
					let text = `${icon} ${theme.fg("toolTitle", theme.bold(parallelTitle))}${theme.fg("accent", status)}`;
					for (const r of details.results) {
						const rIcon =
							r.exitCode === -1
								? theme.fg("warning", "⏳")
								: r.exitCode === 0
									? theme.fg("success", "✓")
									: theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						text += `\n\n${theme.fg("muted", "─── ")}${renderAgentName(r)} ${rIcon}${renderHandoffNote(r)}`;
						if (displayItems.length === 0)
							text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
						else text += `\n${renderDisplayItems(displayItems, 5)}`;
					}
					if (!isRunning) {
						const usageStr = formatUsageStats(aggregateUsage(details.results));
						if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
					}
					if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
					return new Text(text, 0, 0);
				}

				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			},
		});
	}
}
