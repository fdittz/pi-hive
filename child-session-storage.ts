import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getRunShortId, type ChildSessionRef, type SubagentRunRecord } from "./transcript-types.js";

const CHILD_SESSION_KIND = "pi-session-jsonl-v1" as const;

function sha256(data: string): string {
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

export class ChildSessionStorage {
	private readonly agentDir: string;
	private readonly baseDir: string;

	constructor(agentDir = getAgentDir()) {
		this.agentDir = agentDir;
		this.baseDir = path.join(agentDir, "subagent-sessions");
	}

	getSessionKey(sessionFile: string | undefined, cwd: string): string | undefined {
		if (!sessionFile) return undefined;
		const source = path.resolve(sessionFile);
		const basename = sanitizeSegment(path.basename(source, path.extname(source))).slice(0, 80);
		const cwdHash = sha256(path.resolve(cwd)).slice(0, 8);
		const sessionHash = sha256(source).slice(0, 12);
		return `${basename}-${cwdHash}-${sessionHash}`;
	}

	async prepareRunSession(run: SubagentRunRecord, mainSessionFile: string | undefined): Promise<{ ref: ChildSessionRef; path: string } | undefined> {
		const sessionKey = this.getSessionKey(mainSessionFile, run.cwd);
		if (!sessionKey) return undefined;
		const dir = path.join(this.baseDir, sessionKey);
		await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
		const safeRun = sanitizeSegment(`${run.agent}-${getRunShortId(run.id)}-${run.id}`).slice(0, 180);
		const filePath = path.join(dir, `${safeRun}.jsonl`);
		const relativePath = toPortableRelative(path.relative(this.agentDir, filePath));
		return {
			path: filePath,
			ref: {
				kind: CHILD_SESSION_KIND,
				relativePath,
				createdAt: Date.now(),
			},
		};
	}

	resolveRef(ref: ChildSessionRef | undefined): string | undefined {
		if (!ref || ref.kind !== CHILD_SESSION_KIND) return undefined;
		const relative = fromPortableRelative(ref.relativePath);
		const resolved = path.resolve(this.agentDir, relative);
		const base = path.resolve(this.baseDir);
		if (!isInside(base, resolved)) return undefined;
		return resolved;
	}
}
