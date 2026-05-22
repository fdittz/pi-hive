export interface ChainPreviousStep {
	task: string;
}

export interface ChainAutoInjectPreviousConfig {
	enabled?: boolean;
	mode?: "append-block";
}

export const AUTO_INJECT_PREVIOUS_BLOCK = "\n\nContexto do passo anterior (auto-inserido):\n{previous}\n";

const PREVIOUS_PLACEHOLDER_PATTERN = /\{\s*previous\s*\}/i;
const PREVIOUS_PLACEHOLDER_REPLACE_PATTERN = /\{\s*previous\s*\}/gi;

export function hasPreviousPlaceholder(task: string): boolean {
	return PREVIOUS_PLACEHOLDER_PATTERN.test(task);
}

export function replacePreviousPlaceholder(task: string, previousOutput: string): string {
	return task.replace(PREVIOUS_PLACEHOLDER_REPLACE_PATTERN, () => previousOutput);
}

export function normalizeChainPrevious<T extends ChainPreviousStep>(
	chain: readonly T[],
	config: ChainAutoInjectPreviousConfig = {},
): T[] {
	const enabled = config.enabled ?? true;
	if (!enabled) return [...chain];

	return chain.map((step, index) => {
		if (index === 0 || hasPreviousPlaceholder(step.task)) return step;
		return { ...step, task: `${step.task}${AUTO_INJECT_PREVIOUS_BLOCK}` } as T;
	});
}
