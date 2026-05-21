import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
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

async function showSelectList(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		const maxVisible = Math.min(items.length, 15);
		const selectList = new SelectList(items, maxVisible, {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});
		selectList.onSelect = (item: SelectItem) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);

		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
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

		// Step 1: Pick an agent
		const config = loadSubagentModelConfig();
		const agentItems: SelectItem[] = agents.map((agent) => {
			const current = getAgentModelDisplay(agent, ctx.model, config, parentThinking);
			return {
				value: agent.name,
				label: agent.name,
				description: `${agent.source} • current: ${current}`,
			};
		});

		const selectedAgentName = await showSelectList(
			ctx,
			`Select subagent model (${getSubagentModelConfigPath()})`,
			agentItems,
		);
		if (!selectedAgentName) return;

		const agent = agents.find((a) => a.name === selectedAgentName);
		if (!agent) continue;

		// Step 2: Pick a model
		const parent = ctx.model ? formatModelRef(ctx.model) : "default model";
		const parentThinkingLabel = parentThinking ? `thinking ${parentThinking}` : "default thinking";
		const availableModels = ctx.modelRegistry
			.getAvailable()
			.map((model) => formatModelRef(model))
			.sort((a, b) => a.localeCompare(b));

		const modelItems: SelectItem[] = [
			{
				value: INHERIT_MODEL,
				label: INHERIT_MODEL,
				description: `${parent}, ${parentThinkingLabel}`,
			},
			...availableModels.map((modelRef) => ({
				value: modelRef,
				label: modelRef,
			})),
		];

		const selectedModel = await showSelectList(ctx, `Model for ${agent.name}`, modelItems);
		if (!selectedModel) continue;

		// Step 3: Optionally configure thinking level
		const configThinking = await ctx.ui.confirm(
			`Configure thinking level for ${agent.name}?`,
			`Leave unchecked to inherit the parent pi thinking level (${parentThinkingLabel}). Agent frontmatter thinking is not used as a subagent fallback.`,
		);

		let finalSetting = selectedModel;
		if (configThinking) {
			const thinkingItems: SelectItem[] = [
				{
					value: INHERIT_THINKING,
					label: INHERIT_THINKING,
					description: parentThinkingLabel,
				},
				...THINKING_LEVELS.map((level) => ({
					value: level,
					label: level,
				})),
			];

			const selectedThinking = await showSelectList(
				ctx,
				`Thinking level for ${agent.name} (Resolution order: override → parent pi → default)`,
				thinkingItems,
			);
			if (selectedThinking) {
				if (selectedThinking !== INHERIT_THINKING) {
					finalSetting =
						selectedModel === INHERIT_MODEL
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
