import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export const SIMPLE_AGENT_COLORS = [
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"purple",
	"cyan",
	"orange",
	"gray",
	"grey",
	"white",
] as const;

export const THEME_AGENT_COLORS: ThemeColor[] = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
];

const SIMPLE_COLOR_HEX: Record<string, string> = {
	red: "#ef4444",
	green: "#22c55e",
	yellow: "#eab308",
	blue: "#3b82f6",
	magenta: "#d946ef",
	purple: "#a855f7",
	cyan: "#06b6d4",
	orange: "#f97316",
	gray: "#9ca3af",
	grey: "#9ca3af",
	white: "#ffffff",
};

const THEME_COLOR_SET = new Set<string>(THEME_AGENT_COLORS);

export function normalizeAgentColor(color: string | undefined): string | undefined {
	const trimmed = color?.trim();
	return trimmed ? trimmed : undefined;
}

export function isHexAgentColor(color: string): boolean {
	return /^#[0-9a-fA-F]{6}$/.test(color);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16),
		g: Number.parseInt(hex.slice(3, 5), 16),
		b: Number.parseInt(hex.slice(5, 7), 16),
	};
}

function colorHex(text: string, hex: string): string {
	const { r, g, b } = hexToRgb(hex);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function colorAgentText(theme: Theme, color: string | undefined, text: string, fallback: ThemeColor = "accent"): string {
	const normalized = normalizeAgentColor(color);
	if (!normalized) return theme.fg(fallback, text);
	if (THEME_COLOR_SET.has(normalized)) return theme.fg(normalized as ThemeColor, text);
	const simple = SIMPLE_COLOR_HEX[normalized.toLowerCase()];
	if (simple) return colorHex(text, simple);
	if (isHexAgentColor(normalized)) return colorHex(text, normalized);
	return theme.fg(fallback, text);
}

export function describeSupportedAgentColors(): string[] {
	return [
		`Simple names: ${SIMPLE_AGENT_COLORS.join(", ")}`,
		`Pi theme colors: ${THEME_AGENT_COLORS.join(", ")}`,
		`Hex truecolor: #38bdf8, #f97316, #a78bfa`,
	];
}
