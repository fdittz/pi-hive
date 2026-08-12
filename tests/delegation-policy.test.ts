import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "../agents.js";
import { generateSubagentGuidance, type SubagentGuidance } from "../delegation-guidance.js";

const DIRECT_FIRST_POLICY = [
	"Prefer handling simple, localized, and low-risk tasks directly in the main chat.",
	"Delegate only when the user explicitly requests it, or when delegation materially benefits broad exploration, isolated expertise, an independent review, parallel work, or long multi-step work.",
	"Role mappings and trigger words are selection aids only after delegation is justified; a trigger word alone does not justify delegation.",
] as const;

const UNCONDITIONAL_AUTO_DELEGATION_PATTERNS = [
	/when user asks to/i,
	/detect user intent:/i,
	/invoke subagent tool automatically/i,
	/automatically without asking/i,
];

function representativeAgents(): AgentConfig[] {
	return [
		{
			name: "scout",
			description: "Reconnaissance and codebase exploration",
			when: "the task needs broad discovery",
			triggers: ["find", "explore"],
			examples: ["Map the authentication flow"],
			systemPrompt: "scout prompt",
			source: "package",
			filePath: "scout.md",
		},
		{
			name: "planner",
			description: "Multi-step implementation planning",
			when: "a separate plan materially helps",
			triggers: ["plan", "design"],
			examples: ["Plan the authentication migration"],
			systemPrompt: "planner prompt",
			source: "package",
			filePath: "planner.md",
		},
		{
			name: "worker",
			description: "Implementation and fixes",
			when: "isolated execution materially helps",
			triggers: ["implement", "fix"],
			examples: ["Implement the authentication migration"],
			systemPrompt: "worker prompt",
			source: "package",
			filePath: "worker.md",
		},
		{
			name: "reviewer",
			description: "Independent quality and security review",
			when: "an isolated review materially improves confidence",
			triggers: ["review", "audit"],
			examples: ["Review the implementation for regressions"],
			systemPrompt: "reviewer prompt",
			source: "package",
			filePath: "reviewer.md",
		},
		{
			name: "debugger",
			description: "Complex diagnosis and root-cause analysis",
			when: "a separate investigation materially helps",
			triggers: ["debug", "diagnose"],
			examples: ["Diagnose the authentication failure"],
			systemPrompt: "debugger prompt",
			source: "package",
			filePath: "debugger.md",
		},
	];
}

function guidanceFields(guidance: SubagentGuidance): Array<readonly [string, string]> {
	return [
		["promptSnippet", guidance.promptSnippet],
		["promptGuidelines", guidance.promptGuidelines.join("\n")],
		["promptSection", guidance.promptSection],
	];
}

describe("direct-first delegation guidance", () => {
	test.each([
		["promptSnippet", (guidance: SubagentGuidance) => guidance.promptSnippet],
		["promptGuidelines", (guidance: SubagentGuidance) => guidance.promptGuidelines.join("\n")],
		["promptSection", (guidance: SubagentGuidance) => guidance.promptSection],
	] as const)("%s contains the complete direct-first gate", (_fieldName, getField) => {
		const field = getField(generateSubagentGuidance(representativeAgents()));

		for (const sentence of DIRECT_FIRST_POLICY) {
			expect(field).toContain(sentence);
		}
	});

	test.each([
		["promptSnippet", (guidance: SubagentGuidance) => guidance.promptSnippet],
		["promptGuidelines", (guidance: SubagentGuidance) => guidance.promptGuidelines.join("\n")],
		["promptSection", (guidance: SubagentGuidance) => guidance.promptSection],
	] as const)("%s has no unconditional verb-based auto-delegation", (_fieldName, getField) => {
		const field = getField(generateSubagentGuidance(representativeAgents()));

		for (const pattern of UNCONDITIONAL_AUTO_DELEGATION_PATTERNS) {
			expect(field).not.toMatch(pattern);
		}
	});

	test("keeps scope guidance conditional on justified delegation", () => {
		const guidance = generateSubagentGuidance(representativeAgents());
		const guidelines = guidance.promptGuidelines.join("\n");

		expect(guidelines).toContain('Use agentScope "both" (or "project") only after delegation is justified');
		expect(guidance.promptSection).toContain('Use `agentScope: "both"` (or `"project"`) only after delegation is justified');
		expect(guidance.promptSnippet).not.toMatch(/agentScope/i);
	});

	test("keeps every chain instruction conditional", () => {
		const guidance = generateSubagentGuidance(representativeAgents());

		for (const [fieldName, field] of guidanceFields(guidance)) {
			const chainLines = field.split("\n").filter((line) => /chain/i.test(line));
			expect(chainLines, `${fieldName} should contain chain guidance`).not.toHaveLength(0);
			for (const line of chainLines) {
				expect(line).toMatch(/conditional on justified delegation|only after delegation is justified/i);
			}
		}
	});

	test("keeps every background instruction conditional", () => {
		const guidance = generateSubagentGuidance(representativeAgents());

		for (const [fieldName, field] of guidanceFields(guidance)) {
			const backgroundLines = field.split("\n").filter((line) => /background/i.test(line));
			expect(backgroundLines, `${fieldName} should contain background guidance`).not.toHaveLength(0);
			for (const line of backgroundLines) {
				expect(line).toMatch(/only after delegation is justified|only when asynchronous work materially helps/i);
			}
		}
	});

	test("keeps role mappings conditional", () => {
		const guidance = generateSubagentGuidance(representativeAgents());
		const guidelines = guidance.promptGuidelines.join("\n");

		expect(guidance.promptSnippet).toContain("Role mappings and trigger words are selection aids only after delegation is justified");
		expect(guidelines).toContain("Once delegation is justified, use role mappings as selection aids");
		expect(guidance.promptSection).toContain("### Agent Selection Aids (only after delegation is justified):");

		for (const mapping of ["scout", "planner", "reviewer", "worker", "debugger"]) {
			const mappingLine = guidance.promptSection.split("\n").find((line) => line.includes(`**${mapping}**`));
			expect(mappingLine).toMatch(/when .*materially (helps|improves)/i);
		}
	});

	test("keeps trigger guidance conditional", () => {
		const guidance = generateSubagentGuidance(representativeAgents());
		const guidelines = guidance.promptGuidelines.join("\n");

		expect(guidance.promptSnippet).toContain("Role mappings and trigger words are selection aids only after delegation is justified");
		expect(guidance.promptSection).toContain("A find, plan, review, implement, or debug intent—and a trigger word alone—does not justify delegation.");

		for (const agent of representativeAgents()) {
			const triggerLine = guidance.promptGuidelines.find(
				(line) => line.includes(`agent \"${agent.name}\"`) && line.includes("trigger words"),
			);
			expect(triggerLine, `${agent.name} trigger guidance should be present`).toMatch(
				/^After delegation is justified, use these trigger words only as selection aids/,
			);
		}

		expect(guidelines).not.toMatch(/consider subagent agent .* for trigger words/i);
	});
});
