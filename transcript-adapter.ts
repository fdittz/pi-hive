import type { Message } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, type TUI, Text } from "@earendil-works/pi-tui";
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

export class TranscriptAdapter {
	private container = new Container();
	private streamingComponent?: AssistantMessageComponent;
	private streamingMessage?: Message;
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private expanded: boolean;
	private failed = false;
	private failureMessage?: string;

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
			this.container.clear();
			this.container.addChild(new Text(`Native transcript rendering failed: ${this.failureMessage}`, 0, 0));
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const component of this.pendingTools.values()) component.setExpanded(expanded);
		this.setExpandedOnChildren(this.container.children, expanded);
	}

	render(width: number): string[] {
		return this.container.render(width);
	}

	hasFailed(): boolean {
		return this.failed;
	}

	private handleMessageStart(message: Message | undefined): void {
		if (!message) return;
		if (message.role === "user") {
			const text = this.getUserText(message);
			const component = tryNative(() => new UserMessageComponent(text));
			if (component) this.container.addChild(component);
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
				this.container.addChild(this.streamingComponent);
				this.streamingComponent.updateContent(message as any);
			}
		}
	}

	private handleMessageUpdate(message: Message | undefined): void {
		if (!message || message.role !== "assistant") return;
		if (!this.streamingComponent) this.handleMessageStart(message);
		this.streamingMessage = message;
		this.streamingComponent?.updateContent(message as any);
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
				if (this.streamingComponent) this.container.addChild(this.streamingComponent);
			}
			this.streamingMessage = message;
			this.streamingComponent?.updateContent(message as any);
			this.ensureToolComponentsFromAssistantMessage(message, true);
			for (const component of this.pendingTools.values()) component.setArgsComplete();
			this.streamingComponent = undefined;
			this.streamingMessage = undefined;
		} else if (message.role === "toolResult") {
			const toolResult = message as any;
			const component = this.pendingTools.get(toolResult.toolCallId);
			if (component) {
				component.updateResult({ content: toolResult.content ?? [], details: toolResult.details, isError: Boolean(toolResult.isError) });
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
		component?.markExecutionStarted();
	}

	private handleToolExecutionUpdate(event: StoredTranscriptEvent): void {
		const toolCallId = String(event.toolCallId ?? "");
		const component = this.pendingTools.get(toolCallId);
		if (!component) return;
		component.updateResult({ ...((event.partialResult as any) ?? {}), isError: false }, true);
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
		this.pendingTools.delete(toolCallId);
	}

	private ensureToolComponentsFromAssistantMessage(message: Message, argsComplete: boolean): void {
		for (const part of (message as any).content ?? []) {
			if (part?.type !== "toolCall") continue;
			const component = this.ensureToolComponent(part.name, part.id, part.arguments ?? {});
			if (argsComplete) component?.setArgsComplete();
		}
	}

	private ensureToolComponent(name: string, id: string, args: Record<string, unknown>): ToolExecutionComponent | undefined {
		if (!id) return undefined;
		const existing = this.pendingTools.get(id);
		if (existing) {
			existing.updateArgs(args);
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
		this.container.addChild(component);
		return component;
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
