/**
 * Índice de alturas para N componentes/blocos.
 * Suporta:
 * - getHeight(i): altura do bloco i
 * - setHeight(i, h): atualizar altura do bloco i
 * - getTotalHeight(): soma total
 * - findIndexAtOffset(offset): qual bloco contém linha `offset`
 *
 * Usa prefix sums atualizáveis para O(1) getTotalHeight e O(log n) busca.
 */

export interface HeightLookupResult {
	index: number;
	prefixBefore: number;
	innerOffset: number;
	height: number;
}

const toNonNegativeInt = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

export class LineHeightIndex {
	private heights: number[] = [];
	private prefixSums: number[] = [0];
	private totalHeight: number = 0;

	/**
	 * Reset com count blocos, alturas todas zero.
	 */
	reset(count: number): void {
		const safeCount = toNonNegativeInt(count);
		this.heights = new Array(safeCount).fill(0);
		this.prefixSums = new Array(safeCount + 1).fill(0);
		this.totalHeight = 0;
	}

	/**
	 * Append um novo bloco com altura opcional.
	 * Retorna índice do novo bloco.
	 */
	append(height: number = 0): number {
		const index = this.heights.length;
		const safeHeight = toNonNegativeInt(height);
		this.heights.push(safeHeight);
		this.totalHeight += safeHeight;
		this.prefixSums.push(this.totalHeight);
		return index;
	}

	/**
	 * Substituir todas as alturas em batch.
	 */
	setHeights(heights: number[]): void {
		this.heights = heights.map(toNonNegativeInt);
		this.updatePrefixSums();
	}

	/**
	 * Atualizar altura do bloco i.
	 * Se i >= length, expande.
	 */
	setHeight(index: number, height: number): void {
		if (!Number.isFinite(index)) return;
		const safeIndex = Math.floor(index);
		if (safeIndex < 0) return;

		const safeHeight = toNonNegativeInt(height);

		// Expandir se necessário
		while (this.heights.length <= safeIndex) {
			this.heights.push(0);
			this.prefixSums.push(this.totalHeight);
		}

		this.heights[safeIndex] = safeHeight;

		// Atualizar prefix sums
		this.updatePrefixSums();
	}

	/**
	 * Altura do bloco i (0 se fora do range).
	 */
	getHeight(index: number): number {
		if (!Number.isFinite(index)) return 0;
		return this.heights[Math.floor(index)] ?? 0;
	}

	/**
	 * Altura total = soma de todas as alturas.
	 */
	getTotalHeight(): number {
		return this.totalHeight;
	}

	/**
	 * Quantos blocos tem.
	 */
	getBlockCount(): number {
		return this.heights.length;
	}

	/**
	 * Soma das alturas dos blocos antes do índice `index`.
	 * Ex: prefixBefore(0) = 0, prefixBefore(1) = height[0], etc.
	 */
	prefixBefore(index: number): number {
		if (!Number.isFinite(index)) return 0;
		const safeIndex = Math.floor(index);
		if (safeIndex <= 0) return 0;
		if (safeIndex >= this.prefixSums.length) return this.totalHeight;
		return this.prefixSums[safeIndex];
	}

	/**
	 * Encontrar qual bloco contém a linha global `offset`.
	 *
	 * Exemplo:
	 * - Blocos: [10, 20, 15] linhas
	 * - offset = 25 → { index: 1, prefixBefore: 10, innerOffset: 15, height: 20 }
	 *
	 * Retorna undefined se offset >= totalHeight.
	 */
	findIndexAtOffset(offset: number): HeightLookupResult | undefined {
		const safeOffset = toNonNegativeInt(offset);
		if (safeOffset >= this.totalHeight) return undefined;

		// Busca binária pelo primeiro prefix sum maior que o offset.
		let low = 1;
		let high = this.heights.length;
		while (low < high) {
			const mid = Math.floor((low + high) / 2);
			if (this.prefixSums[mid] > safeOffset) {
				high = mid;
			} else {
				low = mid + 1;
			}
		}

		const index = low - 1;
		const prefixBefore = this.prefixSums[index] ?? 0;
		const height = this.heights[index] ?? 0;
		return {
			index,
			prefixBefore,
			innerOffset: safeOffset - prefixBefore,
			height,
		};
	}

	private updatePrefixSums(): void {
		let cumulative = 0;
		this.prefixSums = new Array(this.heights.length + 1);
		for (let i = 0; i <= this.heights.length; i++) {
			this.prefixSums[i] = cumulative;
			if (i < this.heights.length) {
				cumulative += this.heights[i];
			}
		}
		this.totalHeight = cumulative;
	}
}
