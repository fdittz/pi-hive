import type { Model } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.js";
import { getSubagentConfigPath, loadSubagentConfig, saveSubagentConfig } from "./subagent-config.js";

export const INHERIT_MODEL = "inherit";
export const INHERIT_THINKING = "inherit";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type SubagentThinkingLevel = (typeof THINKING_LEVELS)[number] | typeof INHERIT_THINKING;

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

function splitModelThinking(value: string): { model: string; thinking?: string } {
	const trimmed = value.trim();
	const match = trimmed.match(/^(.*):(off|minimal|low|medium|high|xhigh)$/);
	if (!match) return { model: trimmed };
	return { model: match[1], thinking: match[2] };
}

function normalizeThinking(value: string | undefined): SubagentThinkingLevel {
	const trimmed = value?.trim();
	if (!trimmed || trimmed === INHERIT_THINKING) return INHERIT_THINKING;
	return (THINKING_LEVELS as readonly string[]).includes(trimmed) ? (trimmed as SubagentThinkingLevel) : INHERIT_THINKING;
}

export function getAgentModelSetting(agent: AgentConfig, config = loadSubagentModelConfig()): string {
	return config.overrides[agent.name] || agent.model || INHERIT_MODEL;
}

export function getAgentModelDisplay(
	agent: AgentConfig,
	parentModel: Pick<Model<any>, "provider" | "id"> | undefined,
	config = loadSubagentModelConfig(),
): string {
	return resolveAgentModel(agent, parentModel, config).display;
}

export function resolveAgentModel(
	agent: AgentConfig,
	parentModel: Pick<Model<any>, "provider" | "id"> | undefined,
	config = loadSubagentModelConfig(),
): ResolvedAgentModel {
	const rawSetting = getAgentModelSetting(agent, config).trim() || INHERIT_MODEL;
	const split = splitModelThinking(rawSetting);
	const setting = split.model || INHERIT_MODEL;
	const thinking = normalizeThinking(agent.thinking);
	const thinkingArg = split.thinking ?? (thinking === INHERIT_THINKING ? undefined : thinking);
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
