import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { SubagentDequeueResult } from "./live-registry.js";
import { getPiInvocation } from "./pi-invocation.js";

export type SubagentRpcEvent = Record<string, any>;

type RpcCommandLike = RpcCommand | ({ id?: string; type: string } & Record<string, unknown>);

type PendingRequest = {
	command: string;
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export interface SubagentRpcClientOptions {
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	commandTimeoutMs?: number;
}

function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function commandName(command: RpcCommandLike): string {
	return command.type;
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function fallbackDequeueResult(fallback: SubagentDequeueResult, error: unknown): SubagentDequeueResult {
	const errorMessage = error instanceof Error ? error.message : String(error);
	return {
		steering: [...fallback.steering],
		followUp: [...fallback.followUp],
		usedLocalFallback: true,
		errorMessage,
	};
}

function isRpcResponse(value: any): value is RpcResponse {
	return value && value.type === "response" && typeof value.command === "string";
}

function isExtensionUiRequest(value: any): boolean {
	return value && value.type === "extension_ui_request" && typeof value.id === "string";
}

function assertRpcSuccess(response: RpcResponse): void {
	if (response.success === false) throw new Error(response.error);
}

/**
 * Small RPC client tailored for pi-hive child subagents.
 *
 * The public RpcClient exported by pi assumes a node+dist/cli.js launch path; pi-hive
 * must reuse the same invocation resolution as print mode so extensions installed via
 * pi, node, bun, or a configured PI_HIVE_PI_COMMAND keep working.
 */
export class SubagentRpcClient {
	private proc?: ChildProcessWithoutNullStreams;
	private stdoutDecoder = new StringDecoder("utf8");
	private stderrDecoder = new StringDecoder("utf8");
	private buffer = "";
	private stderr = "";
	private nextRequestId = 0;
	private pendingRequests = new Map<string, PendingRequest>();
	private listeners = new Set<(event: SubagentRpcEvent) => void>();
	private endWaiters = new Set<() => void>();
	private exitWaiters = new Set<() => void>();
	private exitCode: number | undefined;
	private closed = false;
	private stopping = false;
	private agentEndCount = 0;

	constructor(private options: SubagentRpcClientOptions) {}

	async start(): Promise<void> {
		if (this.proc) throw new Error("Subagent RPC client already started");
		const invocation = getPiInvocation(this.options.args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: this.options.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: this.options.env,
		});
		this.proc = proc;

		proc.stdout.on("data", (data: Buffer) => this.handleStdout(this.stdoutDecoder.write(data)));
		proc.stderr.on("data", (data: Buffer) => {
			this.stderr += this.stderrDecoder.write(data);
		});
		proc.on("error", (error) => this.handleClose(1, error instanceof Error ? error : new Error(String(error))));
		proc.on("close", (code, signal) => this.handleClose(code ?? (signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : 0)));

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, 100);
			proc.once("close", (code) => {
				clearTimeout(timer);
				reject(new Error(`Subagent RPC process exited immediately with code ${code ?? 0}. ${this.stderr}`.trim()));
			});
		});
	}

	onEvent(listener: (event: SubagentRpcEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getStderr(): string {
		return this.stderr;
	}

	getAgentEndCount(): number {
		return this.agentEndCount;
	}

	getExitCode(): number | undefined {
		return this.exitCode;
	}

	isClosed(): boolean {
		return this.closed;
	}

	async prompt(message: string): Promise<void> {
		assertRpcSuccess(await this.send({ type: "prompt", message }));
	}

	async steer(message: string): Promise<void> {
		assertRpcSuccess(await this.send({ type: "steer", message }));
	}

	async followUp(message: string): Promise<void> {
		assertRpcSuccess(await this.send({ type: "follow_up", message }));
	}

	async clearQueue(fallback: SubagentDequeueResult): Promise<SubagentDequeueResult> {
		try {
			const response = await this.send({ type: "clear_queue" }, 1500);
			if (!response.success) throw new Error(response.error);
			const data = (response as { data?: unknown }).data as Partial<SubagentDequeueResult> | undefined;
			return {
				steering: toStringArray(data?.steering),
				followUp: toStringArray(data?.followUp),
				usedLocalFallback: false,
			};
		} catch (error) {
			return fallbackDequeueResult(fallback, error);
		}
	}

	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		if (!response.success) throw new Error(response.error);
		return response.data as RpcSessionState;
	}

	async waitForAgentEndAfter(previousCount: number, signal?: AbortSignal): Promise<void> {
		if (this.agentEndCount > previousCount) return;
		if (this.closed) throw new Error(`Subagent RPC process exited before agent_end. ${this.stderr}`.trim());
		if (signal?.aborted) throw new Error(String(signal.reason ?? "Aborted"));
		await new Promise<void>((resolve, reject) => {
			let done = false;
			const cleanup = () => {
				if (done) return;
				done = true;
				this.endWaiters.delete(onEnd);
				this.exitWaiters.delete(onExit);
				signal?.removeEventListener("abort", onAbort);
			};
			const onEnd = () => {
				if (this.agentEndCount <= previousCount) return;
				cleanup();
				resolve();
			};
			const onExit = () => {
				cleanup();
				reject(new Error(`Subagent RPC process exited before agent_end. ${this.stderr}`.trim()));
			};
			const onAbort = () => {
				cleanup();
				reject(new Error(String(signal?.reason ?? "Aborted")));
			};
			this.endWaiters.add(onEnd);
			this.exitWaiters.add(onExit);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async waitForExit(): Promise<number | undefined> {
		if (this.closed) return this.exitCode;
		await new Promise<void>((resolve) => {
			const onExit = () => {
				this.exitWaiters.delete(onExit);
				resolve();
			};
			this.exitWaiters.add(onExit);
		});
		return this.exitCode;
	}

	async stop(graceMs = 1000): Promise<void> {
		if (!this.proc || this.closed) return;
		this.stopping = true;
		this.proc.kill("SIGTERM");
		await Promise.race([
			this.waitForExit(),
			new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					if (!this.closed) this.proc?.kill("SIGKILL");
					resolve();
				}, graceMs);
				(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
			}),
		]);
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		if (!this.proc || this.closed) return;
		this.proc.kill(signal);
	}

	private handleStdout(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() || "";
		for (const line of lines) this.handleLine(line);
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let data: any;
		try {
			data = JSON.parse(line);
		} catch {
			return;
		}

		if (isRpcResponse(data) && data.id && this.pendingRequests.has(data.id)) {
			const pending = this.pendingRequests.get(data.id)!;
			this.pendingRequests.delete(data.id);
			clearTimeout(pending.timer);
			pending.resolve(data);
			return;
		}

		if (isRpcResponse(data) && !data.id) {
			const [candidate] = Array.from(this.pendingRequests.entries()).filter(([, pending]) => pending.command === data.command);
			if (candidate) {
				const [id, pending] = candidate;
				this.pendingRequests.delete(id);
				clearTimeout(pending.timer);
				pending.resolve(data);
				return;
			}
		}

		if (isExtensionUiRequest(data)) {
			this.respondToExtensionUiRequest(data);
			return;
		}

		if (data.type === "agent_end") {
			this.agentEndCount++;
			for (const waiter of Array.from(this.endWaiters)) waiter();
		}
		for (const listener of Array.from(this.listeners)) listener(data);
	}

	private respondToExtensionUiRequest(request: any): void {
		if (request.method === "notify" || request.method === "setStatus" || request.method === "setWidget" || request.method === "setTitle" || request.method === "set_editor_text") {
			return;
		}
		if (request.method === "confirm") {
			this.writeRaw({ type: "extension_ui_response", id: request.id, confirmed: false });
			return;
		}
		this.writeRaw({ type: "extension_ui_response", id: request.id, cancelled: true });
	}

	private async send(command: RpcCommandLike, timeoutMs = this.options.commandTimeoutMs ?? 30000): Promise<RpcResponse> {
		if (!this.proc?.stdin || this.closed) throw new Error("Subagent RPC client is not running");
		const id = `subagent_rpc_${++this.nextRequestId}`;
		const fullCommand = { ...command, id };
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for RPC response to ${commandName(command)}. ${this.stderr}`.trim()));
			}, timeoutMs);
			(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
			this.pendingRequests.set(id, { command: commandName(command), resolve, reject, timer });
			this.proc!.stdin.write(serializeJsonLine(fullCommand), (error) => {
				if (!error) return;
				this.pendingRequests.delete(id);
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	private writeRaw(value: unknown): void {
		if (!this.proc?.stdin || this.closed) return;
		this.proc.stdin.write(serializeJsonLine(value));
	}

	private handleClose(code: number, error?: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.exitCode = code;
		const remainingStdout = this.stdoutDecoder.end();
		if (remainingStdout) this.handleStdout(remainingStdout);
		this.stderr += this.stderrDecoder.end();
		if (this.buffer.trim()) {
			const tail = this.buffer;
			this.buffer = "";
			this.handleLine(tail);
		}
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(error ?? new Error(`Subagent RPC process exited with code ${code}. ${this.stderr}`.trim()));
		}
		this.pendingRequests.clear();
		for (const waiter of Array.from(this.exitWaiters)) waiter();
		this.exitWaiters.clear();
		if (!this.stopping) for (const waiter of Array.from(this.endWaiters)) waiter();
	}
}
