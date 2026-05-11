import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatRunLabel, getRunShortId } from "./transcript-types.js";
import { loadSubagentConfig } from "./subagent-config.js";

const ENV_PREFIX = "PI_SUBAGENT_";

export interface SubagentHeaderEnv {
	agent: string;
	runId: string;
	shortRunId: string;
	runLabel: string;
	mode: string;
	source: string;
	parentToolCallId: string;
}

export function buildSubagentHeaderEnv(input: {
	agent: string;
	runId: string;
	mode: string;
	source: string;
	parentToolCallId: string;
}): Record<string, string> {
	const shortRunId = getRunShortId(input.runId);
	const runLabel = formatRunLabel(input.agent, input.runId);
	return {
		PI_SUBAGENT: "1",
		[`${ENV_PREFIX}AGENT`]: input.agent,
		[`${ENV_PREFIX}RUN_ID`]: input.runId,
		[`${ENV_PREFIX}SHORT_RUN_ID`]: shortRunId,
		[`${ENV_PREFIX}RUN_LABEL`]: runLabel,
		[`${ENV_PREFIX}MODE`]: input.mode,
		[`${ENV_PREFIX}SOURCE`]: input.source,
		[`${ENV_PREFIX}PARENT_TOOL_CALL_ID`]: input.parentToolCallId,
	};
}

function readEnv(): SubagentHeaderEnv | undefined {
	if (process.env.PI_SUBAGENT !== "1") return undefined;
	const agent = process.env.PI_SUBAGENT_AGENT;
	if (!agent) return undefined;
	const runId = process.env.PI_SUBAGENT_RUN_ID ?? "";
	return {
		agent,
		runId,
		shortRunId: process.env.PI_SUBAGENT_SHORT_RUN_ID ?? getRunShortId(runId),
		runLabel: process.env.PI_SUBAGENT_RUN_LABEL ?? formatRunLabel(agent, runId),
		mode: process.env.PI_SUBAGENT_MODE ?? "",
		source: process.env.PI_SUBAGENT_SOURCE ?? "",
		parentToolCallId: process.env.PI_SUBAGENT_PARENT_TOOL_CALL_ID ?? "",
	};
}

function renderTemplate(template: string, env: SubagentHeaderEnv): string {
	return template
		.replace(/\{agent\}/g, env.agent)
		.replace(/\{runId\}/g, env.runId)
		.replace(/\{shortRunId\}/g, env.shortRunId)
		.replace(/\{runLabel\}/g, env.runLabel)
		.replace(/\{mode\}/g, env.mode)
		.replace(/\{source\}/g, env.source)
		.replace(/\{parentToolCallId\}/g, env.parentToolCallId);
}

function renderHeaders(headers: Record<string, string>, env: SubagentHeaderEnv): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers)
			.map(([name, value]) => [name.trim(), renderTemplate(value, env).trim()] as const)
			.filter(([name, value]) => name.length > 0 && value.length > 0),
	);
}

function providerMatches(provider: string, patterns: string[]): boolean {
	return patterns.includes("*") || patterns.includes(provider);
}

export function registerSubagentRequestHeaders(pi: ExtensionAPI): void {
	const env = readEnv();
	if (!env) return;

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const config = loadSubagentConfig().requestHeaders;
		if (!config.enabled) return;
		const headers = renderHeaders(config.headers, env);
		if (Object.keys(headers).length === 0) return;
		const providers = new Set(ctx.modelRegistry.getAll().map((model) => model.provider));
		for (const provider of providers) {
			if (!providerMatches(provider, config.providers)) continue;
			pi.registerProvider(provider, { headers });
		}
	});
}
