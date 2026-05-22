import type { AgentConfig } from "./agents.js";

export interface SubagentGuidance {
	promptSnippet: string;
	promptGuidelines: string[];
	promptSection: string;
}

const MAX_AGENTS = 20;
const MAX_SNIPPET_FIELD_LENGTH = 72;
const MAX_SECTION_FIELD_LENGTH = 240;
const MAX_AGENT_NAME_LENGTH = 80;
const MAX_EXAMPLES_PER_AGENT = 3;
const MAX_TRIGGERS_PER_AGENT = 12;

function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function stripTrailingPeriod(value: string): string {
	return value.replace(/[.。]+$/u, "");
}

function truncate(value: string, maxLength: number): string {
	const compact = compactWhitespace(value);
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function cleanField(value: string, maxLength = MAX_SECTION_FIELD_LENGTH): string {
	return truncate(value, maxLength);
}

function safeAgentName(value: string): string {
	return cleanField(value, MAX_AGENT_NAME_LENGTH).replace(/`/g, "\\`");
}

function quote(value: string): string {
	return `"${cleanField(value).replace(/"/g, '\\"')}"`;
}

function quoteAgentName(value: string): string {
	return `"${safeAgentName(value).replace(/"/g, '\\"')}"`;
}

function agentUseCase(agent: AgentConfig): string {
	const raw = cleanField(agent.when || agent.description);
	if (!raw) return "for delegated work that matches its description";
	if (/^(when|for|to|after|before|if)\b/i.test(raw)) return raw;
	return `for ${raw}`;
}

function listedAgents(agents: AgentConfig[]): { listed: AgentConfig[]; remaining: number } {
	const availableAgents = agents.filter((agent) => agent.name && agent.description);
	const listed = availableAgents.slice(0, MAX_AGENTS);
	return { listed, remaining: availableAgents.length - listed.length };
}

function formatSnippetAgent(agent: AgentConfig): string {
	return `${safeAgentName(agent.name)} (${agent.source}: ${truncate(agent.when || agent.description, MAX_SNIPPET_FIELD_LENGTH)})`;
}

function formatLimitedList(items: string[] | undefined, maxItems: number): { values: string[]; remaining: number } {
	if (!items || items.length === 0) return { values: [], remaining: 0 };
	const values = items.slice(0, maxItems).map((item) => cleanField(item));
	return { values, remaining: items.length - values.length };
}

function formatPromptSectionAgent(agent: AgentConfig): string {
	const details: string[] = [`source: ${agent.source}`, `description: ${cleanField(agent.description)}`];
	if (agent.when) details.push(`when: ${cleanField(agent.when)}`);

	const triggers = formatLimitedList(agent.triggers, MAX_TRIGGERS_PER_AGENT);
	if (triggers.values.length > 0) {
		details.push(`triggers: ${triggers.values.join(", ")}${triggers.remaining > 0 ? ` (+${triggers.remaining} more)` : ""}`);
	}

	const examples = formatLimitedList(agent.examples, MAX_EXAMPLES_PER_AGENT);
	if (examples.values.length > 0) {
		details.push(
			`examples: ${examples.values.map((example) => quote(example)).join("; ")}${examples.remaining > 0 ? ` (+${examples.remaining} more)` : ""}`,
		);
	}

	return `- \`${safeAgentName(agent.name)}\` — ${details.join("; ")}`;
}

function maybeKnownChainGuidance(agents: AgentConfig[]): string[] {
	const names = new Set(agents.map((agent) => agent.name));
	const guidelines: string[] = [];
	if (names.has("scout") && names.has("planner")) {
		guidelines.push('Use subagent chain mode like scout → planner when you need codebase reconnaissance before producing an implementation plan.');
	}
	if (names.has("scout") && names.has("planner") && names.has("worker")) {
		guidelines.push('Use subagent chain mode like scout → planner → worker when the user wants an informed implementation and the task needs discovery before changes.');
	}
	if (names.has("worker") && names.has("reviewer")) {
		guidelines.push('Use subagent chain mode like worker → reviewer → worker when implementation should be followed by an isolated review and fixes.');
	}
	return guidelines;
}

export function generateSubagentGuidance(agents: AgentConfig[]): SubagentGuidance {
	const { listed: availableAgents, remaining } = listedAgents(agents);
	const agentList = availableAgents.length > 0 ? availableAgents.map(formatSnippetAgent).join("; ") : "none";
	const remainingText = remaining > 0 ? ` (${remaining} more agents discovered but omitted from prompt guidance).` : "";
	const promptSnippet = [
		"Delegate tasks to specialized subagents with isolated context.",
		`Available agents: ${agentList}${remainingText}`,
		'Modes: single, parallel tasks, or chain (previous-step context is auto-injected into later steps by default). Add --background flag to run asynchronously: /subagent --background agent task',
	].join(" ");

	const promptGuidelines: string[] = [
		"When user asks to 'find', 'search', 'investigate', 'analyze', or 'explore' code/files, use subagent with agent 'scout'.",
		"When user asks to 'plan', 'design', 'create a strategy', or 'create a roadmap', use subagent with agent 'planner'.",
		"When user asks to 'review', 'audit', 'check for bugs', or 'security review', use subagent with agent 'reviewer'.",
		"When user asks to 'implement', 'fix', 'build', 'refactor', or 'modify', use subagent with agent 'worker'.",
		"When user asks to 'debug', 'investigate why', 'diagnose', or 'find the root cause', use subagent with agent 'debugger'.",
		"When user mentions 'background', 'async', 'in parallel', 'without blocking', or 'while I work', add --background flag: /subagent --background agent task",
		"Use subagent when an available specialized agent can do focused discovery, planning, implementation, review, or domain-specific work in an isolated context.",
		'Use subagent agentScope "both" (or "project") when the user explicitly asks to use trusted project-local agents from .pi/agents; default agentScope "user" excludes project-local agents.',
		"Use subagent parallel tasks only for independent work; use chain when one agent's output should feed the next step; {previous} is auto-injected into later chain steps by default.",
		"Background tasks run asynchronously without blocking; user can check progress with /subagent-jobs status and retrieve results with /subagent-jobs results <id>.",
	];

	for (const agent of availableAgents) {
		promptGuidelines.push(`Use subagent with agent ${quoteAgentName(agent.name)} ${stripTrailingPeriod(agentUseCase(agent))}.`);

		const triggers = formatLimitedList(agent.triggers, MAX_TRIGGERS_PER_AGENT);
		if (triggers.values.length > 0) {
			promptGuidelines.push(
				`Consider subagent agent ${quoteAgentName(agent.name)} for trigger words: ${triggers.values.join(", ")}${triggers.remaining > 0 ? ` (+${triggers.remaining} more)` : ""}.`,
			);
		}

		const examples = formatLimitedList(agent.examples, MAX_EXAMPLES_PER_AGENT);
		if (examples.values.length > 0) {
			promptGuidelines.push(
				`Example subagent tasks for agent ${quoteAgentName(agent.name)}: ${examples.values.map((example) => quote(example)).join("; ")}${examples.remaining > 0 ? ` (+${examples.remaining} more)` : ""}.`,
			);
		}
	}

	if (remaining > 0) {
		promptGuidelines.push(`Subagent guidance omitted ${remaining} additional agent(s) to keep the prompt compact; rely on tool errors or user-provided names if needed.`);
	}
	
	promptGuidelines.push(
		"When user messages suggest delegation (finding, planning, reviewing, implementing, debugging), invoke subagent tool automatically without asking.",
	);

	promptGuidelines.push(...maybeKnownChainGuidance(availableAgents));
	
	// Reinforce agent selection based on user intent patterns
	promptGuidelines.push(
		"Detect user intent: if they mention finding/searching → scout; planning/designing → planner; reviewing/auditing → reviewer; implementing/fixing → worker; debugging/diagnosing → debugger.",
		"For exploratory or long-running tasks, proactively suggest background execution with --background flag so user can continue working.",
	);

	// Background execution guidance
	promptGuidelines.push(
		"Consider running long-running tasks in background using the --background flag for better user experience.",
		"Use /subagent --background agent task for exploratory work (scout finding code) or complex planning/reviews that can run while user works on other tasks.",
		"Background tasks run asynchronously without blocking; user can continue working and check progress with /subagent-jobs status.",
		"Retrieve background job results later with /subagent-jobs results <id> or cancel with /subagent-jobs cancel <id>.",
	);

	const promptSection = [
		"## Dynamic Subagent Guidance",
		"Agents are discovered dynamically from bundled agents and ~/.pi/agent/agents. Project .pi/agents are included only when project scope is explicitly requested/trusted.",
		"",
		availableAgents.length > 0 ? availableAgents.map(formatPromptSectionAgent).join("\n") : "- No agents discovered.",
		remaining > 0 ? `- ${remaining} additional agent(s) omitted to keep guidance compact.` : "",
		"",
		"### When to Use Each Agent:",
		"- **scout**: Finding code, searching, investigating structure, tracing dependencies, exploring codebase",
		"- **planner**: Creating plans, designing solutions, mapping implementation strategy",
		"- **reviewer**: Code review, security audit, quality analysis, regression risk assessment",
		"- **worker**: Implementation, fixes, refactoring, building, modifying code",
		"- **debugger**: Debugging, root cause analysis, diagnosing issues, tracing errors",
		"",
		"### Background Execution:",
		"Add `--background` flag to run tasks asynchronously without blocking: `/subagent --background scout Find auth code`",
		"Monitor with `/subagent-jobs status` and retrieve results with `/subagent-jobs results <id>`",
		"",
		'Use `agentScope: "both"` (or `"project"`) only when the user explicitly wants trusted project-local agents from `.pi/agents`; the default `"user"` scope only includes bundled/user agents.',
		"Use chain mode when output should flow between agents, and parallel mode only for independent tasks. Later chain steps receive previous output automatically unless the user disables chain.autoInjectPrevious.",
		...maybeKnownChainGuidance(availableAgents),
	]
		.filter(Boolean)
		.join("\n");

	return { promptSnippet, promptGuidelines, promptSection };
}
