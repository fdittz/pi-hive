import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AUTO_INJECT_PREVIOUS_BLOCK,
	hasPreviousPlaceholder,
	normalizeChainPrevious,
	replacePreviousPlaceholder,
} from "../chain-previous.js";
import { piCodingAgentStub } from "./helpers/pi-test-stubs.js";

let agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-subagent-config-"));

mock.module("@earendil-works/pi-coding-agent", () => piCodingAgentStub({ getAgentDir: () => agentDir }));

const { getDefaultSubagentConfig, loadSubagentConfig } = await import("../subagent-config.js");

afterEach(() => {
	fs.rmSync(agentDir, { recursive: true, force: true });
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-subagent-config-"));
});

describe("chain previous placeholder normalization", () => {
	test("injects the previous-output block into every chain step after the first that lacks a placeholder", () => {
		const chain = [
			{ agent: "scout", task: "Find the relevant code" },
			{ agent: "planner", task: "Create a plan" },
			{ agent: "worker", task: "Implement the plan." },
		];

		const normalized = normalizeChainPrevious(chain);

		expect(normalized[0]?.task).toBe("Find the relevant code");
		expect(normalized[1]?.task).toBe(`Create a plan${AUTO_INJECT_PREVIOUS_BLOCK}`);
		expect(normalized[2]?.task).toBe(`Implement the plan.${AUTO_INJECT_PREVIOUS_BLOCK}`);
		expect(chain[1]?.task).toBe("Create a plan");
	});

	test("does not inject duplicates when a step already has a placeholder with spaces or different case", () => {
		const chain = [
			{ agent: "scout", task: "Find context" },
			{ agent: "planner", task: "Plan with { previous }" },
			{ agent: "worker", task: "Implement from {Previous}" },
			{ agent: "reviewer", task: "Review the work" },
		];

		const normalized = normalizeChainPrevious(chain);

		expect(normalized[1]?.task).toBe("Plan with { previous }");
		expect(normalized[2]?.task).toBe("Implement from {Previous}");
		expect(normalized[3]?.task).toBe(`Review the work${AUTO_INJECT_PREVIOUS_BLOCK}`);
	});

	test("leaves chain tasks unchanged when auto injection is disabled", () => {
		const chain = [
			{ agent: "scout", task: "Find context" },
			{ agent: "planner", task: "Create a plan" },
		];

		const normalized = normalizeChainPrevious(chain, { enabled: false });

		expect(normalized).toEqual(chain);
	});

	test("detects and replaces previous placeholders regardless of spacing or case", () => {
		expect(hasPreviousPlaceholder("Use {previous}")).toBe(true);
		expect(hasPreviousPlaceholder("Use { previous } now")).toBe(true);
		expect(hasPreviousPlaceholder("Use {Previous} now")).toBe(true);
		expect(hasPreviousPlaceholder("Use {later} now")).toBe(false);

		expect(replacePreviousPlaceholder("Plan from { previous } and {Previous}", "prior $& output")).toBe(
			"Plan from prior $& output and prior $& output",
		);
	});
});

describe("subagent chain auto-inject config", () => {
	test("enables chain.autoInjectPrevious by default", () => {
		expect(getDefaultSubagentConfig().chain.autoInjectPrevious).toEqual({ enabled: true, mode: "append-block" });
		expect(loadSubagentConfig().chain.autoInjectPrevious).toEqual({ enabled: true, mode: "append-block" });
	});

	test("preserves an explicit chain.autoInjectPrevious.enabled false value from config", () => {
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "subagent.json"),
			JSON.stringify({ chain: { autoInjectPrevious: { enabled: false } } }),
			"utf8",
		);

		expect(loadSubagentConfig().chain.autoInjectPrevious).toEqual({ enabled: false, mode: "append-block" });
	});
});
