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

const DIRECT_FIRST_POLICY_SENTENCE = "Prefer handling simple, localized, and low-risk tasks directly in the main chat.";
const DELEGATION_GATE_POLICY_SENTENCE =
	"Delegate only when the user explicitly requests it, or when delegation materially benefits broad exploration, isolated expertise, an independent review, parallel work, or long multi-step work.";
const SELECTION_AIDS_POLICY_SENTENCE =
	"Role mappings and trigger words are selection aids only after delegation is justified; a trigger word alone does not justify delegation.";

function directFirstPolicyLines(): string[] {
	return [DIRECT_FIRST_POLICY_SENTENCE, DELEGATION_GATE_POLICY_SENTENCE, SELECTION_AIDS_POLICY_SENTENCE];
}

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
		guidelines.push("Only after delegation is justified, use chain mode like scout → planner when broad reconnaissance materially helps produce an implementation plan.");
	}
	if (names.has("scout") && names.has("planner") && names.has("worker")) {
		guidelines.push("Only after delegation is justified, use chain mode like scout → planner → worker when discovery materially improves a multi-step implementation.");
	}
	if (names.has("worker") && names.has("reviewer")) {
		guidelines.push("Only after delegation is justified, use chain mode like worker → reviewer → worker when an isolated review materially improves implementation confidence.");
	}
	return guidelines;
}

export function generateSubagentGuidance(agents: AgentConfig[]): SubagentGuidance {
	const { listed: availableAgents, remaining } = listedAgents(agents);
	const agentList = availableAgents.length > 0 ? availableAgents.map(formatSnippetAgent).join("; ") : "none";
	const remainingText = remaining > 0 ? ` (${remaining} more agents discovered but omitted from prompt guidance).` : "";
	const promptSnippet = [
		...directFirstPolicyLines(),
		`Available agents: ${agentList}${remainingText}`,
		'Modes are conditional on justified delegation: single, parallel tasks, or chain (previous-step context is auto-injected into later steps by default). Use --background only when asynchronous work materially helps: /subagent --background agent task',
	].join(" ");

	const promptGuidelines: string[] = [
		...directFirstPolicyLines(),
		"Do not delegate merely because a request contains find, plan, review, implement, or debug intent; assess scope, risk, complexity, and whether isolation materially helps first.",
		"Once delegation is justified, use role mappings as selection aids: scout for broad exploration, planner for multi-step planning, reviewer for an independent review, worker for implementation that benefits from isolation, and debugger for complex diagnosis.",
		'Use agentScope "both" (or "project") only after delegation is justified and the user explicitly asks to use trusted project-local agents from .pi/agents; default agentScope "user" excludes project-local agents.',
		"Use parallel tasks only after delegation is justified and only for independent work; use chain when one agent's output should feed the next step; {previous} is auto-injected into later chain steps by default.",
		"Use background execution only after delegation is justified and when asynchronous work materially helps; background tasks run without blocking and can be monitored with /subagent-jobs status and retrieved with /subagent-jobs results <id>.",
	];

	for (const agent of availableAgents) {
		promptGuidelines.push(`If delegation is justified, use subagent with agent ${quoteAgentName(agent.name)} ${stripTrailingPeriod(agentUseCase(agent))}.`);

		const triggers = formatLimitedList(agent.triggers, MAX_TRIGGERS_PER_AGENT);
		if (triggers.values.length > 0) {
			promptGuidelines.push(
				`After delegation is justified, use these trigger words only as selection aids for agent ${quoteAgentName(agent.name)}: ${triggers.values.join(", ")}${triggers.remaining > 0 ? ` (+${triggers.remaining} more)` : ""}; a trigger word alone does not justify delegation.`,
			);
		}

		const examples = formatLimitedList(agent.examples, MAX_EXAMPLES_PER_AGENT);
		if (examples.values.length > 0) {
			promptGuidelines.push(
				`After delegation is justified, consider these example tasks for agent ${quoteAgentName(agent.name)}: ${examples.values.map((example) => quote(example)).join("; ")}${examples.remaining > 0 ? ` (+${examples.remaining} more)` : ""}.`,
			);
		}
	}

	if (remaining > 0) {
		promptGuidelines.push(`Subagent guidance omitted ${remaining} additional agent(s) to keep the prompt compact; rely on tool errors or user-provided names if needed after delegation is justified.`);
	}

	promptGuidelines.push(...maybeKnownChainGuidance(availableAgents));

	const promptSection = [
		"## Dynamic Subagent Guidance",
		...directFirstPolicyLines(),
		"",
		"Agents are discovered dynamically from bundled agents and ~/.pi/agent/agents. Project .pi/agents are included only when project scope is explicitly requested/trusted and delegation is justified.",
		"",
		availableAgents.length > 0 ? availableAgents.map(formatPromptSectionAgent).join("\n") : "- No agents discovered.",
		remaining > 0 ? `- ${remaining} additional agent(s) omitted to keep guidance compact.` : "",
		"",
		"### Agent Selection Aids (only after delegation is justified):",
		"- **scout**: Broad codebase exploration and reconnaissance when that isolation materially helps",
		"- **planner**: Multi-step planning when a separate plan materially helps",
		"- **reviewer**: Independent review, audit, or security analysis when isolation materially improves confidence",
		"- **worker**: Implementation, fixes, refactoring, or building when isolated execution materially helps",
		"- **debugger**: Complex diagnosis or root-cause analysis when a separate investigation materially helps",
		"A find, plan, review, implement, or debug intent—and a trigger word alone—does not justify delegation.",
		"",
		"### Background Execution (only after delegation is justified):",
		"Add `--background` only when asynchronous work materially helps: `/subagent --background scout Find auth code`",
		"Monitor with `/subagent-jobs status` and retrieve results with `/subagent-jobs results <id>`",
		"",
		'Use `agentScope: "both"` (or `"project"`) only after delegation is justified and the user explicitly wants trusted project-local agents from `.pi/agents`; the default `"user"` scope only includes bundled/user agents.',
		"Use chain mode only after delegation is justified when output should flow between agents, and parallel mode only for independent work. Later chain steps receive previous output automatically unless the user disables chain.autoInjectPrevious.",
		...maybeKnownChainGuidance(availableAgents),
	]
		.filter(Boolean)
		.join("\n");

	return { promptSnippet, promptGuidelines, promptSection };
}
