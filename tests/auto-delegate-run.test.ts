import { describe, expect, test } from "bun:test";
import { buildSubagentInvocationMessage } from "../auto-delegate-run.js";

describe("subagent invocation message helpers", () => {
	test("builds a foreground auto-delegate instruction with exact subagent args", () => {
		const message = buildSubagentInvocationMessage({
			agent: "debugger",
			task: "Diagnose why login fails",
			userMessage: "Why is login failing?",
			confidence: 87,
			source: "auto-delegate",
		});

		expect(message).toContain("[AUTO-DELEGATED to debugger (87% confidence)]");
		expect(message).toContain("Invoke the `subagent` tool now");
		expect(message).toContain('"agent": "debugger"');
		expect(message).toContain('"task": "Diagnose why login fails"');
		expect(message).toContain("Original user request: Why is login failing?");
		expect(message).not.toContain('"background"');
		expect(message).not.toContain("background job");
	});

	test("builds the same exact-args instruction path for manual subagent commands", () => {
		const message = buildSubagentInvocationMessage({
			agent: "scout",
			task: "Find authentication code",
			source: "command",
		});

		expect(message).toContain("[SUBAGENT scout]");
		expect(message).toContain("Invoke the `subagent` tool now");
		expect(message).toContain('"agent": "scout"');
		expect(message).toContain('"task": "Find authentication code"');
		expect(message).not.toContain("Original user request");
		expect(message).not.toContain('"background"');
	});

	test("preserves explicit manual background requests without making auto-delegate background-only", () => {
		const message = buildSubagentInvocationMessage({
			agent: "worker",
			task: "Run the long migration",
			background: true,
			source: "command",
		});

		expect(message).toContain('"agent": "worker"');
		expect(message).toContain('"task": "Run the long migration"');
		expect(message).toContain('"background": true');
	});

	test("builds a continuation instruction that routes through the subagent tool", () => {
		const message = buildSubagentInvocationMessage({
			run: "worker@abc123",
			instruction: "focus on the remaining tests",
			source: "command",
		});

		expect(message).toContain("[SUBAGENT continue worker@abc123]");
		expect(message).toContain("Invoke the `subagent` tool now");
		expect(message).toContain('"run": "worker@abc123"');
		expect(message).toContain('"instruction": "focus on the remaining tests"');
		expect(message).not.toContain('"agent"');
		expect(message).not.toContain('"task"');
	});
});
