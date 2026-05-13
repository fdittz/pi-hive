import { loadAgents } from "./agents.js";

export interface AgentMatch {
	name: string;
	score: number;
	reasoning: string;
	suggestedTask: string;
}

export async function findBestAgent(userRequest: string): Promise<AgentMatch | null> {
	const agents = await loadAgents();
	if (agents.length === 0) return null;

	const normalizedRequest = userRequest.toLowerCase();
	const matches = agents.map((agent) => {
		let score = 0;
		const reasons: string[] = [];

		// 1. Trigger matching (highest weight)
		const triggerMatches = (agent.triggers ?? []).filter((trigger) =>
			normalizedRequest.includes(trigger.toLowerCase()),
		).length;
		if (triggerMatches > 0) {
			score += triggerMatches * 3;
			reasons.push(`${triggerMatches} trigger keyword(s) matched`);
		}

		// 2. Examples similarity
		if ((agent.examples?.length ?? 0) > 0) {
			const exampleMatch = agent.examples?.some((example) =>
				similarity(normalizedRequest, example.toLowerCase()) > 0.6,
			);
			if (exampleMatch) {
				score += 2;
				reasons.push("matches example use case");
			}
		}

		// 3. Description similarity
		if (agent.description) {
			const descSim = similarity(normalizedRequest, agent.description.toLowerCase());
			if (descSim > 0.4) {
				score += descSim * 2;
				reasons.push(`description similarity: ${(descSim * 100).toFixed(0)}%`);
			}
		}

		// 4. When field
		if (agent.when) {
			const whenSim = similarity(normalizedRequest, agent.when.toLowerCase());
			if (whenSim > 0.5) {
				score += whenSim;
				reasons.push("when condition matches");
			}
		}

		return {
			name: agent.name,
			score,
			reasoning: reasons.join("; "),
			suggestedTask: userRequest,
		};
	});

	// Return sorted by score descending. Always return the top match, even with score 0.
	matches.sort((a, b) => b.score - a.score);
	const best = matches[0];
	return best ? { ...best, score: normalizeScore(best.score) } : null;
}

function normalizeScore(score: number): number {
	if (score <= 0) return 0;
	return score / (score + 0.5);
}

// Levenshtein distance for string similarity
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
