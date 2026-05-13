import * as fs from "fs";
import * as path from "path";

interface TimeoutConfig {
	enabled: boolean;
	defaultMs: number | null;
	agents: Record<string, number | null>;
}

const CONFIG_PATH = path.join(process.env.HOME || "~", ".pi/agent/subagent-timeout.json");

const DEFAULT_CONFIG: TimeoutConfig = {
	enabled: false,
	defaultMs: null,
	agents: {
		scout: null,
		planner: null,
		worker: null,
		reviewer: null,
		debugger: null,
	},
};

export async function loadTimeoutConfig(): Promise<TimeoutConfig> {
	try {
		const content = await fs.promises.readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(content);
		return { ...DEFAULT_CONFIG, ...parsed };
	} catch {
		return DEFAULT_CONFIG;
	}
}

export async function getTimeoutForAgent(agent: string): Promise<number | null> {
	const config = await loadTimeoutConfig();
	if (!config.enabled) return null;

	const agentTimeout = config.agents[agent];
	if (agentTimeout !== undefined) return agentTimeout;

	return config.defaultMs;
}

export async function saveTimeoutConfig(updates: Partial<TimeoutConfig>): Promise<void> {
	const config = await loadTimeoutConfig();
	const updated = { ...config, ...updates };

	const dir = path.dirname(CONFIG_PATH);
	await fs.promises.mkdir(dir, { recursive: true });
	await fs.promises.writeFile(CONFIG_PATH, JSON.stringify(updated, null, 2), {
		mode: 0o600,
	});
}

export async function setAgentTimeout(agent: string, timeoutMs: number | null): Promise<void> {
	const config = await loadTimeoutConfig();
	config.agents[agent] = timeoutMs;
	await saveTimeoutConfig(config);
}

export async function formatTimeoutConfig(): Promise<string> {
	const config = await loadTimeoutConfig();
	const lines: string[] = [];

	lines.push("## Subagent Timeout Configuration");
	lines.push(`Status: ${config.enabled ? "**enabled**" : "**disabled**"}`);
	lines.push(`Default: ${config.defaultMs === null ? "no timeout" : `${config.defaultMs}ms`}`);
	lines.push("");
	lines.push("## Per-Agent Timeouts");

	for (const [agent, timeout] of Object.entries(config.agents)) {
		const timeoutStr =
			timeout === null
				? "no timeout"
				: `${Math.round(timeout / 1000)}s (${timeout}ms)`;
		lines.push(`- **${agent}**: ${timeoutStr}`);
	}

	lines.push("");
	lines.push("## Usage");
	lines.push("```");
	lines.push("/subagent-timeout status          # View current config");
	lines.push("/subagent-timeout enable          # Enable timeouts");
	lines.push("/subagent-timeout disable         # Disable timeouts (default)");
	lines.push("/subagent-timeout scout 300000    # Set scout to 5 min");
	lines.push("/subagent-timeout planner 600000  # Set planner to 10 min");
	lines.push("/subagent-timeout scout null      # Remove scout timeout");
	lines.push("```");

	return lines.join("\n");
}
