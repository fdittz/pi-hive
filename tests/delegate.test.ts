import { describe, expect, mock, test } from "bun:test";

interface TestAgentConfig {
	name: string;
	description: string;
	triggers?: string[];
	systemPrompt: string;
	source: "package";
	filePath: string;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };

	const frontmatter: Record<string, unknown> = {};
	let currentKey: string | null = null;
	let currentBlock: string[] = [];

	function flushBlock() {
		if (currentKey && currentBlock.length > 0) {
			frontmatter[currentKey] = currentBlock.join("\n").trimEnd();
		}
		currentKey = null;
		currentBlock = [];
	}

	for (const line of match[1].split(/\r?\n/)) {
		const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (keyValue) {
			flushBlock();
			const [, key, value] = keyValue;
			if (value) {
				frontmatter[key] = value;
			} else {
				currentKey = key;
			}
		} else if (currentKey) {
			currentBlock.push(line);
		}
	}
	flushBlock();

	return { frontmatter, body: match[2] };
}

mock.module("@earendil-works/pi-coding-agent", () => ({
	VERSION: "0.75.0",
	AssistantMessageComponent: class {},
	ToolExecutionComponent: class {},
	UserMessageComponent: class {},
	getAgentDir: () => "/tmp/pi-hive-test-empty-agents",
	parseFrontmatter,
}));

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
