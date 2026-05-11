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

function tryParseJson(text: string): HandoffRequest[] {
	try {
		return extractFromParsed(JSON.parse(text));
	} catch {
		return [];
	}
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

	for (const request of tryParseJson(text.trim())) add(request);

	const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
	let match: RegExpExecArray | null;
	while ((match = fenceRegex.exec(text))) {
		for (const request of tryParseJson(match[1].trim())) add(request);
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
	if (!config.handoff.enabled || config.handoff.mode === "off") return { allowed: false, reason: "handoff is disabled" };
	if (!targetAgent) return { allowed: false, reason: `target agent '${request.agent}' is not available` };
	if (depth >= config.handoff.maxDepth) return { allowed: false, reason: `max handoff depth ${config.handoff.maxDepth} reached` };
	if (ordinal >= config.handoff.maxHandoffsPerRun)
		return { allowed: false, reason: `max handoffs per run ${config.handoff.maxHandoffsPerRun} reached` };
	if (config.handoff.blockSelfHandoff && sourceAgent.name === targetAgent.name) return { allowed: false, reason: "self handoff is blocked" };
	if (sourceAgent.handoffAllowList && sourceAgent.handoffAllowList.length > 0 && !sourceAgent.handoffAllowList.includes(targetAgent.name)) {
		return { allowed: false, reason: `${sourceAgent.name} handoffAllowList does not include ${targetAgent.name}` };
	}
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
