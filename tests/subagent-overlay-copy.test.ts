import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SubagentRunRecord } from "../transcript-types.js";

const editorInputs: string[][] = [];

mock.module("@earendil-works/pi-tui", () => ({
	Container: class {
		children: unknown[] = [];

		addChild(child: unknown): void {
			this.children.push(child);
		}

		clear(): void {
			this.children = [];
		}

		invalidate(): void {}
	},
	Text: class {
		constructor(private text: string) {}

		render(): string[] {
			return [this.text];
		}
	},
	Spacer: class {
		render(): string[] {
			return [];
		}
	},
	Key: {
		escape: "escape",
		enter: "enter",
		return: "return",
		left: "left",
		right: "right",
		up: "up",
		down: "down",
		pageUp: "pageUp",
		pageDown: "pageDown",
		home: "home",
		end: "end",
		alt: (key: string) => `alt+${key}`,
		ctrlShift: (key: string) => `ctrl+shift+${key}`,
	},
	matchesKey: (data: string, keyId: string) => data === keyId,
	truncateToWidth: (text: string, width: number) => text.slice(0, Math.max(0, width)),
	visibleWidth: (text: string) => [...text].length,
	wrapTextWithAnsi: (text: string, width: number): string[] => {
		const safeWidth = Math.max(1, Math.floor(width));
		if (text.length === 0) return [];
		const lines: string[] = [];
		for (let i = 0; i < text.length; i += safeWidth) lines.push(text.slice(i, i + safeWidth));
		return lines;
	},
}));

mock.module("@earendil-works/pi-coding-agent", () => ({
	VERSION: "0.75.0",
	AssistantMessageComponent: class {},
	ToolExecutionComponent: class {},
	UserMessageComponent: class {},
	CustomEditor: class {
		focused = false;
		disableSubmit = false;
		onSubmit?: (text: string) => void;
		private text = "";
		private inputs: string[] = [];

		constructor() {
			editorInputs.push(this.inputs);
		}

		getText(): string {
			return this.text;
		}

		getExpandedText(): string {
			return this.text;
		}

		setText(text: string): void {
			this.text = text;
		}

		addToHistory(): void {}

		isShowingAutocomplete(): boolean {
			return false;
		}

		handleInput(data: string): void {
			this.inputs.push(data);
		}

		render(): string[] {
			return [];
		}
	},
	FooterComponent: class {
		render(): string[] {
			return [];
		}

		invalidate(): void {}

		dispose(): void {}
	},
	getSelectListTheme: () => ({}),
}));

const { SubagentOverlay } = await import("../subagent-overlay.js");

const originalStdoutWrite = process.stdout.write;

afterEach(() => {
	(process.stdout.write as unknown as (chunk: unknown) => boolean) = originalStdoutWrite as unknown as (chunk: unknown) => boolean;
	editorInputs.length = 0;
});

function createRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
	return {
		id: "run-1",
		parentToolCallId: "tool-1",
		mode: "single",
		agent: "worker",
		agentSource: "package",
		task: "copy overlay selection",
		cwd: "/tmp/run-1",
		model: "test/model",
		status: "done",
		startedAt: 0,
		liveEvents: [],
		revision: 0,
		replayEvents: [],
		...overrides,
	};
}

function createTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function createTui() {
	return {
		terminal: {
			rows: 24,
			write: mock(() => undefined),
		},
		requestRender: mock(() => undefined),
	};
}

function createRegistry(run: SubagentRunRecord) {
	return {
		subscribe: mock(() => () => undefined),
		getRunsSortedByStartTime: mock(() => [run]),
		getRun: mock((id: string) => (id === run.id ? run : undefined)),
		getInputController: mock(() => undefined),
		cancelRun: mock(() => true),
	};
}

function createKeybindings(copyData = "custom-copy") {
	return {
		matches: mock((data: string, keybinding: string) => keybinding === "tui.input.copy" && data === copyData),
		getKeys: mock((keybinding: string) => (keybinding === "tui.input.copy" ? ["ctrl+c"] : [])),
	};
}

function createOverlay(run = createRun(), keybindings = createKeybindings()) {
	return new SubagentOverlay(
		createTui() as any,
		createTheme() as any,
		keybindings as any,
		mock(() => undefined),
		createRegistry(run) as any,
		{ ctx: { modelRegistry: { isUsingOAuth: () => false } } } as any,
	);
}

function captureStdoutWrites(): string[] {
	const writes: string[] = [];
	(process.stdout.write as unknown as (chunk: unknown) => boolean) = mock((chunk: unknown) => {
		writes.push(String(chunk));
		return true;
	});
	return writes;
}

function selectText(overlay: InstanceType<typeof SubagentOverlay>, text: string): void {
	(overlay as any).selectedText = { start: { row: 0, col: 0 }, end: { row: 0, col: text.length } };
	(overlay as any).selectedPlainText = text;
}

function expectCopied(writes: string[], text: string): void {
	expect(writes).toContain(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
}

describe("SubagentOverlay copy shortcut", () => {
	test("copies the overlay selection only with Ctrl+Shift+C", () => {
		const writes = captureStdoutWrites();
		const overlay = createOverlay(createRun(), createKeybindings("custom-copy"));
		writes.length = 0;
		selectText(overlay, "selected text");

		overlay.handleInput("custom-copy");

		expect(writes).not.toContain(`\x1b]52;c;${Buffer.from("selected text").toString("base64")}\x07`);

		overlay.handleInput("ctrl+shift+c");

		expectCopied(writes, "selected text");
		overlay.dispose();
	});

	test("keeps Ctrl+C as the running-run cancel shortcut even with a selection", () => {
		const writes = captureStdoutWrites();
		const run = createRun({ status: "running" });
		const keybindings = createKeybindings("custom-copy");
		const registry = createRegistry(run);
		const overlay = new SubagentOverlay(
			createTui() as any,
			createTheme() as any,
			keybindings as any,
			mock(() => undefined),
			registry as any,
			{ ctx: { modelRegistry: { isUsingOAuth: () => false } } } as any,
		);
		writes.length = 0;
		selectText(overlay, "selected text");

		overlay.handleInput("ctrl+c");

		expect((overlay as any).cancelConfirmationRunId).toBe("run-1");
		expect(registry.cancelRun).not.toHaveBeenCalled();
		expect(writes).not.toContain(`\x1b]52;c;${Buffer.from("selected text").toString("base64")}\x07`);

		overlay.handleInput("ctrl+c");

		expect(registry.cancelRun).toHaveBeenCalledWith("run-1");
		overlay.dispose();
	});

	test("advertises only Ctrl+Shift+C in the copy help", () => {
		captureStdoutWrites();
		const overlay = createOverlay();

		const header = (overlay as any).renderHeader(createRun(), 1, 160).join("\n");

		expect(header).toContain("Ctrl+Shift+C copy");
		expect(header).not.toContain("Ctrl+C/Ctrl+Shift+C copy");
		overlay.dispose();
	});
});

describe("SubagentOverlay paste shortcut", () => {
	test("does not forward Ctrl+V to the live input editor", () => {
		captureStdoutWrites();
		const overlay = createOverlay(createRun({ status: "running" }));

		overlay.handleInput("ctrl+v");

		expect(editorInputs[0]).toEqual([]);
		overlay.dispose();
	});

	test("continues forwarding bracketed paste content to the live input editor", () => {
		captureStdoutWrites();
		const overlay = createOverlay(createRun({ status: "running" }));

		overlay.handleInput("\x1b[200~pasted text\x1b[201~");

		expect(editorInputs[0]).toEqual(["\x1b[200~pasted text\x1b[201~"]);
		overlay.dispose();
	});

	test("advertises Ctrl+Shift+V, not Ctrl+V, in the live paste help", () => {
		captureStdoutWrites();
		const overlay = createOverlay(createRun({ status: "running" }));

		const header = (overlay as any).renderHeader(createRun({ status: "running" }), 1, 200).join("\n");

		expect(header).toContain("Ctrl+Shift+V paste");
		expect(header).not.toContain("Ctrl+V paste");
		overlay.dispose();
	});
});
