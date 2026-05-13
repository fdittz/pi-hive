import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { applySubagentsLanguageToAgents } from "./subagents-lang.js";

export interface AgentMatch {
	name: string;
	score: number;
	reasoning: string;
	suggestedTask: string;
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values));
}

/**
 * Loads agents with any cached `/subagents-lang` trigger translations applied.
 * The `enabled` option is retained for backward compatibility; configured
 * language triggers are loaded independently so manual `delegate` and automatic
 * delegation use the same metadata.
 */
export async function loadCachedAgentsWithEnglishTriggers(options: {
	cwd?: string;
	scope?: AgentScope;
	enabled?: boolean;
} = {}): Promise<{ agents: AgentConfig[]; translated: boolean }> {
	const agents = discoverAgents(options.cwd ?? process.cwd(), options.scope ?? "user").agents;
	return applySubagentsLanguageToAgents(agents);
}

export function scoreAgents(
	agents: AgentConfig[],
	requestText: string,
	options?: { useEnglishTriggers?: boolean; suggestedTask?: string },
): AgentMatch[] {
	const normalizedRequest = normalizeForMatch(requestText);
	const requestTokens = new Set(tokenizeNormalized(requestText));

	return agents.map((agent) => {
		let score = 0;
		const reasons: string[] = [];

		// 1. Trigger matching (highest weight)
		const triggerSource = uniqueStrings([
			...(agent.triggers ?? []),
			...(options?.useEnglishTriggers ? agent.triggers_en ?? [] : []),
		]);
		const triggerMatches = triggerSource.filter((trigger) => triggerMatchesRequest(normalizedRequest, requestTokens, trigger)).length;
		if (triggerMatches > 0) {
			score += triggerMatches * 3;
			reasons.push(`${triggerMatches} trigger keyword(s) matched`);
		}

		// 2. Examples similarity
		if ((agent.examples?.length ?? 0) > 0) {
			const exampleMatch = agent.examples?.some((example) => similarity(normalizedRequest, normalizeForMatch(example)) > 0.6);
			if (exampleMatch) {
				score += 2;
				reasons.push("matches example use case");
			}
		}

		// 3. Description similarity
		if (agent.description) {
			const descSim = similarity(normalizedRequest, normalizeForMatch(agent.description));
			if (descSim > 0.4) {
				score += descSim * 2;
				reasons.push(`description similarity: ${(descSim * 100).toFixed(0)}%`);
			}
		}

		// 4. When field
		if (agent.when) {
			const whenSim = similarity(normalizedRequest, normalizeForMatch(agent.when));
			if (whenSim > 0.5) {
				score += whenSim;
				reasons.push("when condition matches");
			}
		}

		return {
			name: agent.name,
			score,
			reasoning: reasons.join("; "),
			suggestedTask: options?.suggestedTask ?? requestText,
		};
	});
}

function bestMatch(matches: AgentMatch[]): AgentMatch | null {
	matches.sort((a, b) => b.score - a.score);
	const best = matches[0];
	return best ? { ...best, score: normalizeScore(best.score) } : null;
}

export async function findBestAgent(
	userRequest: string,
	options?: {
		cwd?: string;
		scope?: AgentScope;
		languageAgnostic?: boolean;
		/** Deprecated and intentionally ignored. Runtime LLM translation is not used. */
		client?: unknown;
	},
): Promise<AgentMatch | null> {
	const { agents } = await loadCachedAgentsWithEnglishTriggers({
		cwd: options?.cwd,
		scope: options?.scope,
		enabled: options?.languageAgnostic === true,
	});

	if (agents.length === 0) return null;

	const match = bestMatch(
		scoreAgents(agents, userRequest, {
			useEnglishTriggers: options?.languageAgnostic === true,
			suggestedTask: userRequest,
		}),
	);

	// Always preserve the exact original user request for the task sent to the
	// subagent. Matching/scoring may normalize text, but task content must not.
	return match ? { ...match, suggestedTask: userRequest } : null;
}

function normalizeScore(score: number): number {
	if (score <= 0) return 0;
	return score / (score + 0.5);
}

function normalizeForMatch(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokenizeNormalized(text: string): string[] {
	const normalized = normalizeForMatch(text);
	return normalized ? normalized.split(" ").filter(Boolean) : [];
}

function triggerMatchesRequest(normalizedRequest: string, requestTokens: Set<string>, trigger: string): boolean {
	const normalizedTrigger = normalizeForMatch(trigger);
	if (!normalizedTrigger) return false;

	if (normalizedTrigger.includes(" ")) {
		return normalizedRequest.includes(normalizedTrigger);
	}

	if (containsUnsegmentedScript(normalizedTrigger)) {
		return normalizedRequest.includes(normalizedTrigger);
	}

	if (requestTokens.has(normalizedTrigger)) return true;

	return tokenHasCloseVariant(normalizedTrigger, requestTokens);
}

function containsUnsegmentedScript(text: string): boolean {
	return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(text);
}

function tokenHasCloseVariant(trigger: string, requestTokens: Set<string>): boolean {
	if (trigger.length < 5) return false;

	for (const token of requestTokens) {
		if (token.length < 5) continue;
		if (token.startsWith(trigger) || trigger.startsWith(token)) return true;
		if (similarity(token, trigger) >= 0.82) return true;
	}

	return false;
}

// Levenshtein distance for string similarity. Inputs should already be normalized
// when callers care about accent/case-insensitive matching.
function similarity(s1: string, s2: string): number {
	const longer = s1.length > s2.length ? s1 : s2;
	const shorter = s1.length > s2.length ? s2 : s1;
	if (longer.length === 0) return 1;

	const editDistance = getEditDistance(longer, shorter);
	return (longer.length - editDistance) / longer.length;
}

function getEditDistance(s1: string, s2: string): number {
	const costs: number[] = [];
	for (let i = 0; i <= s1.length; i++) {
		let lastValue = i;
		for (let j = 0; j <= s2.length; j++) {
			if (i === 0) {
				costs[j] = j;
			} else if (j > 0) {
				let newValue = costs[j - 1];
				if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
					newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
				}
				costs[j - 1] = lastValue;
				lastValue = newValue;
			}
		}
		if (i > 0) costs[s2.length] = lastValue;
	}
	return costs[s2.length];
}
