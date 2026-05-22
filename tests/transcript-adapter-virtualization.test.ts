import { beforeEach, describe, expect, it, mock } from "bun:test";
import { LineHeightIndex } from "../line-height-index.js";
import type { TranscriptAdapter } from "../transcript-adapter.js";

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

mock.module("@earendil-works/pi-tui", () => {
	class Container {
		children: unknown[] = [];

		addChild(child: unknown): void {
			this.children.push(child);
		}

		clear(): void {
			this.children = [];
		}

		invalidate(): void {}
	}

	class Text {
		constructor(private text: string) {}

		render(_width: number): string[] {
			return [this.text];
		}
	}

	class Spacer {
		render(): string[] {
			return [];
		}
	}

	return {
		Container,
		Spacer,
		Text,
		wrapTextWithAnsi: (text: string, width: number): string[] => {
			const safeWidth = Math.max(1, Math.floor(width));
			if (text.length === 0) return [];
			const lines: string[] = [];
			for (let i = 0; i < text.length; i += safeWidth) {
				lines.push(text.slice(i, i + safeWidth));
			}
			return lines;
		},
	};
});

mock.module("@earendil-works/pi-coding-agent", () => ({
	VERSION: "0.75.0",
	AssistantMessageComponent: class {},
	ToolExecutionComponent: class {},
	UserMessageComponent: class {},
	getAgentDir: () => "/tmp/pi-hive-test-empty-agents",
	withFileMutationQueue: async (_filePath: string, mutate: () => Promise<void>) => mutate(),
	parseFrontmatter,
}));

const { TranscriptAdapter } = await import("../transcript-adapter.js");

class MockComponent {
	renderCalls = 0;

	constructor(
		private lineCount: number,
		private label: string,
	) {}

	setLineCount(lineCount: number): void {
		this.lineCount = lineCount;
	}

	render(width: number): string[] {
		this.renderCalls++;
		return Array.from({ length: this.lineCount }, (_, i) => `${this.label}-${i}`.padEnd(width, " "));
	}
}

const createAdapter = (): TranscriptAdapter =>
	new TranscriptAdapter({
		tui: {} as any,
		cwd: "/tmp",
		expanded: false,
	});

const addComponent = (adapter: TranscriptAdapter, component: MockComponent): void => {
	(adapter as any).addComponent(component);
};

const markComponentDirty = (adapter: TranscriptAdapter, index: number): void => {
	(adapter as any).markComponentDirty(index);
};

const markAllComponentsDirty = (adapter: TranscriptAdapter): void => {
	(adapter as any).markAllComponentsDirty();
};

describe("TranscriptAdapter virtualization", () => {
	let adapter: TranscriptAdapter;

	beforeEach(() => {
		adapter = createAdapter();
	});

	it("tracks total line count across multiple components", () => {
		addComponent(adapter, new MockComponent(100, "a"));
		addComponent(adapter, new MockComponent(200, "b"));
		addComponent(adapter, new MockComponent(300, "c"));

		expect(adapter.getLineCount(80)).toBe(600);
	});

	it("renders viewport at the beginning, middle, and end of the transcript", () => {
		addComponent(adapter, new MockComponent(4, "a"));
		addComponent(adapter, new MockComponent(4, "b"));
		addComponent(adapter, new MockComponent(4, "c"));

		expect(adapter.renderViewport(20, 0, 3).lines.map((line) => line.trim())).toEqual(["a-0", "a-1", "a-2"]);
		expect(adapter.renderViewport(20, 5, 4).lines.map((line) => line.trim())).toEqual(["b-1", "b-2", "b-3", "c-0"]);

		const end = adapter.renderViewport(20, 10, 5);
		expect(end.totalLines).toBe(12);
		expect(end.lines.map((line) => line.trim())).toEqual(["c-2", "c-3"]);
	});

	it("recalculates component height after markComponentDirty", () => {
		const component = new MockComponent(3, "dirty");
		addComponent(adapter, component);
		expect(adapter.getLineCount(80)).toBe(3);

		component.setLineCount(7);
		markComponentDirty(adapter, 0);

		expect(adapter.getLineCount(80)).toBe(7);
		expect(adapter.renderViewport(20, 5, 5).lines.map((line) => line.trim())).toEqual(["dirty-5", "dirty-6"]);
	});

	it("recalculates heights when the width changes", () => {
		class WidthSensitiveComponent extends MockComponent {
			override render(width: number): string[] {
				this.renderCalls++;
				const lineCount = width >= 40 ? 2 : 5;
				return Array.from({ length: lineCount }, (_, i) => `width-${width}-${i}`);
			}
		}

		const component = new WidthSensitiveComponent(0, "width");
		addComponent(adapter, component);

		expect(adapter.getLineCount(80)).toBe(2);
		expect(adapter.getLineCount(20)).toBe(5);
		expect(adapter.getLineCount(20)).toBe(5);
		expect(component.renderCalls).toBe(2);
	});

	it("updates the height index in one batch when measuring line counts", () => {
		const originalSetHeight = LineHeightIndex.prototype.setHeight;
		const originalSetHeights = LineHeightIndex.prototype.setHeights;
		let setHeightCalls = 0;
		let setHeightsCalls = 0;

		LineHeightIndex.prototype.setHeight = function (index: number, height: number): void {
			setHeightCalls++;
			return originalSetHeight.call(this, index, height);
		};
		LineHeightIndex.prototype.setHeights = function (heights: number[]): void {
			setHeightsCalls++;
			return originalSetHeights.call(this, heights);
		};

		try {
			addComponent(adapter, new MockComponent(50, "batch-a"));
			addComponent(adapter, new MockComponent(100, "batch-b"));
			addComponent(adapter, new MockComponent(75, "batch-c"));

			expect(adapter.getLineCount(80)).toBe(225);
			expect(setHeightCalls).toBe(0);
			expect(setHeightsCalls).toBe(1);
		} finally {
			LineHeightIndex.prototype.setHeight = originalSetHeight;
			LineHeightIndex.prototype.setHeights = originalSetHeights;
		}
	});

	it("handles markAllComponentsDirty correctly", () => {
		addComponent(adapter, new MockComponent(50, "all-dirty-a"));
		addComponent(adapter, new MockComponent(100, "all-dirty-b"));

		markAllComponentsDirty(adapter);

		const total = adapter.getLineCount(80);
		expect(total).toBe(150);
	});

	it("renders viewport correctly even with dirty components", () => {
		addComponent(adapter, new MockComponent(50, "cold-a"));
		addComponent(adapter, new MockComponent(100, "cold-b"));
		addComponent(adapter, new MockComponent(75, "cold-c"));
		markAllComponentsDirty(adapter);

		const result = adapter.renderViewport(80, 50, 30);

		expect(result.lines.length).toBeLessThanOrEqual(30);
		expect(result.totalLines).toBe(225);
	});

	it("does not render components outside the viewport", () => {
		const firstComponent = new MockComponent(100, "first");
		const secondComponent = new MockComponent(100, "second");
		const thirdComponent = new MockComponent(100, "third");
		addComponent(adapter, firstComponent);
		addComponent(adapter, secondComponent);
		addComponent(adapter, thirdComponent);

		const result = adapter.renderViewport(80, 0, 30);

		expect(result.lines).toHaveLength(30);
		expect(firstComponent.renderCalls).toBeLessThanOrEqual(2);
		expect(secondComponent.renderCalls).toBe(1);
		expect(thirdComponent.renderCalls).toBe(1);
	});

	it("uses the height index to skip components before the viewport", () => {
		const components = Array.from({ length: 5 }, (_, i) => new MockComponent(60, `block${i}`));
		for (const component of components) addComponent(adapter, component);

		expect(adapter.getLineCount(80)).toBe(300);
		for (const component of components) component.renderCalls = 0;

		const result = adapter.renderViewport(80, 180, 20);

		expect(result.totalLines).toBe(300);
		expect(result.lines).toHaveLength(20);
		expect(result.lines[0].trim()).toBe("block3-0");
		expect(components[0].renderCalls).toBe(0);
		expect(components[1].renderCalls).toBe(0);
		expect(components[2].renderCalls).toBe(0);
		expect(components[3].renderCalls).toBe(1);
		expect(components[4].renderCalls).toBe(0);
	});
});
