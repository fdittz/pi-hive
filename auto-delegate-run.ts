export type SubagentInvocationSource = "auto-delegate" | "command";

interface BaseSubagentInvocationMessageOptions {
	source: SubagentInvocationSource;
	userMessage?: string;
	confidence?: number;
}

export interface SubagentTaskInvocationMessageOptions extends BaseSubagentInvocationMessageOptions {
	agent: string;
	task: string;
	background?: boolean;
}

export interface SubagentContinuationInvocationMessageOptions extends BaseSubagentInvocationMessageOptions {
	run: string;
	instruction?: string;
}

export type SubagentInvocationMessageOptions =
	| SubagentTaskInvocationMessageOptions
	| SubagentContinuationInvocationMessageOptions;

function isContinuationInvocation(
	options: SubagentInvocationMessageOptions,
): options is SubagentContinuationInvocationMessageOptions {
	return "run" in options;
}

export function buildSubagentInvocationMessage(options: SubagentInvocationMessageOptions): string {
	let header: string;
	let toolArgs: Record<string, unknown>;

	if (isContinuationInvocation(options)) {
		const run = options.run.trim();
		const instruction = options.instruction?.trim();
		toolArgs = instruction ? { run, instruction } : { run };
		header = `[SUBAGENT continue ${run}]`;
	} else {
		const agent = options.agent.trim();
		const task = options.task.trim();
		toolArgs = { agent, task };
		if (options.background) toolArgs.background = true;
		header =
			options.source === "auto-delegate"
				? `[AUTO-DELEGATED to ${agent} (${Math.round(options.confidence ?? 0)}% confidence)]`
				: `[SUBAGENT ${agent}]`;
	}

	const lines = [
		header,
		"",
		"Invoke the `subagent` tool now with exactly these arguments:",
		"",
		"```json",
		JSON.stringify(toolArgs, null, 2),
		"```",
		"",
		"Do not answer directly before the tool call. After the tool result, summarize the subagent result for the user.",
	];

	const originalRequest = options.userMessage?.trim();
	if (originalRequest) {
		lines.push("", `Original user request: ${originalRequest}`);
	}

	return lines.join("\n");
}
