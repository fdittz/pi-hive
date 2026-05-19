import { describe, it, expect } from "bun:test";
import { LineHeightIndex } from "../line-height-index.js";

describe("LineHeightIndex", () => {
	it("should start empty", () => {
		const idx = new LineHeightIndex();
		expect(idx.getTotalHeight()).toBe(0);
		expect(idx.getBlockCount()).toBe(0);
	});

	it("should append and track heights", () => {
		const idx = new LineHeightIndex();
		idx.append(10);
		idx.append(20);
		idx.append(30);
		expect(idx.getBlockCount()).toBe(3);
		expect(idx.getTotalHeight()).toBe(60);
	});

	it("should setHeight and update total", () => {
		const idx = new LineHeightIndex();
		idx.append(10);
		idx.append(20);
		expect(idx.getTotalHeight()).toBe(30);
		idx.setHeight(0, 15);
		expect(idx.getTotalHeight()).toBe(35);
		expect(idx.getHeight(0)).toBe(15);
	});

	it("should handle zero heights", () => {
		const idx = new LineHeightIndex();
		idx.append(10);
		idx.append(0);
		idx.append(20);
		expect(idx.getTotalHeight()).toBe(30);
		expect(idx.getHeight(1)).toBe(0);
	});

	it("should compute prefixBefore correctly", () => {
		const idx = new LineHeightIndex();
		idx.append(10);
		idx.append(20);
		idx.append(30);
		expect(idx.prefixBefore(0)).toBe(0);
		expect(idx.prefixBefore(1)).toBe(10);
		expect(idx.prefixBefore(2)).toBe(30);
		expect(idx.prefixBefore(3)).toBe(60);
	});

	it("should findIndexAtOffset correctly", () => {
		const idx = new LineHeightIndex();
		idx.append(10);
		idx.append(20);
		idx.append(30);

		const r0 = idx.findIndexAtOffset(0);
		expect(r0?.index).toBe(0);
		expect(r0?.innerOffset).toBe(0);
		expect(r0?.prefixBefore).toBe(0);

		const r15 = idx.findIndexAtOffset(15);
		expect(r15?.index).toBe(1);
		expect(r15?.innerOffset).toBe(5);
		expect(r15?.prefixBefore).toBe(10);

		const r59 = idx.findIndexAtOffset(59);
		expect(r59?.index).toBe(2);
		expect(r59?.innerOffset).toBe(29);
		expect(r59?.prefixBefore).toBe(30);
	});

	it("should find exact boundary offsets at the next non-empty block", () => {
		const idx = new LineHeightIndex();
		idx.append(10);
		idx.append(20);
		idx.append(30);

		const r10 = idx.findIndexAtOffset(10);
		expect(r10).toEqual({ index: 1, prefixBefore: 10, innerOffset: 0, height: 20 });

		const r30 = idx.findIndexAtOffset(30);
		expect(r30).toEqual({ index: 2, prefixBefore: 30, innerOffset: 0, height: 30 });

		expect(idx.findIndexAtOffset(60)).toBeUndefined();
	});

	it("should replace all heights in one batch", () => {
		const idx = new LineHeightIndex();
		idx.setHeights([5, 10, 15]);

		expect(idx.getBlockCount()).toBe(3);
		expect(idx.getTotalHeight()).toBe(30);
		expect(idx.prefixBefore(2)).toBe(15);

		idx.setHeights([2, 0, 3, 4]);

		expect(idx.getBlockCount()).toBe(4);
		expect(idx.getTotalHeight()).toBe(9);
		expect(idx.prefixBefore(1)).toBe(2);
		expect(idx.prefixBefore(2)).toBe(2);
		expect(idx.prefixBefore(3)).toBe(5);
		expect(idx.prefixBefore(4)).toBe(9);
	});

	it("should skip zero-height blocks in the middle of the queue", () => {
		const idx = new LineHeightIndex();
		idx.setHeights([5, 0, 0, 10]);

		expect(idx.getTotalHeight()).toBe(15);
		expect(idx.findIndexAtOffset(4)).toEqual({ index: 0, prefixBefore: 0, innerOffset: 4, height: 5 });
		expect(idx.findIndexAtOffset(5)).toEqual({ index: 3, prefixBefore: 5, innerOffset: 0, height: 10 });
		expect(idx.findIndexAtOffset(14)).toEqual({ index: 3, prefixBefore: 5, innerOffset: 9, height: 10 });
	});

	it("should coerce NaN and infinite sizes to zero", () => {
		const idx = new LineHeightIndex();

		idx.reset(Number.NaN);
		expect(idx.getBlockCount()).toBe(0);
		expect(idx.getTotalHeight()).toBe(0);

		idx.append(Number.NaN);
		idx.append(Number.POSITIVE_INFINITY);
		idx.append(Number.NEGATIVE_INFINITY);
		expect(idx.getBlockCount()).toBe(3);
		expect(idx.getTotalHeight()).toBe(0);
		expect(idx.getHeight(0)).toBe(0);
		expect(idx.getHeight(1)).toBe(0);
		expect(idx.getHeight(2)).toBe(0);

		idx.setHeight(1, Number.POSITIVE_INFINITY);
		idx.setHeight(2, 2.9);
		expect(idx.getTotalHeight()).toBe(2);
		expect(idx.getHeight(1)).toBe(0);
		expect(idx.getHeight(2)).toBe(2);
	});

	it("should return undefined for offset >= total", () => {
		const idx = new LineHeightIndex();
		idx.append(10);
		idx.append(20);
		const r = idx.findIndexAtOffset(100);
		expect(r).toBeUndefined();
	});

	it("should handle dynamic height changes", () => {
		const idx = new LineHeightIndex();
		idx.append(10);
		idx.append(20);
		idx.append(30);
		expect(idx.getTotalHeight()).toBe(60);

		// Diminuir altura do meio
		idx.setHeight(1, 10);
		expect(idx.getTotalHeight()).toBe(50);
		expect(idx.prefixBefore(2)).toBe(20);
	});

	it("should expand array if setHeight beyond current length", () => {
		const idx = new LineHeightIndex();
		idx.setHeight(10, 5);
		expect(idx.getBlockCount()).toBeGreaterThanOrEqual(11);
		expect(idx.getTotalHeight()).toBe(5);
	});
});
