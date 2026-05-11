import type { Model } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.js";
import { getSubagentConfigPath, loadSubagentConfig, saveSubagentConfig } from "./subagent-config.js";

export const INHERIT_MODEL = "inherit";

export interface SubagentModelConfig {
	version: number;
	overrides: Record<string, string>;
}

export interface ResolvedAgentModel {
	setting: string;
	modelArg?: string;
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
	const setting = getAgentModelSetting(agent, config).trim() || INHERIT_MODEL;
	if (setting === INHERIT_MODEL) {
		const inherited = parentModel ? formatModelRef(parentModel) : undefined;
		return {
			setting,
			modelArg: inherited,
			display: inherited ? `${INHERIT_MODEL} (${inherited})` : INHERIT_MODEL,
			inherited: true,
		};
	}
	return { setting, modelArg: setting, display: setting, inherited: false };
}

export async function setAgentModelOverride(agentName: string, modelRef: string): Promise<void> {
	const config = loadSubagentModelConfig();
	if (modelRef === INHERIT_MODEL) delete config.overrides[agentName];
	else config.overrides[agentName] = modelRef;
	await saveSubagentModelConfig(config);
}
