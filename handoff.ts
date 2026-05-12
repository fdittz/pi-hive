import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { loadSubagentConfig, saveSubagentConfig, type HandoffMode, type SubagentConfig } from "./subagent-config.js";

export interface HandoffRequest {
	agent: string;
	task: string;
	reason?: string;
	cwd?: string;
}

export interface HandoffDecision {
	allowed: boolean;
	reason?: string;
}

function debugLog(message: string): void {
	if (process.env.PI_HIVE_DEBUG !== "1" && process.env.PI_SUBAGENT_DEBUG !== "1") return;
	console.error(`[pi-hive:handoff] ${message}`);
}

function debugPreview(text: string, maxLength = 240): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRequest(value: unknown): HandoffRequest | undefined {
	if (!isRecord(value)) return undefined;
	const agent = typeof value.agent === "string" ? value.agent.trim() : "";
	const task = typeof value.task === "string" ? value.task.trim() : "";
	if (!agent || !task) return undefined;
	return {
		agent,
		task,
		reason: typeof value.reason === "string" ? value.reason.trim() : undefined,
		cwd: typeof value.cwd === "string" ? value.cwd.trim() : undefined,
	};
}

function extractFromParsed(parsed: unknown): HandoffRequest[] {
	const requests: HandoffRequest[] = [];
	if (!isRecord(parsed)) return requests;
	const single = normalizeRequest(parsed.handoff) ?? normalizeRequest(parsed.delegate) ?? normalizeRequest(parsed);
	if (single) requests.push(single);
	const many = parsed.handoffs ?? parsed.delegations ?? parsed.delegates;
	if (Array.isArray(many)) {
		for (const item of many) {
			const request = normalizeRequest(item);
			if (request) requests.push(request);
		}
	}
	return requests;
}

export function extractHandoffRequestsFromMessages(messages: Message[]): HandoffRequest[] {
	const requests: HandoffRequest[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type !== "toolCall" || part.name !== "handoff") continue;
			const request = normalizeRequest(part.arguments);
			if (!request) continue;
			requests.push({
				agent: request.agent,
				task: request.task,
				...(request.reason ? { reason: request.reason } : {}),
			});
		}
	}
	if (requests.length > 0) debugLog(`extractHandoffRequestsFromMessages: parsed ${requests.length} handoff request(s)`);
	return requests;
}

function hasHandoffLikeKey(text: string): boolean {
	return /"(?:handoff|handoffs|delegate|delegates|delegations)"\s*:/.test(text);
}

function tryParseJson(text: string, label?: string): HandoffRequest[] {
	try {
		const requests = extractFromParsed(JSON.parse(text));
		if (label && requests.length > 0) debugLog(`${label}: parsed ${requests.length} handoff request(s)`);
		return requests;
	} catch (error) {
		if (label) debugLog(`${label}: JSON parse failed: ${formatError(error)}; preview=${JSON.stringify(debugPreview(text))}`);
		return [];
	}
}

function findBalancedJsonObject(text: string, start: number): string | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
			if (depth < 0) return undefined;
		}
	}
	return undefined;
}

function extractNearbyJsonCandidates(text: string): string[] {
	const candidates: string[] = [];
	const keyRegex = /"(?:handoff|handoffs|delegate|delegates|delegations)"\s*:/g;
	let match: RegExpExecArray | null;
	while ((match = keyRegex.exec(text))) {
		const lowerBound = Math.max(0, match.index - 4000);
		for (let start = match.index; start >= lowerBound; start--) {
			if (text[start] !== "{") continue;
			const candidate = findBalancedJsonObject(text, start);
			if (candidate && candidate.includes(match[0])) {
				candidates.push(candidate);
				break;
			}
		}
	}
	return candidates;
}

export function extractHandoffRequests(text: string): HandoffRequest[] {
	const requests: HandoffRequest[] = [];
	const seen = new Set<string>();
	const add = (request: HandoffRequest) => {
		const key = JSON.stringify(request);
		if (seen.has(key)) return;
		seen.add(key);
		requests.push(request);
	};
	const reset = () => {
		requests.length = 0;
		seen.clear();
	};

	const trimmed = text.trim();
	for (const request of tryParseJson(trimmed, trimmed.startsWith("{") ? "whole output" : undefined)) add(request);
	if (requests.length > 0) {
		debugLog(`extractHandoffRequests: whole output produced ${requests.length} request(s)`);
		return requests;
	}

	type FenceCandidate = { body: string; index: number; end: number; label: string };
	const fenceCandidates: FenceCandidate[] = [];

	let explicitJsonFenceCount = 0;
	const jsonFenceRegex = /^[ \t]*```[ \t]*json[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gim;
	let match: RegExpExecArray | null;
	while ((match = jsonFenceRegex.exec(text))) {
		explicitJsonFenceCount++;
		fenceCandidates.push({
			body: match[1].trim(),
			index: match.index,
			end: match.index + match[0].length,
			label: `json fence #${explicitJsonFenceCount} at offset ${match.index}`,
		});
	}

	let genericFenceCount = 0;
	const genericFenceRegex = /^[ \t]*```(?![ \t]*json\b)[^\r\n]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gim;
	while ((match = genericFenceRegex.exec(text))) {
		genericFenceCount++;
		fenceCandidates.push({
			body: match[1].trim(),
			index: match.index,
			end: match.index + match[0].length,
			label: `generic fence #${genericFenceCount} at offset ${match.index}`,
		});
	}

	// Prefer a terminal JSON handoff block. Scout outputs often quote documentation that
	// contains example handoff JSON blocks; treating every fence as executable can launch
	// example handoffs. The intended protocol is for actionable handoff JSON to be at the
	// end of the final answer.
	for (const candidate of fenceCandidates) {
		if (!hasHandoffLikeKey(candidate.body)) continue;
		if (text.slice(candidate.end).trim().length > 0) continue;
		for (const request of tryParseJson(candidate.body, `${candidate.label} (terminal)`)) add(request);
	}
	if (requests.length > 0) {
		debugLog(
			`extractHandoffRequests: terminal fence produced ${requests.length} request(s); textLength=${text.length}, explicitJsonFences=${explicitJsonFenceCount}, genericFences=${genericFenceCount}`,
		);
		return requests;
	}

	reset();
	for (const candidate of fenceCandidates) {
		if (!hasHandoffLikeKey(candidate.body)) continue;
		for (const request of tryParseJson(candidate.body, candidate.label)) add(request);
	}

	const nearbyCandidates = extractNearbyJsonCandidates(text);
	for (let i = 0; i < nearbyCandidates.length; i++) {
		for (const request of tryParseJson(nearbyCandidates[i], `nearby JSON candidate #${i + 1}`)) add(request);
	}

	debugLog(
		`extractHandoffRequests: textLength=${text.length}, explicitJsonFences=${explicitJsonFenceCount}, genericFences=${genericFenceCount}, nearbyCandidates=${nearbyCandidates.length}, requests=${requests.length}`,
	);
	if (requests.length === 0 && hasHandoffLikeKey(text)) {
		debugLog(`extractHandoffRequests: handoff-like key found but no request parsed; tail=${JSON.stringify(debugPreview(text.slice(-1200)))}`);
	}
	return requests;
}

export function decideHandoff(
	request: HandoffRequest,
	sourceAgent: AgentConfig,
	targetAgent: AgentConfig | undefined,
	config: SubagentConfig,
	depth: number,
	ordinal: number,
): HandoffDecision {
	const deny = (reason: string): HandoffDecision => {
		debugLog(
			`decideHandoff: denied ${sourceAgent.name} -> ${request.agent}; reason=${JSON.stringify(reason)}; depth=${depth}; ordinal=${ordinal}; config=${JSON.stringify(config.handoff)}; sourceAllowList=${JSON.stringify(sourceAgent.handoffAllowList ?? [])}`,
		);
		return { allowed: false, reason };
	};
	if (!config.handoff.enabled || config.handoff.mode === "off") return deny("handoff is disabled");
	if (!targetAgent) return deny(`target agent '${request.agent}' is not available`);
	if (depth >= config.handoff.maxDepth) return deny(`max handoff depth ${config.handoff.maxDepth} reached`);
	if (ordinal >= config.handoff.maxHandoffsPerRun) return deny(`max handoffs per run ${config.handoff.maxHandoffsPerRun} reached`);
	if (config.handoff.blockSelfHandoff && sourceAgent.name === targetAgent.name) return deny("self handoff is blocked");
	if (sourceAgent.handoffAllowList && sourceAgent.handoffAllowList.length > 0 && !sourceAgent.handoffAllowList.includes(targetAgent.name)) {
		return deny(`${sourceAgent.name} handoffAllowList does not include ${targetAgent.name}`);
	}
	debugLog(
		`decideHandoff: allowed ${sourceAgent.name} -> ${targetAgent.name}; depth=${depth}; ordinal=${ordinal}; config=${JSON.stringify(config.handoff)}; sourceAllowList=${JSON.stringify(sourceAgent.handoffAllowList ?? [])}`,
	);
	return { allowed: true };
}

function formatConfig(config: SubagentConfig): string {
	return [
		`enabled: ${config.handoff.enabled ? "on" : "off"}`,
		`mode: ${config.handoff.mode}`,
		`maxDepth: ${config.handoff.maxDepth}`,
		`maxHandoffsPerRun: ${config.handoff.maxHandoffsPerRun}`,
		`requireApprovalForProjectAgents: ${config.handoff.requireApprovalForProjectAgents ? "on" : "off"}`,
		`blockSelfHandoff: ${config.handoff.blockSelfHandoff ? "on" : "off"}`,
	].join("\n");
}

export async function shouldAskApprovalForHandoff(
	ctx: ExtensionContext,
	request: HandoffRequest,
	sourceAgent: AgentConfig,
	targetAgent: AgentConfig,
	config: SubagentConfig,
): Promise<boolean> {
	if (!ctx.hasUI) return config.handoff.mode === "manual";
	if (config.handoff.mode === "manual") return true;
	if (config.handoff.requireApprovalForProjectAgents && targetAgent.source === "project") return true;
	return false;
}

export async function confirmHandoff(
	ctx: ExtensionContext,
	request: HandoffRequest,
	sourceAgent: AgentConfig,
	targetAgent: AgentConfig,
): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(
		"Run subagent handoff?",
		[
			`${sourceAgent.name} requested handoff to ${targetAgent.name}.`,
			request.reason ? `Reason: ${request.reason}` : undefined,
			`Task: ${request.task}`,
		].filter(Boolean).join("\n\n"),
	);
}

export async function openSubagentHandoffConfig(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return;
	while (true) {
		const config = loadSubagentConfig();
		const choice = await ctx.ui.select("Subagent handoff configuration", [
			`Toggle enabled (${config.handoff.enabled ? "on" : "off"})`,
			`Set mode (${config.handoff.mode})`,
			`Set maxDepth (${config.handoff.maxDepth})`,
			`Set maxHandoffsPerRun (${config.handoff.maxHandoffsPerRun})`,
			`Toggle requireApprovalForProjectAgents (${config.handoff.requireApprovalForProjectAgents ? "on" : "off"})`,
			`Toggle blockSelfHandoff (${config.handoff.blockSelfHandoff ? "on" : "off"})`,
			"Show current config",
		]);
		if (!choice) return;
		if (choice.startsWith("Toggle enabled")) {
			config.handoff.enabled = !config.handoff.enabled;
			await saveSubagentConfig(config);
		} else if (choice.startsWith("Set mode")) {
			const mode = await ctx.ui.select("Handoff mode", ["auto", "manual", "off"]);
			if (mode) {
				config.handoff.mode = mode as HandoffMode;
				await saveSubagentConfig(config);
			}
		} else if (choice.startsWith("Set maxDepth")) {
			const value = await ctx.ui.input("maxDepth", String(config.handoff.maxDepth));
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				config.handoff.maxDepth = Math.max(0, Math.floor(parsed));
				await saveSubagentConfig(config);
			}
		} else if (choice.startsWith("Set maxHandoffsPerRun")) {
			const value = await ctx.ui.input("maxHandoffsPerRun", String(config.handoff.maxHandoffsPerRun));
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				config.handoff.maxHandoffsPerRun = Math.max(0, Math.floor(parsed));
				await saveSubagentConfig(config);
			}
		} else if (choice.startsWith("Toggle requireApprovalForProjectAgents")) {
			config.handoff.requireApprovalForProjectAgents = !config.handoff.requireApprovalForProjectAgents;
			await saveSubagentConfig(config);
		} else if (choice.startsWith("Toggle blockSelfHandoff")) {
			config.handoff.blockSelfHandoff = !config.handoff.blockSelfHandoff;
			await saveSubagentConfig(config);
		} else if (choice === "Show current config") {
			ctx.ui.notify(formatConfig(config), "info");
		}
	}
}
