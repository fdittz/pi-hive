import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope } from "./agents.js";
import { discoverAgents } from "./agents.js";
import {
	formatModelRef,
	getAgentModelDisplay,
	getSubagentModelConfigPath,
	INHERIT_MODEL,
	INHERIT_THINKING,
	THINKING_LEVELS,
	loadSubagentModelConfig,
	setAgentModelOverride,
} from "./model-overrides.js";

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function agentOption(agent: AgentConfig, ctx: ExtensionCommandContext, parentThinking?: string): string {
	const config = loadSubagentModelConfig();
	const current = getAgentModelDisplay(agent, ctx.model, config, parentThinking);
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

function thinkingOption(value: string, label: string): string {
	return `${value} — ${label}`;
}

function parseThinkingOption(option: string): string {
	return option.split(" — ")[0]?.trim() || option.trim();
}

export async function openSubagentModelSelector(
	ctx: ExtensionCommandContext,
	scope: AgentScope = "both",
	parentThinking?: string,
): Promise<void> {
	if (!ctx.hasUI) return;

	while (true) {
		const discovery = discoverAgents(ctx.cwd, scope);
		const agents = discovery.agents.sort((a, b) => a.name.localeCompare(b.name));
		if (agents.length === 0) {
			ctx.ui.notify("No subagents are available.", "warning");
			return;
		}

		const agentOptions = agents.map((agent) => agentOption(agent, ctx, parentThinking));
		const selectedAgentOption = await ctx.ui.select(
			`Select subagent model (${getSubagentModelConfigPath()})`,
			agentOptions,
		);
		if (!selectedAgentOption) return;

		const agentName = parseAgentName(selectedAgentOption);
		const agent = agents.find((a) => a.name === agentName);
		if (!agent) continue;

		const parent = ctx.model ? formatModelRef(ctx.model) : "default model";
		const parentThinkingLabel = parentThinking ? `thinking ${parentThinking}` : "default thinking";
		const availableModels = ctx.modelRegistry
			.getAvailable()
			.map((model) => formatModelRef(model))
			.sort((a, b) => a.localeCompare(b));
		const modelOptions = [
			modelOption(INHERIT_MODEL, `inherit current parent model (${parent}, ${parentThinkingLabel})`),
			...availableModels.map((modelRef) => modelOption(modelRef, "use this model for the selected subagent")),
		];

		const selectedModelOption = await ctx.ui.select(`Model for ${agent.name}`, modelOptions);
		if (!selectedModelOption) continue;

		const selectedModel = parseModelOption(selectedModelOption);

		// Ask only for an explicit subagent override. If the user leaves thinking unset,
		// resolution inherits the parent pi thinking level; agent frontmatter is ignored.
		const configThinking = await ctx.ui.confirm(
			`Configure thinking level for ${agent.name}?`,
			`Leave unchecked to inherit the parent pi thinking level (${parentThinkingLabel}). Agent frontmatter thinking is not used as a subagent fallback.`,
		);

		let finalSetting = selectedModel;
		if (configThinking) {
			const thinkingOptions = [
				thinkingOption(INHERIT_THINKING, `inherit parent pi thinking (${parentThinkingLabel})`),
				...THINKING_LEVELS.map((level) => thinkingOption(level, `use ${level} thinking effort for this subagent`)),
			];

			const selectedThinkingOption = await ctx.ui.select(
				`Thinking level for ${agent.name} (Resolution order: override → parent pi → default)`,
				thinkingOptions,
			);
			if (selectedThinkingOption) {
				const selectedThinking = parseThinkingOption(selectedThinkingOption);
				if (selectedThinking !== INHERIT_THINKING) {
					finalSetting = selectedModel === INHERIT_MODEL
						? `${INHERIT_MODEL}:${selectedThinking}`
						: `${selectedModel}:${selectedThinking}`;
				}
			}
		}

		await setAgentModelOverride(agent.name, finalSetting);
		ctx.ui.notify(
			finalSetting === INHERIT_MODEL
				? `${agent.name} now inherits the parent model and thinking level.`
				: `${agent.name} now uses ${finalSetting}.`,
			"info",
		);
	}
}
