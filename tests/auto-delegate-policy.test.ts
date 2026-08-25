import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { piCodingAgentStub } from "./helpers/pi-test-stubs.js";

// Bun module mocks are process-wide and the first registration wins for the
// whole process, so always register the shared complete stub.
mock.module("@earendil-works/pi-coding-agent", () => piCodingAgentStub());

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const { getAutoDelegateConfig, isAutoDelegateEnabled } = await import("../auto-delegate.js");
let agentDir: string | undefined;

beforeEach(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-auto-delegate-policy-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (agentDir) fs.rmSync(agentDir, { recursive: true, force: true });
	agentDir = undefined;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

describe("direct-first auto-delegation defaults", () => {
	test("disable automatic delegation and use a 90 percent default confidence threshold", async () => {
		expect(await getAutoDelegateConfig()).toEqual({ enabled: false, confidenceThreshold: 90, autoExecute: true });
		expect(await isAutoDelegateEnabled()).toBe(false);
	});

	test("preserve explicitly persisted delegation settings", async () => {
		if (!agentDir) throw new Error("test agent directory was not initialized");
		fs.writeFileSync(
			path.join(agentDir, "auto-delegate.json"),
			JSON.stringify({ enabled: true, confidenceThreshold: 72, autoExecute: false }),
			"utf8",
		);

		expect(await getAutoDelegateConfig()).toEqual({ enabled: true, confidenceThreshold: 72, autoExecute: false });
	});
});
