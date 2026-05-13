/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { applySubagentsLanguageToAgents } from "./subagents-lang.js";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "package" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	color?: string;
	handoffAllowList?: string[];
	when?: string;
	examples?: string[];
	triggers?: string[];
	triggers_en?: string[];
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

const MAX_AGENT_TRIGGERS = 32;
const MAX_AGENT_TRIGGER_LENGTH = 120;

interface AgentFrontmatter {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	color?: unknown;
	handoffAllowList?: unknown;
	handoffAllowlist?: unknown;
	"handoff-allow-list"?: unknown;
	allowList?: unknown;
	when?: unknown;
	examples?: unknown;
	triggers?: unknown;
	triggers_en?: unknown;
	[key: string]: unknown;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function getPackageAgentsDir(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
}

function toOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripListMarker(value: string): string {
	return value.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "").trim();
}

function parseCommaList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const items = value.map((item) => toOptionalString(item)).filter((item): item is string => Boolean(item));
		return items.length > 0 ? items : undefined;
	}
	if (typeof value !== "string") return undefined;
	const items = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function parseTriggers(value: unknown): string[] | undefined {
	const raw = parseCommaList(value);
	if (!raw) return undefined;
	const seen = new Set<string>();
	const triggers: string[] = [];
	for (const item of raw) {
		if (triggers.length >= MAX_AGENT_TRIGGERS) break;
		const normalized = item.replace(/\s+/g, " ").trim();
		if (!normalized) continue;
		const bounded = normalized.length > MAX_AGENT_TRIGGER_LENGTH ? normalized.slice(0, MAX_AGENT_TRIGGER_LENGTH).trimEnd() : normalized;
		if (!bounded || seen.has(bounded)) continue;
		seen.add(bounded);
		triggers.push(bounded);
	}
	return triggers.length > 0 ? triggers : undefined;
}

function parseExamples(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const items = value.map((item) => toOptionalString(item)).filter((item): item is string => Boolean(item));
		return items.length > 0 ? items : undefined;
	}
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const items = trimmed.includes("\n")
		? trimmed
				.split(/\r?\n/)
				.map(stripListMarker)
				.filter(Boolean)
		: [trimmed];
	return items.length > 0 ? items : undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let parsed: { frontmatter: AgentFrontmatter; body: string };
		try {
			parsed = parseFrontmatter<AgentFrontmatter>(content);
		} catch {
			continue;
		}
		const { frontmatter, body } = parsed;
		const name = toOptionalString(frontmatter.name);
		const description = toOptionalString(frontmatter.description);

		if (!name || !description) {
			continue;
		}

		const tools = parseCommaList(frontmatter.tools);
		const handoffAllowListRaw =
			frontmatter.handoffAllowList ?? frontmatter.handoffAllowlist ?? frontmatter["handoff-allow-list"] ?? frontmatter.allowList;
		const handoffAllowList = parseCommaList(handoffAllowListRaw);

		agents.push({
			name,
			description,
			tools,
			model: toOptionalString(frontmatter.model),
			thinking: toOptionalString(frontmatter.thinking),
			color: toOptionalString(frontmatter.color),
			handoffAllowList,
			when: toOptionalString(frontmatter.when),
			examples: parseExamples(frontmatter.examples),
			triggers: parseTriggers(frontmatter.triggers),
			triggers_en: parseTriggers(frontmatter.triggers_en),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const packageDir = getPackageAgentsDir();
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const packageAgents = loadAgentsFromDir(packageDir, "package");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	// Bundled package agents make the GitHub package self-contained. User agents override
	// package agents, and project agents override both when enabled.
	for (const agent of packageAgents) agentMap.set(agent.name, agent);

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export async function loadAgents(options?: { cwd?: string; scope?: AgentScope }): Promise<AgentConfig[]> {
	const agents = discoverAgents(options?.cwd ?? process.cwd(), options?.scope ?? "user").agents;
	return applySubagentsLanguageToAgents(agents).agents;
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
