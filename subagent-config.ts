import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type HandoffMode = "auto" | "manual" | "off";

export interface SubagentConfig {
	version: 1;
	models: {
		overrides: Record<string, string>;
	};
	handoff: {
		enabled: boolean;
		mode: HandoffMode;
		maxDepth: number;
		maxHandoffsPerRun: number;
		requireApprovalForProjectAgents: boolean;
		blockSelfHandoff: boolean;
	};
	requestHeaders: {
		enabled: boolean;
		providers: string[];
		headers: Record<string, string>;
	};
}

const DEFAULT_CONFIG: SubagentConfig = {
	version: 1,
	models: { overrides: {} },
	handoff: {
		enabled: true,
		mode: "auto",
		maxDepth: 2,
		maxHandoffsPerRun: 3,
		requireApprovalForProjectAgents: false,
		blockSelfHandoff: false,
	},
	requestHeaders: {
		enabled: true,
		providers: ["*"],
		headers: {
			"x-initiator": "{agent}",
		},
	},
};

export function getSubagentConfigPath(): string {
	return path.join(getAgentDir(), "subagent.json");
}

function getLegacyModelConfigPath(): string {
	return path.join(getAgentDir(), "subagent-models.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value)
			.filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
			.sort(([a], [b]) => a.localeCompare(b)),
	);
}

function normalizeConfig(parsed: unknown): SubagentConfig {
	const root = isRecord(parsed) ? parsed : {};
	const models = isRecord(root.models) ? root.models : {};
	const handoff = isRecord(root.handoff) ? root.handoff : {};
	const requestHeaders = isRecord(root.requestHeaders) ? root.requestHeaders : {};
	const mode = handoff.mode === "manual" || handoff.mode === "off" || handoff.mode === "auto" ? handoff.mode : DEFAULT_CONFIG.handoff.mode;
	const providers = Array.isArray(requestHeaders.providers)
		? requestHeaders.providers.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		: DEFAULT_CONFIG.requestHeaders.providers;
	return {
		version: 1,
		models: {
			overrides: normalizeStringMap(models.overrides),
		},
		handoff: {
			enabled: typeof handoff.enabled === "boolean" ? handoff.enabled : DEFAULT_CONFIG.handoff.enabled,
			mode,
			maxDepth:
				typeof handoff.maxDepth === "number" && Number.isFinite(handoff.maxDepth)
					? Math.max(0, Math.floor(handoff.maxDepth))
					: DEFAULT_CONFIG.handoff.maxDepth,
			maxHandoffsPerRun:
				typeof handoff.maxHandoffsPerRun === "number" && Number.isFinite(handoff.maxHandoffsPerRun)
					? Math.max(0, Math.floor(handoff.maxHandoffsPerRun))
					: DEFAULT_CONFIG.handoff.maxHandoffsPerRun,
			requireApprovalForProjectAgents:
				typeof handoff.requireApprovalForProjectAgents === "boolean"
					? handoff.requireApprovalForProjectAgents
					: DEFAULT_CONFIG.handoff.requireApprovalForProjectAgents,
			blockSelfHandoff:
				typeof handoff.blockSelfHandoff === "boolean" ? handoff.blockSelfHandoff : DEFAULT_CONFIG.handoff.blockSelfHandoff,
		},
		requestHeaders: {
			enabled: typeof requestHeaders.enabled === "boolean" ? requestHeaders.enabled : DEFAULT_CONFIG.requestHeaders.enabled,
			providers: providers.length > 0 ? providers : DEFAULT_CONFIG.requestHeaders.providers,
			headers:
				Object.keys(normalizeStringMap(requestHeaders.headers)).length > 0
					? normalizeStringMap(requestHeaders.headers)
					: { ...DEFAULT_CONFIG.requestHeaders.headers },
		},
	};
}

function loadLegacyModelOverrides(): Record<string, string> {
	try {
		const parsed = JSON.parse(fs.readFileSync(getLegacyModelConfigPath(), "utf8")) as { overrides?: unknown };
		return normalizeStringMap(parsed.overrides);
	} catch {
		return {};
	}
}

export function loadSubagentConfig(): SubagentConfig {
	try {
		const loaded = normalizeConfig(JSON.parse(fs.readFileSync(getSubagentConfigPath(), "utf8")));
		if (Object.keys(loaded.models.overrides).length === 0) {
			loaded.models.overrides = loadLegacyModelOverrides();
		}
		return loaded;
	} catch {
		return {
			...DEFAULT_CONFIG,
			models: { overrides: loadLegacyModelOverrides() },
			handoff: { ...DEFAULT_CONFIG.handoff },
			requestHeaders: { ...DEFAULT_CONFIG.requestHeaders, headers: { ...DEFAULT_CONFIG.requestHeaders.headers } },
		};
	}
}

export async function saveSubagentConfig(config: SubagentConfig): Promise<void> {
	const configPath = getSubagentConfigPath();
	const normalized = normalizeConfig(config);
	await withFileMutationQueue(configPath, async () => {
		await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
		await fs.promises.writeFile(configPath, `${JSON.stringify(normalized, null, "\t")}\n`, "utf8");
	});
}

export function getDefaultSubagentConfig(): SubagentConfig {
	return {
		...DEFAULT_CONFIG,
		models: { overrides: {} },
		handoff: { ...DEFAULT_CONFIG.handoff },
		requestHeaders: { ...DEFAULT_CONFIG.requestHeaders, headers: { ...DEFAULT_CONFIG.requestHeaders.headers } },
	};
}
