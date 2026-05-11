import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope } from "./agents.js";
import { discoverAgents } from "./agents.js";
import {
	formatModelRef,
	getAgentModelDisplay,
	getSubagentModelConfigPath,
	INHERIT_MODEL,
	loadSubagentModelConfig,
	setAgentModelOverride,
} from "./model-overrides.js";

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function agentOption(agent: AgentConfig, ctx: ExtensionCommandContext): string {
	const config = loadSubagentModelConfig();
	const current = getAgentModelDisplay(agent, ctx.model, config);
	return `${pad(agent.name, 16)} ${pad(agent.source, 8)} current: ${current}`;
}

function parseAgentName(option: string): string {
	return option.trim().split(/\s+/)[0] ?? option.trim();
}

function modelOption(value: string, label: string): string {
	return `${value} — ${label}`;
}

function parseModelOption(option: string): string {
	return option.split(" — ")[0]?.trim() || option.trim();
}

export async function openSubagentModelSelector(ctx: ExtensionCommandContext, scope: AgentScope = "both"): Promise<void> {
	if (!ctx.hasUI) return;

	while (true) {
		const discovery = discoverAgents(ctx.cwd, scope);
		const agents = discovery.agents.sort((a, b) => a.name.localeCompare(b.name));
		if (agents.length === 0) {
			ctx.ui.notify("No subagents are available.", "warning");
			return;
		}

		const agentOptions = agents.map((agent) => agentOption(agent, ctx));
		const selectedAgentOption = await ctx.ui.select(
			`Select subagent model (${getSubagentModelConfigPath()})`,
			agentOptions,
		);
		if (!selectedAgentOption) return;

		const agentName = parseAgentName(selectedAgentOption);
		const agent = agents.find((a) => a.name === agentName);
		if (!agent) continue;

		const parent = ctx.model ? formatModelRef(ctx.model) : "default model";
		const availableModels = ctx.modelRegistry
			.getAvailable()
			.map((model) => formatModelRef(model))
			.sort((a, b) => a.localeCompare(b));
		const modelOptions = [
			modelOption(INHERIT_MODEL, `inherit current parent model (${parent})`),
			...availableModels.map((modelRef) => modelOption(modelRef, "use this model for the selected subagent")),
		];

		const selectedModelOption = await ctx.ui.select(`Model for ${agent.name}`, modelOptions);
		if (!selectedModelOption) continue;

		const selectedModel = parseModelOption(selectedModelOption);
		await setAgentModelOverride(agent.name, selectedModel);
		ctx.ui.notify(
			selectedModel === INHERIT_MODEL
				? `${agent.name} now inherits the parent model.`
				: `${agent.name} now uses ${selectedModel}.`,
			"info",
		);
	}
}
