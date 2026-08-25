import { describe, expect, test } from "bun:test";
import {
	INHERIT_MODEL,
	THINKING_LEVELS,
	resolveAgentModel,
	resolveThinkingLevels,
} from "../model-overrides.js";

/** Minimal Model shapes — only the fields getSupportedThinkingLevels reads. */
const noThinkingModel = { provider: "openai", id: "gpt-5-mini", reasoning: false } as any;
const plainReasoningModel = { provider: "anthropic", id: "claude-opus-4", reasoning: true } as any;
const xhighReasoningModel = {
	provider: "anthropic",
	id: "claude-opus-4-1",
	reasoning: true,
	thinkingLevelMap: { xhigh: "high" },
} as any;

describe("resolveThinkingLevels", () => {
	const available = [noThinkingModel, plainReasoningModel, xhighReasoningModel];

	test("concrete non-reasoning model offers only off", () => {
		expect(resolveThinkingLevels("openai/gpt-5-mini", available, undefined)).toEqual(["off"]);
	});

	test("concrete reasoning model without level map offers the standard levels (no xhigh/max)", () => {
		expect(resolveThinkingLevels("anthropic/claude-opus-4", available, undefined)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);
	});

	test("concrete reasoning model with xhigh mapping offers xhigh", () => {
		expect(resolveThinkingLevels("anthropic/claude-opus-4-1", available, undefined)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
	});

	test("inherit model uses the parent model's levels", () => {
		expect(resolveThinkingLevels(INHERIT_MODEL, available, plainReasoningModel)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);
	});

	test("unknown model ref falls back to the full level list", () => {
		expect(resolveThinkingLevels("unknown/model", available, undefined)).toEqual([
			...THINKING_LEVELS,
		]);
	});

	test("inherit without a parent model falls back to the full level list", () => {
		expect(resolveThinkingLevels(INHERIT_MODEL, available, undefined)).toEqual([...THINKING_LEVELS]);
	});
});

describe("model override parsing", () => {
	test("accepts the max thinking suffix", () => {
		const resolved = resolveAgentModel(
			{ name: "worker" } as any,
			undefined,
			{ version: 1, overrides: { worker: "anthropic/claude-opus-4:max" } },
			undefined,
		);
		expect(resolved.modelArg).toBe("anthropic/claude-opus-4");
		expect(resolved.thinkingArg).toBe("max");
	});
});
