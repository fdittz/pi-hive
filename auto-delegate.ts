import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface AutoDelegateConfig {
	enabled: boolean;
	confidenceThreshold: number;
	autoExecute: boolean;
}

const DEFAULT_CONFIG: AutoDelegateConfig = {
	enabled: true,
	confidenceThreshold: 70,
	autoExecute: true,
};

function getAutoDelegateConfigPath(): string {
	return path.join(getAgentDir(), "auto-delegate.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeThreshold(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONFIG.confidenceThreshold;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeConfig(value: unknown): AutoDelegateConfig {
	const root = isRecord(value) ? value : {};
	return {
		enabled: typeof root.enabled === "boolean" ? root.enabled : DEFAULT_CONFIG.enabled,
		confidenceThreshold: normalizeThreshold(root.confidenceThreshold),
		autoExecute: typeof root.autoExecute === "boolean" ? root.autoExecute : DEFAULT_CONFIG.autoExecute,
	};
}

async function loadConfigFromDisk(): Promise<AutoDelegateConfig> {
	try {
		const raw = await fs.promises.readFile(getAutoDelegateConfigPath(), "utf8");
		return normalizeConfig(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export async function isAutoDelegateEnabled(): Promise<boolean> {
	return (await getAutoDelegateConfig()).enabled;
}

export function shouldUseLanguageAgnosticDelegation(config: AutoDelegateConfig): boolean {
	return config.enabled;
}

export async function setAutoDelegateEnabled(enabled: boolean): Promise<void> {
	await setAutoDelegateConfig({ enabled });
}

export async function getAutoDelegateConfig(): Promise<AutoDelegateConfig> {
	return loadConfigFromDisk();
}

export async function setAutoDelegateConfig(config: Partial<AutoDelegateConfig>): Promise<void> {
	const configPath = getAutoDelegateConfigPath();
	await withFileMutationQueue(configPath, async () => {
		const current = await loadConfigFromDisk();
		await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
		await fs.promises.writeFile(
			configPath,
			`${JSON.stringify(normalizeConfig({ ...current, ...config }), null, 2)}\n`,
			"utf8",
		);
	});
}
