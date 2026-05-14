import { execFileSync } from "node:child_process";
import type {
	AgentSession,
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";

/**
 * Host data SubagentOverlay needs to render the same footer used by the main pi chat.
 * Keep this adapter narrow so the overlay does not depend on pi internals.
 */
export interface SubagentOverlayHostContext {
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager" | "modelRegistry" | "model" | "getContextUsage">;
	pi: Pick<ExtensionAPI, "getThinkingLevel">;
	footerData?: ReadonlyFooterDataProvider;
}

export function createFooterSessionAdapter(host: SubagentOverlayHostContext): AgentSession {
	return {
		get state() {
			return {
				model: host.ctx.model,
				thinkingLevel: host.pi.getThinkingLevel(),
			};
		},
		sessionManager: host.ctx.sessionManager,
		modelRegistry: host.ctx.modelRegistry,
		getContextUsage: () => host.ctx.getContextUsage(),
	} as unknown as AgentSession;
}

export function createFooterDataAdapter(host: SubagentOverlayHostContext): ReadonlyFooterDataProvider {
	if (host.footerData) return host.footerData;

	let cachedBranch: string | null | undefined;
	const statuses = new Map<string, string>();

	return {
		getGitBranch(): string | null {
			cachedBranch ??= readGitBranch(host.ctx.cwd);
			return cachedBranch;
		},
		getExtensionStatuses(): ReadonlyMap<string, string> {
			return statuses;
		},
		getAvailableProviderCount(): number {
			return countAvailableProviders(host.ctx.modelRegistry);
		},
		onBranchChange(): () => void {
			// Extension UI does not expose pi's internal footer data provider here.
			// Keep the method for FooterComponent compatibility; branch is refreshed on reopen.
			return () => undefined;
		},
	};
}

function countAvailableProviders(modelRegistry: ExtensionContext["modelRegistry"]): number {
	try {
		return new Set(modelRegistry.getAvailable().map((model) => model.provider)).size;
	} catch {
		return 1;
	}
}

function readGitBranch(cwd: string): string | null {
	try {
		const branch = execFileSync("git", ["branch", "--show-current"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 500,
		}).trim();
		if (branch) return branch;

		const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 500,
		}).trim();
		return head ? "detached" : null;
	} catch {
		return null;
	}
}
