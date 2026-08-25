import * as os from "node:os";

/**
 * Shared, complete stubs for the pi peer packages used with bun's process-wide
 * `mock.module`.
 *
 * Bun gives the FIRST `mock.module` registration for a specifier to the entire
 * test process; later registrations are ignored. Whichever test file runs
 * first must therefore register a mock rich enough to satisfy the named-export
 * link requirements of every project module, including index.ts. All test
 * files that mock these packages must use these shared factories.
 *
 * Tests that run without a stale mock (file runs first, or standalone) resolve
 * the real packages through node_modules symlinks (see scripts/link-test-deps.sh).
 */

/** Minimal YAML-ish frontmatter parser matching pi's parseFrontmatter contract. */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
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

export interface PiCodingAgentStubOptions {
	getAgentDir?: () => string;
}

/** Complete stub for "@earendil-works/pi-coding-agent". */
export function piCodingAgentStub(options: PiCodingAgentStubOptions = {}): Record<string, unknown> {
	return {
		VERSION: "0.84.2",
		AssistantMessageComponent: class {},
		ToolExecutionComponent: class {},
		UserMessageComponent: class {},
		CustomEditor: class {},
		FooterComponent: class {},
		DynamicBorder: class {},
		getSelectListTheme: () => ({}),
		getMarkdownTheme: () => ({}),
		getAgentDir: options.getAgentDir ?? (() => process.env.PI_CODING_AGENT_DIR ?? os.tmpdir()),
		withFileMutationQueue: async (_filePath: string, mutate: () => Promise<void>) => mutate(),
		parseFrontmatter,
	};
}

/** Complete stub for "@earendil-works/pi-tui". */
export function piTuiStub(): Record<string, unknown> {
	return {
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
			constructor(public text: string = "") {}

			render(): string[] {
				return [this.text];
			}
		},
		Markdown: class {
			constructor(public text: string = "") {}

			render(): string[] {
				return [this.text];
			}
		},
		Spacer: class {
			render(): string[] {
				return [];
			}
		},
		SelectList: class {},
		Key: new Proxy(
			{},
			{
				get: (_target, prop) => (typeof prop === "string" ? prop : undefined),
			},
		),
		matchesKey: (_input: unknown, _key: unknown) => false,
		truncateToWidth: (text: string) => text,
		visibleWidth: (text: string) => text.length,
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
}
