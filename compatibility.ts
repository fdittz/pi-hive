import { VERSION, type Theme } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { colorAgentText } from "./agent-colors.js";
import type { StoredTranscriptEvent, SubagentRunRecord } from "./transcript-types.js";

export function getCompatibilityWarning(): string | undefined {
	if (!VERSION.startsWith("0.74.")) {
		return `Subagent live view was built against pi 0.74.x; current pi is ${VERSION}. Falling back if native rendering fails.`;
	}
	return undefined;
}

export function tryNative<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

function textParts(message: Message | undefined): string[] {
	if (!message || !Array.isArray((message as any).content)) return [];
	const out: string[] = [];
	for (const part of (message as any).content) {
		if (part?.type === "text" && typeof part.text === "string") out.push(part.text);
		if (part?.type === "thinking" && typeof part.thinking === "string") out.push(`[thinking] ${part.thinking}`);
	}
	return out;
}

function toolCalls(message: Message | undefined): Array<{ name: string; args: unknown }> {
	if (!message || !Array.isArray((message as any).content)) return [];
	const out: Array<{ name: string; args: unknown }> = [];
	for (const part of (message as any).content) {
		if (part?.type === "toolCall") out.push({ name: part.name ?? "tool", args: part.arguments ?? {} });
	}
	return out;
}

function stringifyArgs(args: unknown): string {
	try {
		const text = JSON.stringify(args);
		return text.length > 180 ? `${text.slice(0, 180)}...` : text;
	} catch {
		return String(args);
	}
}

function eventToPlainLines(event: StoredTranscriptEvent): string[] {
	if (event.type === "message_end" || event.type === "message_start") {
		const message = event.message as Message | undefined;
		if (!message) return [];
		const role = (message as any).role;
		const lines: string[] = [];
		for (const text of textParts(message)) {
			const trimmed = text.trim();
			if (trimmed) lines.push(`${role}: ${trimmed}`);
		}
		for (const call of toolCalls(message)) {
			lines.push(`→ ${call.name} ${stringifyArgs(call.args)}`);
		}
		if ((message as any).errorMessage) lines.push(`error: ${(message as any).errorMessage}`);
		return lines;
	}
	if (event.type === "tool_execution_start") {
		return [`→ ${event.toolName ?? "tool"} ${stringifyArgs(event.args ?? {})}`];
	}
	if (event.type === "tool_execution_update") {
		const partial = event.partialResult as any;
		const text = partial?.content?.find?.((c: any) => c?.type === "text")?.text;
		return text ? [`partial: ${text}`] : [];
	}
	if (event.type === "tool_execution_end") {
		const result = event.result as any;
		const prefix = event.isError ? "tool error" : "tool result";
		const text = result?.content?.find?.((c: any) => c?.type === "text")?.text;
		return text ? [`${prefix}: ${text}`] : [`${prefix}: ${event.toolName ?? "tool"}`];
	}
	return [];
}

export function renderPlainTranscript(run: SubagentRunRecord, theme?: Theme): string[] {
	const muted = (s: string) => (theme ? theme.fg("muted", s) : s);
	const accent = (s: string) => (theme ? theme.fg("accent", s) : s);
	const error = (s: string) => (theme ? theme.fg("error", s) : s);
	const lines: string[] = [];
	lines.push(`${theme ? colorAgentText(theme, run.agentColor, run.agent, "accent") : accent(run.agent)} ${muted(`[${run.status}]`)} ${run.model ? muted(run.model) : ""}`.trimEnd());
	lines.push(`${muted("Task:")} ${run.task}`);
	if (run.transcriptStorageError) lines.push(error(`Transcript storage: ${run.transcriptStorageError}`));
	if (run.errorMessage) lines.push(error(`Error: ${run.errorMessage}`));
	if (run.stderr) lines.push(error(`stderr: ${run.stderr.trim()}`));
	lines.push("");
	const events = run.liveEvents.length > 0 ? run.liveEvents : run.replayEvents;
	for (const event of events) {
		for (const line of eventToPlainLines(event)) lines.push(line);
	}
	if (lines.length <= 4) lines.push(muted("No transcript content captured."));
	return lines;
}
