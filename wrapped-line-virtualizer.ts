/**
 * Virtualiza linhas que precisam ser wrapped por width.
 *
 * Uso:
 * 1. Construir com linhas-fonte não-wrapped
 * 2. Chamar calcHeights(width) para medir
 * 3. Chamar renderViewport(scrollOffset, height) para obter linhas visíveis
 *
 * Mantém altura index e cache limitado a ~300 linhas.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { LineHeightIndex } from "./line-height-index.js";

const toSafeWidth = (width: number): number => (Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80);
const toNonNegativeInt = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

export interface WrappedViewportResult {
	lines: string[];
	totalLines: number;
	scrollOffset: number;
	version: number;
}

export class WrappedLineVirtualizer {
	private sourceLines: string[];
	private heightIndex: LineHeightIndex;
	private wrappedByWidth: Map<number, string[]> = new Map();
	private version: number = 0;
	private lastCalcWidth: number = -1;

	// Configuração
	readonly maxRenderedLines: number;
	readonly overscanLines: number;

	constructor(sourceLines: string[] = [], maxRendered = 300, overscan = 100) {
		this.sourceLines = [...sourceLines];
		this.heightIndex = new LineHeightIndex();
		this.maxRenderedLines = maxRendered;
		this.overscanLines = overscan;
		this.reset();
	}

	/**
	 * Substituir linhas-fonte.
	 */
	setSourceLines(lines: string[]): void {
		this.sourceLines = [...lines];
		this.reset();
	}

	/**
	 * Reset: descarta cache, recria índice vazio.
	 */
	reset(): void {
		this.heightIndex.reset(this.sourceLines.length);
		this.wrappedByWidth.clear();
		this.lastCalcWidth = -1;
		this.version++;
	}

	/**
	 * Calcular alturas para uma largura específica.
	 * Deve ser chamado antes de renderViewport ou getTotalLines.
	 */
	calcHeights(width: number): void {
		const safeWidth = toSafeWidth(width);
		if (this.lastCalcWidth === safeWidth) return;

		this.wrappedByWidth.clear();

		const heights: number[] = new Array(this.sourceLines.length);
		for (let i = 0; i < this.sourceLines.length; i++) {
			const wrapped = this.wrapSourceLine(this.sourceLines[i], safeWidth);
			this.wrappedByWidth.set(i, wrapped);
			heights[i] = wrapped.length;
		}
		this.heightIndex.setHeights(heights);

		this.lastCalcWidth = safeWidth;
		this.version++;
	}

	/**
	 * Total de linhas após wrap.
	 * Requer calcHeights() chamado antes com a mesma width.
	 */
	getTotalLines(): number {
		return this.heightIndex.getTotalHeight();
	}

	/**
	 * Renderizar viewport: linhas visíveis + overscan.
	 * Retorna slice que se inicia em scrollOffset e tem até height linhas.
	 *
	 * Overscan adiciona extra antes/depois para reduzir re-render em scroll pequeno.
	 */
	renderViewport(width: number, scrollOffset: number, height: number): WrappedViewportResult {
		const safeWidth = toSafeWidth(width);
		this.calcHeights(safeWidth);

		const safeOffset = toNonNegativeInt(scrollOffset);
		const safeHeight = toNonNegativeInt(height);
		const totalLines = this.getTotalLines();
		const maxScroll = Math.max(0, totalLines - safeHeight);
		const visibleOffset = Math.min(safeOffset, maxScroll);

		if (safeHeight === 0 || totalLines === 0) {
			return {
				lines: [],
				totalLines,
				scrollOffset: visibleOffset,
				version: this.version,
			};
		}

		// Sem overscan se já renderizamos muito
		const maxRendered = Math.max(safeHeight, Math.floor(this.maxRenderedLines));
		const overscan = safeHeight >= maxRendered ? 0 : Math.max(0, Math.floor(this.overscanLines));

		// Calcular range com overscan, preservando o viewport visível dentro do budget.
		const viewportEnd = Math.min(totalLines, visibleOffset + safeHeight);
		let rangeStart = Math.max(0, Math.min(totalLines, visibleOffset - overscan));
		let rangeEnd = Math.min(totalLines, visibleOffset + safeHeight + overscan);

		if (rangeEnd - rangeStart > maxRendered) {
			rangeEnd = Math.min(rangeEnd, rangeStart + maxRendered);
			if (rangeEnd < viewportEnd) {
				rangeEnd = viewportEnd;
				rangeStart = Math.max(0, rangeEnd - maxRendered);
			}
		}

		if (rangeEnd <= rangeStart) {
			return {
				lines: [],
				totalLines,
				scrollOffset: visibleOffset,
				version: this.version,
			};
		}

		const lines: string[] = [];
		const startLookup = this.heightIndex.findIndexAtOffset(rangeStart);
		if (!startLookup) {
			return {
				lines: [],
				totalLines,
				scrollOffset: visibleOffset,
				version: this.version,
			};
		}

		let currentLine = startLookup.prefixBefore;
		for (let sourceIndex = startLookup.index; sourceIndex < this.sourceLines.length && currentLine < rangeEnd; sourceIndex++) {
			const wrapped = this.wrappedByWidth.get(sourceIndex) || [];
			const sourceLineCount = wrapped.length;

			const nextLine = currentLine + sourceLineCount;
			if (nextLine > rangeStart && currentLine < rangeEnd) {
				// Essa linha-fonte intersecta o range
				const startInSource = Math.max(0, rangeStart - currentLine);
				const endInSource = Math.min(sourceLineCount, rangeEnd - currentLine);
				lines.push(...wrapped.slice(startInSource, endInSource));
			}

			currentLine = nextLine;
		}

		// Retornar só o viewport visível, não o overscan
		const viewportStartInLines = Math.max(0, visibleOffset - rangeStart);
		const viewportEndInLines = viewportStartInLines + safeHeight;
		const viewportLines = lines.slice(viewportStartInLines, viewportEndInLines);

		return {
			lines: viewportLines,
			totalLines,
			scrollOffset: visibleOffset,
			version: this.version,
		};
	}

	/**
	 * Invalidar cache (ex: mudança de width).
	 */
	invalidate(): void {
		this.reset();
	}

	private wrapSourceLine(line: string, width: number): string[] {
		const wrapped = wrapTextWithAnsi(line, width);
		return wrapped.length > 0 ? wrapped : [""];
	}
}
