import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { piCodingAgentStub, piTuiStub } from "./helpers/pi-test-stubs.js";

/**
 * Drives the real extension registration with a fake ExtensionAPI to verify
 * how the `input` handler treats messages that trigger auto-delegation.
 *
 * Desired behavior: when auto-delegation matches, the original user message
 * must still flow into the session as a normal user message (action "continue",
 * same as when auto-delegate is OFF). The auto-delegate steer is an added
 * nudge, not a replacement for the message.
 *
 * Setup note: bun's mock.module is process-wide and the first registration for
 * a specifier wins, so this file registers the shared complete stubs (same
 * factories the other test files use). Whichever file runs first, index.ts
 * links against a mock rich enough for every named export. The stub's
 * parseFrontmatter parses the real bundled agent files, and getAgentDir honors
 * PI_CODING_AGENT_DIR, which isolates config files in a temp dir.
 */

mock.module("@earendil-works/pi-coding-agent", () => piCodingAgentStub());
mock.module("@earendil-works/pi-tui", () => piTuiStub());

let agentDir: string | undefined;
let previousAgentDir: string | undefined;
let handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>;
let sentMessages: Array<{ message: { customType?: string; content: unknown; details?: unknown }; options?: unknown }>;

function writeAutoDelegateConfig(config: Record<string, unknown>): void {
	if (!agentDir) throw new Error("agent dir not initialized");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "auto-delegate.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

beforeAll(async () => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-auto-delegate-input-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const extension = (await import("../index.js")).default;
	const registered = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
			const list = registered.get(event) ?? [];
			list.push(handler);
			registered.set(event, list);
		},
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerTool: () => {},
		sendMessage: (message: { customType?: string; content: unknown; details?: unknown }, options?: unknown) => {
			sentMessages.push({ message, options });
		},
		getThinkingLevel: () => "low",
	} as never;
	extension(pi);
	handlers = registered;
});

afterAll(() => {
	if (agentDir) fs.rmSync(agentDir, { recursive: true, force: true });
	agentDir = undefined;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

beforeEach(() => {
	sentMessages = [];
});

function makeInputCtx() {
	return { cwd: process.cwd(), hasUI: false, ui: { notify: () => {} } } as never;
}

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("auto-delegate input handling", () => {
	test("matched message still flows to the agent as a normal user message (action continue)", async () => {
		writeAutoDelegateConfig({ enabled: true, confidenceThreshold: 0, autoExecute: true });
		const inputHandler = handlers.get("input")?.[0];
		expect(inputHandler).toBeDefined();

		const originalMessage =
			"review the authentication code for security issues and summarize the findings with file paths";
		const result = await inputHandler!(
			{ type: "input", text: originalMessage, source: "interactive" },
			makeInputCtx(),
		);

		expect(result).toEqual({ action: "continue" });
	});

	test("matched message keeps the full original text in the auto-delegate steer", async () => {
		writeAutoDelegateConfig({ enabled: true, confidenceThreshold: 0, autoExecute: true });
		const inputHandler = handlers.get("input")?.[0];
		const originalMessage =
			"review the authentication code for security issues and summarize the findings with file paths";

		await inputHandler!({ type: "input", text: originalMessage, source: "interactive" }, makeInputCtx());
		await flushMicrotasks();

		expect(sentMessages.length).toBe(1);
		const { message, options } = sentMessages[0];
		expect(message.customType).toBe("auto-delegate-result");
		expect(message.content).toContain("[AUTO-DELEGATED to");
		// The full original user request must be present verbatim in the steer.
		expect(message.content).toContain(originalMessage);
		expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
	});

	test("disabled auto-delegate lets the message flow and sends no steer", async () => {
		writeAutoDelegateConfig({ enabled: false, confidenceThreshold: 90, autoExecute: true });
		const inputHandler = handlers.get("input")?.[0];

		const result = await inputHandler!(
			{ type: "input", text: "review the authentication code for security issues", source: "interactive" },
			makeInputCtx(),
		);

		expect(result).toEqual({ action: "continue" });
		await flushMicrotasks();
		expect(sentMessages.length).toBe(0);
	});
});
