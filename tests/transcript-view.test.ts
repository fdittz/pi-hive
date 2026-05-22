import { afterEach, describe, expect, it, mock } from "bun:test";

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };
	return { frontmatter: {}, body: match[2] };
}

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
	wrapTextWithAnsi: (text: string, width: number): string[] => {
		const safeWidth = Math.max(1, Math.floor(width));
		if (text.length === 0) return [];
		const lines: string[] = [];
		for (let i = 0; i < text.length; i += safeWidth) {
			lines.push(text.slice(i, i + safeWidth));
		}
		return lines;
	},
}));

mock.module("@earendil-works/pi-coding-agent", () => ({
	VERSION: "0.75.0",
	AssistantMessageComponent: class {},
	ToolExecutionComponent: class {},
	UserMessageComponent: class {},
	getAgentDir: () => "/tmp/pi-hive-test-empty-agents",
	withFileMutationQueue: async (_filePath: string, mutate: () => Promise<void>) => mutate(),
	parseFrontmatter,
}));

const { TranscriptView } = await import("../transcript-view.js");
const { WrappedLineVirtualizer } = await import("../wrapped-line-virtualizer.js");
const originalSetSourceLines = WrappedLineVirtualizer.prototype.setSourceLines;
const originalRenderViewport = WrappedLineVirtualizer.prototype.renderViewport;

const createResultRun = (resultOutput: string) => ({
	id: "run-1",
	parentToolCallId: "tool-1",
	mode: "single",
	agent: "worker",
	agentSource: "package",
	task: "render output",
	cwd: "/tmp",
	status: "done",
	startedAt: 0,
	liveEvents: [],
	revision: 0,
	replayEvents: [],
	resultOutput,
});

const createPlainRun = (revision = 0) => ({
	id: "run-plain",
	parentToolCallId: "tool-1",
	mode: "single",
	agent: "worker",
	agentSource: "package",
	task: "render plain transcript",
	cwd: "/tmp",
	status: "done",
	startedAt: 0,
	liveEvents: [],
	revision,
	replayEvents: [
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "abcdefghijklmnopqrstuvwxyz" }],
			},
		},
	],
});

describe("TranscriptView resultOutput virtualization", () => {
	afterEach(() => {
		WrappedLineVirtualizer.prototype.setSourceLines = originalSetSourceLines;
		WrappedLineVirtualizer.prototype.renderViewport = originalRenderViewport;
		mock.restore();
	});

	it("should cache resultOutput virtualizer across renders", () => {
		const view = new TranscriptView();
		const output = "line1\nline2\nline3\nline4\n".repeat(50);
		const setSourceLines = mock(function (this: InstanceType<typeof WrappedLineVirtualizer>, lines: string[]): void {
			return originalSetSourceLines.call(this, lines);
		});
		WrappedLineVirtualizer.prototype.setSourceLines = setSourceLines;

		const result1 = view.renderRunViewport(createResultRun(output) as any, 80, {
			scrollOffset: 0,
			height: 10,
			stickToBottom: false,
		}, {} as any);
		const result2 = view.renderRunViewport(createResultRun(output) as any, 80, {
			scrollOffset: 5,
			height: 10,
			stickToBottom: false,
		}, {} as any);

		expect(result1.totalLines).toBe(result2.totalLines);
		expect(result1.lines.length).toBeLessThanOrEqual(10);
		expect(result2.lines.length).toBeLessThanOrEqual(10);
		expect(setSourceLines).toHaveBeenCalledTimes(1);
	});

	it("should invalidate resultOutput virtualizer", () => {
		const view = new TranscriptView();
		const output = "test";

		view.renderRunViewport(createResultRun(output) as any, 80, {
			scrollOffset: 0,
			height: 10,
			stickToBottom: false,
		}, {} as any);
		expect((view as any).resultOutputVirtualizer).toBeDefined();

		view.invalidate();
		expect((view as any).resultOutputVirtualizer).toBeUndefined();
		expect((view as any).lastResultOutput).toBeUndefined();

		const result = view.renderRunViewport(createResultRun(output) as any, 80, {
			scrollOffset: 0,
			height: 10,
			stickToBottom: false,
		}, {} as any);
		expect(result.lines.length).toBeLessThanOrEqual(10);
	});
});

describe("TranscriptView plain fallback virtualization", () => {
	afterEach(() => {
		WrappedLineVirtualizer.prototype.setSourceLines = originalSetSourceLines;
		WrappedLineVirtualizer.prototype.renderViewport = originalRenderViewport;
		mock.restore();
	});

	it("should render plain fallback through WrappedLineVirtualizer", () => {
		const view = new TranscriptView();
		const renderViewport = mock(function (
			this: InstanceType<typeof WrappedLineVirtualizer>,
			width: number,
			scrollOffset: number,
			height: number,
		) {
			return originalRenderViewport.call(this, width, scrollOffset, height);
		});
		WrappedLineVirtualizer.prototype.renderViewport = renderViewport;

		const result = (view as any).renderPlainViewport(createPlainRun() as any, 10, {
			scrollOffset: 1,
			height: 3,
			stickToBottom: false,
		}, {} as any);

		expect(renderViewport).toHaveBeenCalledTimes(1);
		expect(result.lines.length).toBeLessThanOrEqual(3);
		expect(result.scrollOffset).toBe(1);
	});

	it("should discard old virtualizers when run.revision changes", () => {
		const view = new TranscriptView();
		const run = createPlainRun();

		(view as any).renderPlainViewport(run as any, 10, {
			scrollOffset: 0,
			height: 3,
			stickToBottom: false,
		}, {} as any);
		(view as any).renderPlainViewport(run as any, 12, {
			scrollOffset: 0,
			height: 3,
			stickToBottom: false,
		}, {} as any);

		const cache = (view as any).plainTranscriptVirtualizers;
		expect(cache instanceof Map ? cache.size : 0).toBe(1);
		expect(cache.get("run-plain")?.revision).toBe(0);

		run.revision = 1;
		(view as any).renderPlainViewport(run as any, 10, {
			scrollOffset: 0,
			height: 3,
			stickToBottom: false,
		}, {} as any);

		expect(cache.size).toBe(1);
		expect(cache.get("run-plain")?.revision).toBe(1);

		view.invalidate();
		expect(cache.size).toBe(0);
	});
});
