import { describe, expect, mock, test } from "bun:test";
import { piCodingAgentStub } from "./helpers/pi-test-stubs.js";

interface TestAgentConfig {
	name: string;
	description: string;
	triggers?: string[];
	systemPrompt: string;
	source: "package";
	filePath: string;
}


mock.module("@earendil-works/pi-coding-agent", () =>
	piCodingAgentStub({ getAgentDir: () => "/tmp/pi-hive-test-empty-agents" }));

const { findBestAgent, scoreAgents } = await import("../delegate.js");

function testAgent(name: string, triggers: string[]): TestAgentConfig {
	return {
		name,
		description: `${name} test agent`,
		triggers,
		systemPrompt: "test prompt",
		source: "package",
		filePath: `${name}.md`,
	};
}

describe("auto-delegate agent scoring", () => {
	test("chooses scout for English exploration requests that mention projeto", async () => {
		const match = await findBestAgent("explore esse projeto", { cwd: process.cwd(), scope: "project" });

		expect(match?.name).toBe("scout");
	});

	test("chooses scout for Portuguese exploration requests that mention projeto", async () => {
		const match = await findBestAgent("explorar esse projeto", { cwd: process.cwd(), scope: "project" });

		expect(match?.name).toBe("scout");
	});

	test("chooses planner for Portuguese planning requests that mention projeto", async () => {
		const match = await findBestAgent("planejar projeto", { cwd: process.cwd(), scope: "project" });

		expect(match?.name).toBe("planner");
	});

	test("orders action trigger matches ahead of noun trigger matches when raw scores tie", () => {
		const matches = scoreAgents(
			[
				testAgent("noun-agent", ["project"]),
				testAgent("action-agent", ["explore"]),
			],
			"explore project",
		);

		expect(matches[0]?.name).toBe("action-agent");
	});
});
