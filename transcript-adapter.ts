import type { Message } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TUI, Text } from "@earendil-works/pi-tui";
import { tryNative } from "./compatibility.js";
import type { StoredTranscriptEvent } from "./transcript-types.js";

export interface TranscriptAdapterOptions {
	tui: TUI;
	cwd: string;
	expanded: boolean;
	showImages?: boolean;
	imageWidthCells?: number;
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
}

export interface TranscriptViewportRender {
	lines: string[];
	totalLines: number;
	version: number;
}

interface ComponentRenderCache {
	component: Component;
	width?: number;
	lines: string[];
	dirty: boolean;
}

export class TranscriptAdapter {
	private container = new Container();
	private componentCaches: ComponentRenderCache[] = [];
	private componentCacheByComponent = new Map<Component, ComponentRenderCache>();
	private streamingComponent?: AssistantMessageComponent;
	private streamingMessage?: Message;
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private expanded: boolean;
	private failed = false;
	private failureMessage?: string;
	private renderVersion = 0;

	constructor(private options: TranscriptAdapterOptions) {
		this.expanded = options.expanded;
	}

	consume(event: StoredTranscriptEvent): void {
		if (this.failed) return;
		try {
			switch (event.type) {
				case "message_start":
					this.handleMessageStart(event.message as Message | undefined);
					break;
				case "message_update":
					this.handleMessageUpdate(event.message as Message | undefined);
					break;
				case "message_end":
					this.handleMessageEnd(event.message as Message | undefined);
					break;
				case "tool_result_end":
					this.handleMessageEnd(event.message as Message | undefined);
					break;
				case "tool_execution_start":
					this.handleToolExecutionStart(event);
					break;
				case "tool_execution_update":
					this.handleToolExecutionUpdate(event);
					break;
				case "tool_execution_end":
					this.handleToolExecutionEnd(event);
					break;
			}
		} catch (error) {
			this.failed = true;
			this.failureMessage = error instanceof Error ? error.message : String(error);
			this.streamingComponent = undefined;
			this.streamingMessage = undefined;
			this.pendingTools.clear();
			this.resetComponents();
			this.addComponent(new Text(`Native transcript rendering failed: ${this.failureMessage}`, 0, 0));
		}
	}

	consumeMany(events: readonly StoredTranscriptEvent[], startIndex = 0): number {
		let consumed = 0;
		for (let i = Math.max(0, startIndex); i < events.length; i++) {
			this.consume(events[i]);
			consumed++;
			if (this.failed) break;
		}
		return consumed;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		for (const component of this.pendingTools.values()) component.setExpanded(expanded);
		this.setExpandedOnChildren(this.container.children, expanded);
		this.container.invalidate();
		this.markAllComponentsDirty();
	}

	render(width: number): string[] {
		return this.renderViewport(width, 0, Number.MAX_SAFE_INTEGER).lines;
	}

	renderViewport(width: number, offset: number, height: number): TranscriptViewportRender {
		const safeWidth = Math.max(1, Math.floor(width));
		const safeOffset = Math.max(0, Math.floor(offset));
		const safeHeight = Math.max(0, Math.floor(height));
		const end = safeOffset + safeHeight;
		const lines: string[] = [];
		let cursor = 0;

		for (const cache of this.componentCaches) {
			const componentLines = this.renderComponent(cache, safeWidth);
			const nextCursor = cursor + componentLines.length;
			if (safeHeight > 0 && nextCursor > safeOffset && cursor < end) {
				const startInComponent = Math.max(0, safeOffset - cursor);
				const endInComponent = Math.min(componentLines.length, end - cursor);
				lines.push(...componentLines.slice(startInComponent, endInComponent));
			}
			cursor = nextCursor;
		}

		return { lines, totalLines: cursor, version: this.renderVersion };
	}

	getLineCount(width: number): number {
		const safeWidth = Math.max(1, Math.floor(width));
		let total = 0;
		for (const cache of this.componentCaches) {
			total += this.renderComponent(cache, safeWidth).length;
		}
		return total;
	}

	getRenderVersion(): number {
		return this.renderVersion;
	}

	hasFailed(): boolean {
		return this.failed;
	}

	private handleMessageStart(message: Message | undefined): void {
		if (!message) return;
		if (message.role === "user") {
			const text = this.getUserText(message);
			const component = tryNative(() => new UserMessageComponent(text));
			if (component) this.addComponent(component);
		} else if (message.role === "assistant") {
			this.streamingComponent = tryNative(
				() =>
					new AssistantMessageComponent(
						undefined,
						this.options.hideThinkingBlock ?? false,
						undefined,
						this.options.hiddenThinkingLabel ?? "Thinking...",
					),
			);
			this.streamingMessage = message;
			if (this.streamingComponent) {
				this.addComponent(this.streamingComponent);
				this.streamingComponent.updateContent(message as any);
				this.markComponentDirty(this.streamingComponent);
			}
		}
	}

	private handleMessageUpdate(message: Message | undefined): void {
		if (!message || message.role !== "assistant") return;
		if (!this.streamingComponent) this.handleMessageStart(message);
		this.streamingMessage = message;
		if (this.streamingComponent) {
			this.streamingComponent.updateContent(message as any);
			this.markComponentDirty(this.streamingComponent);
		}
		this.ensureToolComponentsFromAssistantMessage(message, false);
	}

	private handleMessageEnd(message: Message | undefined): void {
		if (!message) return;
		if (message.role === "assistant") {
			if (!this.streamingComponent) {
				this.streamingComponent = tryNative(
					() =>
						new AssistantMessageComponent(
							undefined,
							this.options.hideThinkingBlock ?? false,
							undefined,
							this.options.hiddenThinkingLabel ?? "Thinking...",
						),
				);
				if (this.streamingComponent) this.addComponent(this.streamingComponent);
			}
			this.streamingMessage = message;
			if (this.streamingComponent) {
				this.streamingComponent.updateContent(message as any);
				this.markComponentDirty(this.streamingComponent);
			}
			this.ensureToolComponentsFromAssistantMessage(message, true);
			for (const component of this.pendingTools.values()) {
				component.setArgsComplete();
				this.markComponentDirty(component);
			}
			this.streamingComponent = undefined;
			this.streamingMessage = undefined;
		} else if (message.role === "toolResult") {
			const toolResult = message as any;
			const component = this.pendingTools.get(toolResult.toolCallId);
			if (component) {
				component.updateResult({ content: toolResult.content ?? [], details: toolResult.details, isError: Boolean(toolResult.isError) });
				this.markComponentDirty(component);
				this.pendingTools.delete(toolResult.toolCallId);
			}
		}
	}

	private handleToolExecutionStart(event: StoredTranscriptEvent): void {
		const toolCallId = String(event.toolCallId ?? "");
		if (!toolCallId) return;
		const component = this.ensureToolComponent(
			String(event.toolName ?? "tool"),
			toolCallId,
			(event.args ?? {}) as Record<string, unknown>,
		);
		if (!component) return;
		component.markExecutionStarted();
		this.markComponentDirty(component);
	}

	private handleToolExecutionUpdate(event: StoredTranscriptEvent): void {
		const toolCallId = String(event.toolCallId ?? "");
		const component = this.pendingTools.get(toolCallId);
		if (!component) return;
		component.updateResult({ ...((event.partialResult as any) ?? {}), isError: false }, true);
		this.markComponentDirty(component);
	}

	private handleToolExecutionEnd(event: StoredTranscriptEvent): void {
		const toolCallId = String(event.toolCallId ?? "");
		let component = this.pendingTools.get(toolCallId);
		if (!component) {
			component = this.ensureToolComponent(
				String(event.toolName ?? "tool"),
				toolCallId,
				(event.args ?? {}) as Record<string, unknown>,
			);
		}
		if (!component) return;
		component.updateResult({ ...((event.result as any) ?? {}), isError: Boolean(event.isError) });
		this.markComponentDirty(component);
		this.pendingTools.delete(toolCallId);
	}

	private ensureToolComponentsFromAssistantMessage(message: Message, argsComplete: boolean): void {
		for (const part of (message as any).content ?? []) {
			if (part?.type !== "toolCall") continue;
			const component = this.ensureToolComponent(part.name, part.id, part.arguments ?? {});
			if (argsComplete && component) {
				component.setArgsComplete();
				this.markComponentDirty(component);
			}
		}
	}

	private ensureToolComponent(name: string, id: string, args: Record<string, unknown>): ToolExecutionComponent | undefined {
		if (!id) return undefined;
		const existing = this.pendingTools.get(id);
		if (existing) {
			existing.updateArgs(args);
			this.markComponentDirty(existing);
			return existing;
		}
		const component = tryNative(
			() =>
				new ToolExecutionComponent(
					name,
					id,
					args,
					{
						showImages: this.options.showImages ?? true,
						imageWidthCells: this.options.imageWidthCells ?? 60,
					},
					undefined,
					this.options.tui,
					this.options.cwd,
				),
		);
		if (!component) return undefined;
		component.setExpanded(this.expanded);
		this.pendingTools.set(id, component);
		this.addComponent(component);
		return component;
	}

	private addComponent(component: Component): void {
		this.container.addChild(component);
		const cache: ComponentRenderCache = { component, lines: [], dirty: true };
		this.componentCaches.push(cache);
		this.componentCacheByComponent.set(component, cache);
		this.bumpRenderVersion();
	}

	private resetComponents(): void {
		this.container.clear();
		this.componentCaches = [];
		this.componentCacheByComponent.clear();
	}

	private markComponentDirty(component: Component): void {
		const cache = this.componentCacheByComponent.get(component);
		if (cache) cache.dirty = true;
		this.bumpRenderVersion();
	}

	private markAllComponentsDirty(): void {
		for (const cache of this.componentCaches) cache.dirty = true;
		this.bumpRenderVersion();
	}

	private bumpRenderVersion(): void {
		this.renderVersion++;
	}

	private renderComponent(cache: ComponentRenderCache, width: number): string[] {
		if (!cache.dirty && cache.width === width) return cache.lines;
		cache.lines = cache.component.render(width);
		cache.width = width;
		cache.dirty = false;
		return cache.lines;
	}

	private getUserText(message: Message): string {
		const content = (message as any).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((part) => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}

	private setExpandedOnChildren(children: any[], expanded: boolean): void {
		for (const child of children) {
			if (child && typeof child.setExpanded === "function") child.setExpanded(expanded);
			if (Array.isArray(child?.children)) this.setExpandedOnChildren(child.children, expanded);
		}
	}
}
