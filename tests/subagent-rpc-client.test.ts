import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

type WriteCallback = (error?: Error | null) => void;

class FakeStdin extends EventEmitter {
	destroyed = false;
	writableEnded = false;
	writable = true;
	writes = 0;

	write(_chunk: string, callback?: WriteCallback): boolean {
		this.writes++;
		const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
		queueMicrotask(() => {
			callback?.(error);
			this.emit("error", error);
		});
		return false;
	}

	closeInput(): void {
		this.destroyed = true;
		this.writable = false;
		this.emit("close");
	}
}

class FakeProcess extends EventEmitter {
	stdin = new FakeStdin();
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killedWith: NodeJS.Signals | undefined;

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killedWith = signal;
		queueMicrotask(() => this.emit("close", signal === "SIGKILL" ? null : 0, signal));
		return true;
	}
}

const spawnedProcesses: FakeProcess[] = [];

mock.module("node:child_process", () => ({
	spawn: () => {
		const proc = new FakeProcess();
		spawnedProcesses.push(proc);
		return proc;
	},
}));

const { SubagentRpcClient } = await import("../subagent-rpc-client.js");

function captureUncaughtExceptions(): { errors: Error[]; stop: () => void } {
	const errors: Error[] = [];
	const handler = (error: Error) => {
		errors.push(error);
	};
	process.on("uncaughtException", handler);
	return {
		errors,
		stop: () => process.off("uncaughtException", handler),
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createClient(): InstanceType<typeof SubagentRpcClient> {
	return new SubagentRpcClient({
		args: [],
		cwd: process.cwd(),
		commandTimeoutMs: 1000,
	});
}

describe("SubagentRpcClient stdin failure handling", () => {
	test("rejects RPC writes when stdin emits EPIPE without an uncaught exception", async () => {
		const uncaught = captureUncaughtExceptions();
		const client = createClient();
		try {
			await client.start();
			await expect(client.abort()).rejects.toThrow(/stdin|EPIPE|pipe|stream/i);
			await delay(0);
			expect(uncaught.errors).toHaveLength(0);
		} finally {
			uncaught.stop();
			client.kill("SIGKILL");
			await client.waitForExit().catch(() => undefined);
		}
	});

	test("ignores raw writes when stdin emits EPIPE without an uncaught exception", async () => {
		const uncaught = captureUncaughtExceptions();
		const client = createClient();
		try {
			await client.start();
			(client as unknown as { writeRaw(value: unknown): void }).writeRaw({ type: "extension_ui_response", id: "test", cancelled: true });
			await delay(0);
			expect(uncaught.errors).toHaveLength(0);
		} finally {
			uncaught.stop();
			client.kill("SIGKILL");
			await client.waitForExit().catch(() => undefined);
		}
	});

	test("fails fast without writing after stdin has already closed", async () => {
		const client = createClient();
		try {
			await client.start();
			const proc = spawnedProcesses.at(-1)!;
			proc.stdin.closeInput();

			await expect(client.abort()).rejects.toThrow(/stdin|RPC client/i);
			expect(proc.stdin.writes).toBe(0);
		} finally {
			client.kill("SIGKILL");
			await client.waitForExit().catch(() => undefined);
		}
	});
});
