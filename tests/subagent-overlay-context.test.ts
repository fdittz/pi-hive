import { describe, expect, test } from "bun:test";
import {
	collectSubagentFooterSnapshot,
	createSubagentFooterSessionAdapter,
	type SubagentFooterSnapshot,
} from "../subagent-overlay-context.js";
import type { SubagentRunRecord } from "../transcript-types.js";

function createRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
	return {
		id: "run-1",
		parentToolCallId: "tool-1",
		mode: "single",
		agent: "worker",
		agentSource: "package",
		task: "inspect footer data",
		cwd: "/tmp/run-1",
		model: "anthropic/claude-sonnet-4:high",
		status: "running",
		startedAt: 0,
		liveEvents: [],
		revision: 0,
		replayEvents: [],
		...overrides,
	};
}

function assistantMessage(id: string, usageOverrides: Record<string, unknown> = {}) {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text: `message ${id}` }],
		usage: {
			input: 10,
			output: 20,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 37,
			contextWindow: 100,
			cost: { total: 0.123 },
			...usageOverrides,
		},
	};
}

function sumSnapshot(snapshot: SubagentFooterSnapshot) {
	return snapshot.entries.reduce(
		(acc, entry) => {
			acc.input += entry.message.usage.input;
			acc.output += entry.message.usage.output;
			acc.cacheRead += entry.message.usage.cacheRead;
			acc.cacheWrite += entry.message.usage.cacheWrite;
			acc.cost += entry.message.usage.cost.total;
			return acc;
		},
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	);
}

describe("collectSubagentFooterSnapshot", () => {
	test("returns empty entries and null context when a run has no events", () => {
		const snapshot = collectSubagentFooterSnapshot(createRun());

		expect(snapshot.entries).toEqual([]);
		expect(snapshot.contextUsage).toEqual({ tokens: null, contextWindow: 0, percent: null });
		expect(snapshot.cwd).toBe("/tmp/run-1");
		expect(snapshot.model).toBe("anthropic/claude-sonnet-4:high");
	});

	test("extracts usage from a finalized assistant message", () => {
		const snapshot = collectSubagentFooterSnapshot(
			createRun({
				liveEvents: [{ type: "message_end", message: assistantMessage("msg-1") }],
			}),
		);

		expect(snapshot.entries).toHaveLength(1);
		expect(snapshot.entries[0]?.message.usage).toEqual({
			input: 10,
			output: 20,
			cacheRead: 3,
			cacheWrite: 4,
			cost: { total: 0.123 },
		});
		expect(snapshot.contextUsage).toEqual({ tokens: 37, contextWindow: 100, percent: 37 });
	});

	test("uses the latest streaming assistant update when there is no finalized message", () => {
		const snapshot = collectSubagentFooterSnapshot(
			createRun({
				liveEvents: [
					{ type: "message_update", message: assistantMessage("msg-1", { output: 1, totalTokens: 11 }) },
					{ type: "message_update", message: assistantMessage("msg-1", { output: 2, totalTokens: 12 }) },
				],
			}),
		);

		expect(snapshot.entries).toHaveLength(1);
		expect(snapshot.entries[0]?.message.usage.output).toBe(2);
		expect(snapshot.contextUsage.tokens).toBe(12);
	});

	test("prefers message_end over message_update for the same assistant message", () => {
		const snapshot = collectSubagentFooterSnapshot(
			createRun({
				liveEvents: [
					{ type: "message_update", message: assistantMessage("msg-1", { input: 100, totalTokens: 110 }) },
					{ type: "message_end", message: assistantMessage("msg-1", { input: 5, totalTokens: 25 }) },
				],
			}),
		);

		expect(snapshot.entries).toHaveLength(1);
		expect(sumSnapshot(snapshot)).toEqual({ input: 5, output: 20, cacheRead: 3, cacheWrite: 4, cost: 0.123 });
		expect(snapshot.contextUsage.tokens).toBe(25);
	});

	test("keeps multiple assistant messages so FooterComponent can sum their usage", () => {
		const snapshot = collectSubagentFooterSnapshot(
			createRun({
				liveEvents: [
					{ type: "message_end", message: assistantMessage("msg-1", { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, contextWindow: 200, cost: { total: 0.1 } }) },
					{ type: "message_end", message: assistantMessage("msg-2", { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, totalTokens: 20, contextWindow: 200, cost: { total: 0.2 } }) },
				],
			}),
		);

		expect(snapshot.entries).toHaveLength(2);
		expect(sumSnapshot(snapshot)).toEqual({ input: 6, output: 8, cacheRead: 10, cacheWrite: 12, cost: 0.30000000000000004 });
		expect(snapshot.contextUsage).toEqual({ tokens: 20, contextWindow: 200, percent: 10 });
	});
});

describe("createSubagentFooterSessionAdapter", () => {
	test("uses the current run from the dynamic getter for cwd, model, and entries", () => {
		const firstRun = createRun({
			id: "run-1",
			cwd: "/tmp/first",
			model: "anthropic/claude-sonnet-4",
			liveEvents: [{ type: "message_end", message: assistantMessage("msg-1", { input: 1 }) }],
		});
		const secondRun = createRun({
			id: "run-2",
			cwd: "/tmp/second",
			model: "openai/gpt-5",
			liveEvents: [{ type: "message_end", message: assistantMessage("msg-2", { input: 2 }) }],
		});
		let currentRun: SubagentRunRecord | undefined = firstRun;
		const host = {
			ctx: {
				modelRegistry: { isUsingOAuth: () => false },
			},
		} as any;
		const adapter = createSubagentFooterSessionAdapter(host, () => currentRun);

		expect(adapter.sessionManager.getCwd()).toBe("/tmp/first");
		expect(adapter.state.model?.id).toBe("anthropic/claude-sonnet-4");
		expect(adapter.state.model?.provider).toBe("anthropic");
		expect(adapter.sessionManager.getEntries()[0]?.message.usage.input).toBe(1);

		currentRun = secondRun;

		expect(adapter.sessionManager.getCwd()).toBe("/tmp/second");
		expect(adapter.state.model?.id).toBe("openai/gpt-5");
		expect(adapter.state.model?.provider).toBe("openai");
		expect(adapter.sessionManager.getEntries()[0]?.message.usage.input).toBe(2);

		currentRun = undefined;

		expect(adapter.sessionManager.getCwd()).toBe("");
		expect(adapter.state.model?.id).toBe("subagent");
		expect(adapter.sessionManager.getEntries()).toEqual([]);
	});
});
