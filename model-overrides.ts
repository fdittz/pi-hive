import type { Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.js";
import { getSubagentConfigPath, loadSubagentConfig, saveSubagentConfig } from "./subagent-config.js";

export const INHERIT_MODEL = "inherit";
export const INHERIT_THINKING = "inherit";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ExplicitSubagentThinkingLevel = (typeof THINKING_LEVELS)[number];
export type SubagentThinkingLevel = ExplicitSubagentThinkingLevel | typeof INHERIT_THINKING;

export interface SubagentModelConfig {
	version: number;
	overrides: Record<string, string>;
}

export interface ResolvedAgentModel {
	setting: string;
	modelArg?: string;
	thinkingArg?: string;
	display: string;
	inherited: boolean;
}

export function getSubagentModelConfigPath(): string {
	return getSubagentConfigPath();
}

export function formatModelRef(model: Pick<Model<any>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function loadSubagentModelConfig(): SubagentModelConfig {
	const config = loadSubagentConfig();
	return { version: config.version, overrides: { ...config.models.overrides } };
}

export async function saveSubagentModelConfig(config: SubagentModelConfig): Promise<void> {
	const fullConfig = loadSubagentConfig();
	fullConfig.models.overrides = Object.fromEntries(
		Object.entries(config.overrides)
			.filter(([, value]) => value && value !== INHERIT_MODEL)
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	await saveSubagentConfig(fullConfig);
}

function splitModelThinking(value: string): { model: string; thinking?: ExplicitSubagentThinkingLevel } {
	const trimmed = value.trim();
	const match = trimmed.match(/^(.*):(off|minimal|low|medium|high|xhigh|max)$/);
	if (!match) return { model: trimmed };
	return { model: match[1], thinking: match[2] as ExplicitSubagentThinkingLevel };
}

/**
 * Thinking levels to offer for a model selection, mirroring pi's native /settings
 * menu: levels are derived from the concrete model's capabilities (reasoning flag
 * + thinkingLevelMap), not the global list. Falls back to the full list when the
 * model cannot be resolved (custom/external refs).
 */
export function resolveThinkingLevels(
	selectedModel: string,
	availableModels: Model<any>[],
	parentModel: Model<any> | undefined,
): string[] {
	const model =
		selectedModel === INHERIT_MODEL
			? parentModel
			: availableModels.find((m) => formatModelRef(m) === selectedModel);
	if (!model) return [...THINKING_LEVELS];
	const levels = getSupportedThinkingLevels(model as Model<any>);
	return levels.length > 0 ? [...levels] : [...THINKING_LEVELS];
}

function normalizeThinking(value: string | undefined): SubagentThinkingLevel {
	const trimmed = value?.trim();
	if (!trimmed || trimmed === INHERIT_THINKING) return INHERIT_THINKING;
	return (THINKING_LEVELS as readonly string[]).includes(trimmed) ? (trimmed as ExplicitSubagentThinkingLevel) : INHERIT_THINKING;
}

function normalizeInheritedThinking(value: string | undefined): ExplicitSubagentThinkingLevel | undefined {
	const normalized = normalizeThinking(value);
	return normalized === INHERIT_THINKING ? undefined : normalized;
}

export function getAgentModelSetting(agent: AgentConfig, config = loadSubagentModelConfig()): string {
	// Only user-selected subagent overrides participate in subagent resolution.
	// Agent frontmatter model/thinking is for standalone agent defaults; selecting
	// "inherit" in /subagent-model must inherit the parent pi, not frontmatter.
	return config.overrides[agent.name] || INHERIT_MODEL;
}

export function getAgentModelDisplay(
	agent: AgentConfig,
	parentModel: Pick<Model<any>, "provider" | "id"> | undefined,
	config = loadSubagentModelConfig(),
	parentThinking?: string,
): string {
	return resolveAgentModel(agent, parentModel, config, parentThinking).display;
}

export function resolveAgentModel(
	agent: AgentConfig,
	parentModel: Pick<Model<any>, "provider" | "id"> | undefined,
	config = loadSubagentModelConfig(),
	parentThinking?: string,
): ResolvedAgentModel {
	const rawSetting = getAgentModelSetting(agent, config).trim() || INHERIT_MODEL;
	const split = splitModelThinking(rawSetting);
	const setting = split.model || INHERIT_MODEL;
	// Precedence for subagent thinking is: explicit override suffix → parent pi → child pi default.
	// Do not fall back to agent.thinking here; frontmatter defaults are intentionally ignored
	// when an agent is launched as a subagent.
	const thinkingArg = split.thinking ?? normalizeInheritedThinking(parentThinking);
	if (setting === INHERIT_MODEL) {
		const inherited = parentModel ? formatModelRef(parentModel) : undefined;
		const displayThinking = thinkingArg ? `:${thinkingArg}` : "";
		return {
			setting,
			modelArg: inherited,
			thinkingArg,
			display: inherited ? `${INHERIT_MODEL} (${inherited}${displayThinking})` : `${INHERIT_MODEL}${displayThinking}`,
			inherited: true,
		};
	}
	return { setting, modelArg: setting, thinkingArg, display: `${setting}${thinkingArg ? `:${thinkingArg}` : ""}`, inherited: false };
}

export async function setAgentModelOverride(agentName: string, modelRef: string): Promise<void> {
	const config = loadSubagentModelConfig();
	if (modelRef === INHERIT_MODEL) delete config.overrides[agentName];
	else config.overrides[agentName] = modelRef;
	await saveSubagentModelConfig(config);
}
