import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import OpenAI from "openai";
import type { ExtensionAPI, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
// jiti (usado pelo pi para carregar extensões) não resolve subpaths de pacote corretamente.
// Resolvemos o caminho manualmente a partir do módulo principal.
const _require = createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url);
const _piAiMain: string = _require.resolve("@earendil-works/pi-ai");
const _piAiDir = path.dirname(_piAiMain); // .../pi-ai/dist
const { convertMessages } = _require(path.join(_piAiDir, "providers", "openai-completions.js")) as { convertMessages: (model: any, context: any, compat: any) => any[] };
import {
	AssistantMessageEventStream,
	calculateCost,
	clampThinkingLevel,
	parseStreamingJson,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Tool,
} from "@earendil-works/pi-ai";

const PROVIDER_ID = "petrobras-ia-texto";
const PROVIDER_NAME = "Petrobras IA Texto";
const APIM_BASE_URL = "https://apit.petrobras.com.br/ia/texto/v1/litellm/litellm";
const BASE_URL = `${APIM_BASE_URL}/v1`;
const MODELS_URL = `${BASE_URL}/models`;
const PROVIDER_API = "petrobras-ia-texto-openai-completions";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

type PetrobrasModelResponse = {
	object?: string;
	data?: PetrobrasRawModel[];
};

type PetrobrasRawModel = {
	id?: unknown;
	name?: unknown;
	display_name?: unknown;
	object?: unknown;
	created?: unknown;
	owned_by?: unknown;
	contextWindow?: unknown;
	context_window?: unknown;
	max_context_tokens?: unknown;
	max_input_tokens?: unknown;
	maxTokens?: unknown;
	max_tokens?: unknown;
	max_output_tokens?: unknown;
	output_token_limit?: unknown;
	litellm_params?: {
		max_input_tokens?: unknown;
		max_tokens?: unknown;
		max_output_tokens?: unknown;
	};
};

type ModelLimits = {
	contextWindow: number;
	maxTokens: number;
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const STATIC_MODEL_SPECS: PetrobrasRawModel[] = [
	{
		id: "gpt-4o",
		name: "GPT-4o",
		contextWindow: 128_000,
		maxTokens: 16_384,
	},
	{
		id: "gpt-5",
		name: "GPT-5",
		contextWindow: 400_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-sonnet-4-20250514",
		name: "Claude Sonnet 4",
		contextWindow: 200_000,
		maxTokens: 16_384,
	},
];

function asPositiveInteger(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
	return undefined;
}

function prettyName(id: string): string {
	return id
		.split("-")
		.map((part) => {
			if (/^(gpt|o\d|o\d\w*|qwen|kimi|nova|nemo|pb|ia)$/i.test(part)) return part.toUpperCase();
			if (/^v\d+/i.test(part)) return part.toUpperCase();
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(" ");
}

function isChatCompletionModel(id: string): boolean {
	return !/^(dall-e|stable-diffusion|embedding-|text-embedding-|rerank-)/i.test(id);
}

function supportsImageInput(id: string): boolean {
	return (
		/^(gpt-4o|gpt-4\.1|gpt-5|o3|o4-mini)/i.test(id) ||
		/^claude-(v3|v35|3-|sonnet-4|haiku-4|opus-4)/i.test(id) ||
		/^nova-(lite|pro)/i.test(id)
	);
}

function supportsExtendedThinking(id: string): boolean {
	const modelId = id.trim().toLowerCase();
	if (modelId.includes("chat-latest") || modelId.includes("-chat-")) return false;
	return (
		/^gpt-5(?:$|[.-])/i.test(modelId) ||
		/^o3(?:$|[.-])/i.test(modelId) ||
		/^o4-mini(?:$|[.-])/i.test(modelId) ||
		/^claude-(?:3-7|sonnet-4|haiku-4|opus-4)(?:$|[.-])/i.test(modelId)
	);
}

function thinkingLevelMapForModel(id: string): ThinkingLevelMap | undefined {
	if (!supportsExtendedThinking(id)) return undefined;

	const modelId = id.trim().toLowerCase();
	if (/^gpt-5(?:$|[.-])/i.test(modelId)) {
		const map: ThinkingLevelMap = { off: null };
		if (/^gpt-5\.(?:2|3|4|5)(?:$|[.-])/i.test(modelId)) map.xhigh = "xhigh";
		return map;
	}

	if (/^claude-(?:3-7|sonnet-4|haiku-4|opus-4)(?:$|[.-])/i.test(modelId)) {
		return {
			minimal: "low",
			xhigh: "high",
		};
	}

	return undefined;
}

function compatForModel(_id: string, reasoning = false) {
	const base = {
		// Petrobras IA is exposed through LiteLLM/OpenAI-compatible Chat Completions.
		// These conservative flags avoid OpenAI-only payload fields that many gateways reject.
		supportsDeveloperRole: false,
		supportsReasoningEffort: reasoning,
		supportsStore: false,
		supportsStrictMode: false,
		maxTokensField: "max_tokens" as const,
	};

	if (!reasoning) return base;
	return {
		...base,
		thinkingFormat: "openai" as const,
	};
}

function inferLimits(id: string): ModelLimits {
	if (/^gpt-4\.1/i.test(id)) return { contextWindow: 1_047_576, maxTokens: 32_768 };
	if (/^gpt-5/i.test(id)) return { contextWindow: 400_000, maxTokens: 128_000 };
	if (/^(o3|o4-mini)/i.test(id)) return { contextWindow: 200_000, maxTokens: 100_000 };
	if (/^gpt-4o/i.test(id)) return { contextWindow: 128_000, maxTokens: 16_384 };
	if (/^gpt-35-turbo-16k/i.test(id)) return { contextWindow: 16_384, maxTokens: 4_096 };
	if (/^claude-v2\.1/i.test(id)) return { contextWindow: 200_000, maxTokens: 4_096 };
	if (/^claude-(v2|instant)/i.test(id)) return { contextWindow: 100_000, maxTokens: 4_096 };
	if (/^claude-(3-7|sonnet-4|haiku-4|opus-4)/i.test(id)) return { contextWindow: 200_000, maxTokens: 64_000 };
	if (/^claude-/i.test(id)) return { contextWindow: 200_000, maxTokens: 8_192 };
	if (/^kimi-k2\.5/i.test(id)) return { contextWindow: 256_000, maxTokens: 16_384 };
	if (/^qwen3/i.test(id)) return { contextWindow: 262_144, maxTokens: 32_768 };
	if (/^nova-/i.test(id)) return { contextWindow: 300_000, maxTokens: 10_240 };
	if (/^command-r-plus/i.test(id)) return { contextWindow: 128_000, maxTokens: 4_096 };
	if (/^command-r/i.test(id)) return { contextWindow: 128_000, maxTokens: 4_096 };
	if (/^command-/i.test(id)) return { contextWindow: 4_096, maxTokens: 4_096 };
	if (/^(mistral-large|mistral-small)/i.test(id)) return { contextWindow: 128_000, maxTokens: 8_192 };
	if (/^(mistral-7b|mixtral-8x7b)/i.test(id)) return { contextWindow: 32_768, maxTokens: 4_096 };
	return { contextWindow: 128_000, maxTokens: 4_096 };
}

function mapModel(raw: PetrobrasRawModel) {
	const id = String(raw.id);
	const inferred = inferLimits(id);
	const contextWindow =
		asPositiveInteger(raw.contextWindow) ??
		asPositiveInteger(raw.context_window) ??
		asPositiveInteger(raw.max_context_tokens) ??
		asPositiveInteger(raw.max_input_tokens) ??
		asPositiveInteger(raw.litellm_params?.max_input_tokens) ??
		inferred.contextWindow;
	const maxTokens =
		asPositiveInteger(raw.maxTokens) ??
		asPositiveInteger(raw.max_tokens) ??
		asPositiveInteger(raw.max_output_tokens) ??
		asPositiveInteger(raw.output_token_limit) ??
		asPositiveInteger(raw.litellm_params?.max_tokens) ??
		asPositiveInteger(raw.litellm_params?.max_output_tokens) ??
		inferred.maxTokens;
	const explicitName =
		typeof raw.name === "string" && raw.name.trim()
			? raw.name.trim()
			: typeof raw.display_name === "string" && raw.display_name.trim()
				? raw.display_name.trim()
				: undefined;
	const reasoning = supportsExtendedThinking(id);
	const thinkingLevelMap = thinkingLevelMapForModel(id);

	return {
		id,
		name: explicitName ?? prettyName(id),
		reasoning,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: supportsImageInput(id) ? ["text", "image"] : ["text"],
		cost: ZERO_COST,
		contextWindow,
		maxTokens,
		compat: compatForModel(id, reasoning),
	};
}

function buildStaticModels() {
	return STATIC_MODEL_SPECS.map(mapModel);
}

async function fetchModels(apiKey: string): Promise<PetrobrasRawModel[]> {
	const response = await fetch(MODELS_URL, {
		headers: {
			Accept: "application/json",
			"api-key": apiKey,
		},
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`Failed to fetch Petrobras IA models: HTTP ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 500)}` : ""}`,
		);
	}

	const payload = (await response.json()) as PetrobrasModelResponse;
	const models = Array.isArray(payload.data) ? payload.data : [];
	return models.filter((model) => typeof model.id === "string" && model.id.length > 0);
}

async function discoverPetrobrasTextoModels(apiKey: string | undefined) {
	const fallback = buildStaticModels();
	const trimmedApiKey = apiKey?.trim();
	if (!trimmedApiKey) return fallback;

	try {
		const discovered = (await fetchModels(trimmedApiKey))
			.filter((model) => typeof model.id === "string" && isChatCompletionModel(model.id))
			.map(mapModel);
		return discovered.length > 0 ? discovered : fallback;
	} catch {
		return fallback;
	}
}

function normalizeApiKey(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

function readStoredApiKey(): string | undefined {
	try {
		const authPath = path.join(getAgentDir(), "auth.json");
		const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
		const credentials = parsed[PROVIDER_ID];
		if (!credentials || typeof credentials !== "object") return undefined;
		return normalizeApiKey((credentials as { access?: unknown }).access);
	} catch {
		return undefined;
	}
}

function resolveApiKey(): string | undefined {
	return normalizeApiKey(process.env.PETROBRAS_IA_API_KEY) ?? readStoredApiKey();
}

async function oauthLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const apiKey = await callbacks.onPrompt({
		message: "Insira sua chave de API Petrobras IA:",
	});

	if (!apiKey || apiKey.trim().length === 0) {
		throw new Error("API key não pode estar vazia");
	}

	return {
		access: apiKey.trim(),
		refresh: apiKey.trim(),
		expires: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 ano
	};
}

async function oauthRefreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	// A chave não expira, retorna como está
	return credentials;
}

function oauthGetApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}

type PetrobrasStreamOptions = SimpleStreamOptions & Record<string, unknown> & { thinkingLevel?: ThinkingLevel };
type PetrobrasOpenAICompat = ReturnType<typeof getPetrobrasOpenAICompat>;

function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key.toLowerCase()] = value;
	});
	return record;
}

function extractBearerToken(headers: Headers): string | undefined {
	const authorization = headers.get("authorization");
	if (!authorization) return undefined;
	const match = authorization.match(/^\s*Bearer\s+(.+?)\s*$/i);
	const token = match?.[1]?.trim();
	return token && token.length > 0 ? token : undefined;
}

function rewritePetrobrasAuthHeaders(headersInit: HeadersInit | undefined, fallbackApiKey?: string): Headers {
	const headers = new Headers(headersInit);
	const bearerToken = extractBearerToken(headers);
	const apiKey = bearerToken ?? normalizeApiKey(fallbackApiKey);

	if (apiKey) {
		headers.set("api-key", apiKey);
	}
	if (bearerToken) {
		headers.delete("authorization");
	}

	return headers;
}

function createPetrobrasFetch(apiKey: string, delegateFetch: typeof fetch = globalThis.fetch): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const inputHeaders = typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined;
		const mergedHeaders = new Headers(inputHeaders);
		if (init?.headers) {
			new Headers(init.headers).forEach((value, key) => mergedHeaders.set(key, value));
		}
		const headers = rewritePetrobrasAuthHeaders(mergedHeaders, apiKey);
		
		if (process.env.PETROBRAS_IA_TEXTO_DEBUG) {
			console.error(`[${PROVIDER_ID}:fetch-debug] Headers before: ${JSON.stringify(Object.fromEntries(mergedHeaders))}`);
			console.error(`[${PROVIDER_ID}:fetch-debug] Headers after: ${JSON.stringify(Object.fromEntries(headers))}`);
		}
		
		return delegateFetch(input as RequestInfo, {
			...init,
			headers,
		});
	}) as typeof fetch;
}

function createOutputMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function getPetrobrasOpenAICompat(model: Model<any>) {
	const compat = model.compat ?? {};
	return {
		supportsStore: compat.supportsStore ?? false,
		supportsDeveloperRole: compat.supportsDeveloperRole ?? false,
		supportsReasoningEffort: compat.supportsReasoningEffort ?? Boolean(model.reasoning),
		supportsUsageInStreaming: compat.supportsUsageInStreaming ?? true,
		maxTokensField: compat.maxTokensField ?? "max_tokens",
		requiresToolResultName: compat.requiresToolResultName ?? false,
		requiresAssistantAfterToolResult: compat.requiresAssistantAfterToolResult ?? false,
		requiresThinkingAsText: compat.requiresThinkingAsText ?? false,
		requiresReasoningContentOnAssistantMessages: compat.requiresReasoningContentOnAssistantMessages ?? false,
		thinkingFormat: compat.thinkingFormat ?? "openai",
		openRouterRouting: compat.openRouterRouting ?? {},
		vercelGatewayRouting: compat.vercelGatewayRouting ?? {},
		zaiToolStream: compat.zaiToolStream ?? false,
		supportsStrictMode: compat.supportsStrictMode ?? false,
		cacheControlFormat: compat.cacheControlFormat,
		sendSessionAffinityHeaders: compat.sendSessionAffinityHeaders ?? false,
		supportsLongCacheRetention: compat.supportsLongCacheRetention ?? true,
	};
}

function hasToolHistory(messages: Context["messages"]): boolean {
	for (const message of messages) {
		if (message.role === "toolResult") return true;
		if (message.role === "assistant" && message.content.some((block) => block.type === "toolCall")) return true;
	}
	return false;
}

function convertTools(tools: Tool[] | undefined, compat: PetrobrasOpenAICompat): unknown[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(compat.supportsStrictMode !== false ? { strict: false } : {}),
		},
	}));
}

function resolveRequestedThinkingLevel(model: Model<any>, options: PetrobrasStreamOptions = {}): ThinkingLevel | undefined {
	const candidate = options.thinkingLevel ?? options.reasoning;
	if (!candidate) return undefined;
	const clamped = clampThinkingLevel(model, candidate as ThinkingLevel);
	return clamped === "off" ? undefined : clamped;
}

function applyThinkingParams(
	params: Record<string, unknown>,
	model: Model<any>,
	compat: PetrobrasOpenAICompat,
	reasoningEffort: ThinkingLevel | undefined,
): void {
	if (!model.reasoning) return;

	if (compat.thinkingFormat === "qwen" || compat.thinkingFormat === "zai") {
		params.enable_thinking = Boolean(reasoningEffort);
		return;
	}

	if (compat.thinkingFormat === "qwen-chat-template") {
		params.chat_template_kwargs = {
			enable_thinking: Boolean(reasoningEffort),
			preserve_thinking: true,
		};
		return;
	}

	if (compat.thinkingFormat === "deepseek") {
		params.thinking = { type: reasoningEffort ? "enabled" : "disabled" };
		if (reasoningEffort) {
			const mapped = model.thinkingLevelMap?.[reasoningEffort];
			if (mapped !== null) params.reasoning_effort = mapped ?? reasoningEffort;
		}
		return;
	}

	if (compat.thinkingFormat === "openrouter") {
		if (reasoningEffort) {
			const mapped = model.thinkingLevelMap?.[reasoningEffort];
			if (mapped !== null) params.reasoning = { effort: mapped ?? reasoningEffort };
		} else if (model.thinkingLevelMap?.off !== null) {
			params.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		}
		return;
	}

	if (compat.thinkingFormat === "together") {
		params.reasoning = { enabled: Boolean(reasoningEffort) };
		if (reasoningEffort && compat.supportsReasoningEffort) {
			const mapped = model.thinkingLevelMap?.[reasoningEffort];
			if (mapped !== null) params.reasoning_effort = mapped ?? reasoningEffort;
		}
		return;
	}

	if (reasoningEffort && compat.supportsReasoningEffort) {
		const mapped = model.thinkingLevelMap?.[reasoningEffort];
		if (mapped !== null) params.reasoning_effort = mapped ?? reasoningEffort;
		return;
	}

	if (compat.supportsReasoningEffort) {
		const offValue = model.thinkingLevelMap?.off;
		if (typeof offValue === "string") params.reasoning_effort = offValue;
	}
}

function buildPetrobrasChatCompletionParams(
	model: Model<any>,
	context: Context,
	options: PetrobrasStreamOptions = {},
): Record<string, unknown> {
	const compat = getPetrobrasOpenAICompat(model);
	const params: Record<string, unknown> = {
		model: model.id,
		messages: convertMessages(model as Model<"openai-completions">, context, compat as any),
		stream: true,
	};

	if (compat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}
	if (compat.supportsStore) {
		params.store = false;
	}
	if (options.maxTokens !== undefined) {
		params[compat.maxTokensField] = options.maxTokens;
	}
	if (options.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	const tools = convertTools(context.tools, compat);
	if (tools) {
		params.tools = tools;
		if (compat.zaiToolStream) params.tool_stream = true;
	} else if (hasToolHistory(context.messages)) {
		params.tools = [];
	}

	if (options.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	applyThinkingParams(params, model, compat, resolveRequestedThinkingLevel(model, options));
	return params;
}

function createPetrobrasOpenAIClient(model: Model<any>, apiKey: string, headers?: Record<string, string>): OpenAI {
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl || BASE_URL,
		dangerouslyAllowBrowser: true,
		defaultHeaders: {
			...(model.headers ?? {}),
			...(headers ?? {}),
		},
		fetch: createPetrobrasFetch(apiKey),
	});
}

function parseChunkUsage(rawUsage: any, model: Model<any>): AssistantMessage["usage"] {
	const promptTokens = rawUsage?.prompt_tokens || 0;
	const cacheReadTokens = rawUsage?.prompt_tokens_details?.cached_tokens ?? rawUsage?.prompt_cache_hit_tokens ?? 0;
	const cacheWriteTokens = rawUsage?.prompt_tokens_details?.cache_write_tokens || 0;
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const output = rawUsage?.completion_tokens || 0;
	const usage: AssistantMessage["usage"] = {
		input,
		output,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		totalTokens: input + output + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function mapStopReason(reason: string | null | undefined): { stopReason: "stop" | "length" | "toolUse" | "error"; errorMessage?: string } {
	if (reason === null || reason === undefined) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
	}
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		const rawMetadata = (error as any)?.error?.metadata?.raw;
		return rawMetadata ? `${error.message}\n${rawMetadata}` : error.message;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function streamPetrobrasTexto(model: Model<any>, context: Context, options: SimpleStreamOptions = {}): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output = createOutputMessage(model);

		try {
			const apiKey = normalizeApiKey(options.apiKey) ?? resolveApiKey();
			if (!apiKey) {
				throw new Error(`No API key found for ${PROVIDER_ID}. Set PETROBRAS_IA_API_KEY or run /login ${PROVIDER_ID}.`);
			}

			if (process.env.PETROBRAS_IA_TEXTO_DEBUG) {
				console.error(`[${PROVIDER_ID}:debug] API key resolved: ${apiKey.slice(0, 10)}...`);
			}

			const client = createPetrobrasOpenAIClient(model, apiKey, options.headers);
			let params = buildPetrobrasChatCompletionParams(model, context, options as PetrobrasStreamOptions);
			const nextPayload = await options.onPayload?.(params, model);
			if (nextPayload !== undefined) params = nextPayload as Record<string, unknown>;

			const requestOptions: Record<string, unknown> = {
				...(options.signal ? { signal: options.signal } : {}),
				...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
			};

			const { data: openaiStream, response } = await client.chat.completions
				.create(params as any, requestOptions as any)
				.withResponse();
			await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

			stream.push({ type: "start", partial: output });

			let textBlock: any = null;
			let thinkingBlock: any = null;
			let hasFinishReason = false;
			const toolCallBlocksByIndex = new Map<number, any>();
			const toolCallBlocksById = new Map<string, any>();
			const blocks = output.content as any[];
			const getContentIndex = (block: any) => blocks.indexOf(block);

			const finishBlock = (block: any) => {
				const contentIndex = getContentIndex(block);
				if (contentIndex === -1) return;

				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
				} else if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
				} else if (block.type === "toolCall") {
					block.arguments = parseStreamingJson(block.partialArgs);
					delete block.partialArgs;
					delete block.streamIndex;
					stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
				}
			};

			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock);
					stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
				}
				return textBlock;
			};

			const ensureThinkingBlock = (thinkingSignature: string) => {
				if (!thinkingBlock) {
					thinkingBlock = { type: "thinking", thinking: "", thinkingSignature };
					blocks.push(thinkingBlock);
					stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
				}
				return thinkingBlock;
			};

			const ensureToolCallBlock = (toolCall: any) => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				if (!block && toolCall.id) block = toolCallBlocksById.get(toolCall.id);
				if (!block) {
					block = {
						type: "toolCall",
						id: toolCall.id || "",
						name: toolCall.function?.name || "",
						arguments: {},
						partialArgs: "",
						streamIndex,
					};
					if (streamIndex !== undefined) toolCallBlocksByIndex.set(streamIndex, block);
					if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
					blocks.push(block);
					stream.push({ type: "toolcall_start", contentIndex: getContentIndex(block), partial: output });
				}
				if (streamIndex !== undefined && block.streamIndex === undefined) {
					block.streamIndex = streamIndex;
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
				return block;
			};

			for await (const chunk of openaiStream as any) {
				if (!chunk || typeof chunk !== "object") continue;
				output.responseId ||= chunk.id;
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
					output.responseModel ||= chunk.model;
				}
				if (chunk.usage) output.usage = parseChunkUsage(chunk.usage, model);

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;
				if (!chunk.usage && choice.usage) output.usage = parseChunkUsage(choice.usage, model);

				if (choice.finish_reason) {
					const finishReason = mapStopReason(choice.finish_reason);
					output.stopReason = finishReason.stopReason;
					if (finishReason.errorMessage) output.errorMessage = finishReason.errorMessage;
					hasFinishReason = true;
				}

				const delta = choice.delta;
				if (!delta) continue;

				if (typeof delta.content === "string" && delta.content.length > 0) {
					const block = ensureTextBlock();
					block.text += delta.content;
					stream.push({ type: "text_delta", contentIndex: getContentIndex(block), delta: delta.content, partial: output });
				}

				const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
				const reasoningField = reasoningFields.find((field) => typeof delta[field] === "string" && delta[field].length > 0);
				if (reasoningField) {
					const reasoningDelta = delta[reasoningField];
					const block = ensureThinkingBlock(reasoningField);
					block.thinking += reasoningDelta;
					stream.push({ type: "thinking_delta", contentIndex: getContentIndex(block), delta: reasoningDelta, partial: output });
				}

				if (Array.isArray(delta.tool_calls)) {
					for (const toolCall of delta.tool_calls) {
						const block = ensureToolCallBlock(toolCall);
						if (!block.id && toolCall.id) {
							block.id = toolCall.id;
							toolCallBlocksById.set(toolCall.id, block);
						}
						if (!block.name && toolCall.function?.name) block.name = toolCall.function.name;

						const argDelta = toolCall.function?.arguments ?? "";
						if (argDelta) {
							block.partialArgs = (block.partialArgs ?? "") + argDelta;
							block.arguments = parseStreamingJson(block.partialArgs);
						}
						stream.push({ type: "toolcall_delta", contentIndex: getContentIndex(block), delta: argDelta, partial: output });
					}
				}

				if (Array.isArray(delta.reasoning_details)) {
					for (const detail of delta.reasoning_details) {
						if (detail?.type !== "reasoning.encrypted" || !detail.id || !detail.data) continue;
						const matchingToolCall = blocks.find((block) => block.type === "toolCall" && block.id === detail.id);
						if (matchingToolCall) matchingToolCall.thoughtSignature = JSON.stringify(detail);
					}
				}
			}

			for (const block of blocks) finishBlock(block);

			if (options.signal?.aborted || output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}
			if (!hasFinishReason) {
				throw new Error("Stream ended without finish_reason");
			}

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content as any[]) {
				delete block.index;
				delete block.partialArgs;
				delete block.streamIndex;
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export default async function (pi: ExtensionAPI) {
	const models = await discoverPetrobrasTextoModels(resolveApiKey());

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		apiKey: "PETROBRAS_IA_API_KEY", // env var ou auth.json
		api: PROVIDER_API,
		streamSimple: streamPetrobrasTexto,
		models,
		oauth: {
			name: PROVIDER_NAME,
			login: oauthLogin,
			refreshToken: oauthRefreshToken,
			getApiKey: oauthGetApiKey,
		},
	});
}

export const supportsExtendedThinkingForTest = supportsExtendedThinking;
export const thinkingLevelMapForModelForTest = thinkingLevelMapForModel;
export const compatForModelForTest = compatForModel;
export const mapModelForTest = mapModel;
export const discoverPetrobrasTextoModelsForTest = discoverPetrobrasTextoModels;
export const buildStaticModelsForTest = buildStaticModels;
export const buildPetrobrasChatCompletionParamsForTest = buildPetrobrasChatCompletionParams;
export const streamPetrobrasTextoForTest = streamPetrobrasTexto;
export function rewritePetrobrasAuthHeadersForTest(headers: HeadersInit | undefined, fallbackApiKey?: string): Record<string, string> {
	return headersToRecord(rewritePetrobrasAuthHeaders(headers, fallbackApiKey));
}
export const createPetrobrasFetchForTest = createPetrobrasFetch;
