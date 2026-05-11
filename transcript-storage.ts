import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { gunzip as gunzipCallback, gzip as gzipCallback } from "node:zlib";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { promisify } from "node:util";
import { getRunShortId, type StoredTranscriptEvent, type SubagentRunRecord, type TranscriptPersistResult, type TranscriptSegmentRef, type TranscriptStorageRef } from "./transcript-types.js";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);
const STORAGE_KIND = "gzip-jsonl-v1" as const;

function sha256(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

function sanitizeSegment(value: string): string {
	const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

function toPortableRelative(p: string): string {
	return p.split(path.sep).join("/");
}

function fromPortableRelative(p: string): string {
	return p.split("/").join(path.sep);
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class TranscriptStorage {
	private readonly agentDir: string;
	private readonly baseDir: string;

	constructor(agentDir = getAgentDir()) {
		this.agentDir = agentDir;
		this.baseDir = path.join(agentDir, "subagent-transcripts");
	}

	getSessionKey(sessionFile: string | undefined, cwd: string): string | undefined {
		if (!sessionFile) return undefined;
		const source = path.resolve(sessionFile);
		const basename = sanitizeSegment(path.basename(source, path.extname(source))).slice(0, 80);
		const cwdHash = sha256(path.resolve(cwd)).slice(0, 8);
		const sessionHash = sha256(source).slice(0, 12);
		return `${basename}-${cwdHash}-${sessionHash}`;
	}

	async persistRun(run: SubagentRunRecord, sessionFile: string | undefined): Promise<TranscriptPersistResult> {
		return this.persistRunSegment(run, sessionFile, run.liveEvents, 1);
	}

	async persistRunSegment(
		run: SubagentRunRecord,
		sessionFile: string | undefined,
		events: StoredTranscriptEvent[],
		index: number,
	): Promise<TranscriptPersistResult & { segment?: TranscriptSegmentRef }> {
		try {
			const sessionKey = this.getSessionKey(sessionFile, run.cwd);
			if (!sessionKey) return { error: "Main session file is unavailable; transcript sidecar persistence skipped." };
			if (events.length === 0) return { error: "No transcript events captured; transcript sidecar persistence skipped." };

			const safeRunId = sanitizeSegment(`${run.agent}-${getRunShortId(run.id)}-${run.id}`).slice(0, 180);
			const sessionDir = path.join(this.baseDir, sessionKey, safeRunId);
			await fs.promises.mkdir(sessionDir, { recursive: true, mode: 0o700 });

			const filePath = path.join(sessionDir, `${String(index).padStart(4, "0")}.jsonl.gz`);
			const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
			const jsonl = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
			const uncompressed = Buffer.from(jsonl, "utf8");
			const compressed = await gzip(uncompressed, { level: 9 });
			const digest = sha256(compressed);

			await withFileMutationQueue(filePath, async () => {
				await fs.promises.writeFile(tmpPath, compressed, { mode: 0o600 });
				await fs.promises.rename(tmpPath, filePath);
			});

			const relativePath = toPortableRelative(path.relative(this.agentDir, filePath));
			const segment: TranscriptSegmentRef = {
				kind: STORAGE_KIND,
				index,
				relativePath,
				sha256: digest,
				eventCount: events.length,
				uncompressedBytes: uncompressed.byteLength,
				compressedBytes: compressed.byteLength,
				createdAt: Date.now(),
			};
			return { ref: segment, segment };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	async loadTranscript(ref: TranscriptStorageRef): Promise<StoredTranscriptEvent[] | undefined> {
		try {
			if (ref.kind !== STORAGE_KIND) return undefined;
			const absolutePath = this.resolveRef(ref);
			if (!absolutePath) return undefined;
			const compressed = await fs.promises.readFile(absolutePath);
			if (ref.sha256 && sha256(compressed) !== ref.sha256) return undefined;
			const uncompressed = await gunzip(compressed);
			const lines = uncompressed.toString("utf8").split("\n").filter((line) => line.trim().length > 0);
			const events: StoredTranscriptEvent[] = [];
			for (const line of lines) {
				const parsed = JSON.parse(line);
				if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return undefined;
				events.push(parsed as StoredTranscriptEvent);
			}
			if (ref.eventCount && events.length !== ref.eventCount) return undefined;
			return events;
		} catch {
			return undefined;
		}
	}

	async loadTranscriptSegments(segments: TranscriptSegmentRef[]): Promise<StoredTranscriptEvent[] | undefined> {
		const events: StoredTranscriptEvent[] = [];
		for (const segment of [...segments].sort((a, b) => a.index - b.index)) {
			const loaded = await this.loadTranscript(segment);
			if (!loaded) return undefined;
			events.push(...loaded);
		}
		return events;
	}

	private resolveRef(ref: TranscriptStorageRef): string | undefined {
		const relative = fromPortableRelative(ref.relativePath);
		const resolved = path.resolve(this.agentDir, relative);
		const base = path.resolve(this.baseDir);
		if (!isInside(base, resolved)) return undefined;
		return resolved;
	}
}
