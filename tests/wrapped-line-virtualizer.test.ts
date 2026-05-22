import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { WrappedLineVirtualizer } from "../wrapped-line-virtualizer.js";

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

const { WrappedLineVirtualizer } = await import("../wrapped-line-virtualizer.js");

describe("WrappedLineVirtualizer", () => {
	let virt: WrappedLineVirtualizer;

	beforeEach(() => {
		virt = new WrappedLineVirtualizer();
	});

	it("should start with no lines", () => {
		expect(virt.getTotalLines()).toBe(0);
	});

	it("should wrap single short line", () => {
		virt.setSourceLines(["hello world"]);
		virt.calcHeights(80);
		expect(virt.getTotalLines()).toBe(1);
	});

	it("should wrap long line to multiple", () => {
		const longLine = "a".repeat(100);
		virt.setSourceLines([longLine]);
		virt.calcHeights(20);
		// 100 chars / 20 width = 5 lines
		expect(virt.getTotalLines()).toBeGreaterThanOrEqual(5);
	});

	it("should renderViewport return correct slice", () => {
		virt.setSourceLines(["line1", "line2", "line3"]);
		virt.calcHeights(80);
		const result = virt.renderViewport(80, 0, 2);
		expect(result.lines).toEqual(["line1", "line2"]);
		expect(result.totalLines).toBe(3);
	});

	it("should return exact wrapped line contents for the visible viewport", () => {
		virt.setSourceLines(["abcdef", "ghij"]);
		virt.calcHeights(2);

		const result = virt.renderViewport(2, 1, 3);

		expect(result.lines).toEqual(["cd", "ef", "gh"]);
		expect(result.totalLines).toBe(5);
		expect(result.scrollOffset).toBe(1);
	});

	it("should clamp scroll offset to the last full viewport boundary", () => {
		virt.setSourceLines(["0", "1", "2", "3", "4"]);
		virt.calcHeights(80);

		const result = virt.renderViewport(80, 99, 2);

		expect(result.scrollOffset).toBe(3);
		expect(result.lines).toEqual(["3", "4"]);
	});

	it("should not leak overscan lines into the returned viewport", () => {
		const virt2 = new WrappedLineVirtualizer([], 100, 10);
		virt2.setSourceLines(Array.from({ length: 10 }, (_, i) => `line-${i}`));
		virt2.calcHeights(80);

		const result = virt2.renderViewport(80, 4, 2);

		expect(result.lines).toEqual(["line-4", "line-5"]);
	});

	it("should sanitize invalid widths when wrapping", () => {
		const line = "a".repeat(81);

		const nanWidth = new WrappedLineVirtualizer([line]);
		nanWidth.calcHeights(Number.NaN);
		expect(nanWidth.getTotalLines()).toBe(2);
		expect(nanWidth.renderViewport(Number.NaN, 0, 2).lines).toEqual(["a".repeat(80), "a"]);

		const infiniteWidth = new WrappedLineVirtualizer([line]);
		infiniteWidth.calcHeights(Number.POSITIVE_INFINITY);
		expect(infiniteWidth.getTotalLines()).toBe(2);

		const negativeWidth = new WrappedLineVirtualizer(["abc"]);
		negativeWidth.calcHeights(-10);
		expect(negativeWidth.getTotalLines()).toBe(3);
		expect(negativeWidth.renderViewport(-10, 0, 3).lines).toEqual(["a", "b", "c"]);
	});

	it("should not observe mutations to the input source line array", () => {
		const source = ["first"];
		virt.setSourceLines(source);

		source[0] = "mutated";
		source.push("extra");

		const result = virt.renderViewport(80, 0, 5);

		expect(result.totalLines).toBe(1);
		expect(result.lines).toEqual(["first"]);
	});

	it("should handle scroll offset", () => {
		virt.setSourceLines(["a".repeat(20), "b".repeat(20), "c".repeat(20)]);
		virt.calcHeights(10);
		const total = virt.getTotalLines();

		const result = virt.renderViewport(10, Math.floor(total / 2), 5);
		expect(result.lines.length).toBeLessThanOrEqual(5);
	});

	it("should recalc heights on width change", () => {
		virt.setSourceLines(["hello world hello world hello world"]);
		virt.calcHeights(80);
		const lines80 = virt.getTotalLines();

		virt.calcHeights(20);
		const lines20 = virt.getTotalLines();

		expect(lines20).toBeGreaterThan(lines80);
	});

	it("should invalidate cache", () => {
		virt.setSourceLines(["test"]);
		virt.calcHeights(80);
		const v1 = virt.renderViewport(80, 0, 1).version;

		virt.invalidate();
		const v2 = virt.renderViewport(80, 0, 1).version;

		expect(v2).toBeGreaterThan(v1);
	});

	it("should respect maxRenderedLines budget", () => {
		const virt2 = new WrappedLineVirtualizer([], 30, 10);
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
		virt2.setSourceLines(lines);
		virt2.calcHeights(80);

		const result = virt2.renderViewport(80, 50, 20);
		// Não vai retornar mais que 20 linhas do viewport
		expect(result.lines.length).toBeLessThanOrEqual(20);
	});
});
