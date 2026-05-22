import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageEventStream,
  calculateCost,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type ThinkingLevelMap,
  type Tool,
} from "@earendil-works/pi-ai";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ConverseStreamCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDER_ID = "petrobras-ia-generativos";
const PROVIDER_NAME = "Petrobras IA Generativos";
const API_KEY_ENV = "PETROBRAS_IA_GENERATIVOS_API_KEY";
const AWS_REGION = process.env.PETROBRAS_IA_GENERATIVOS_AWS_REGION ?? "us-east-1";
const APIM_ROOT = "https://apit.petrobras.com.br/ia/generativos/v1/aws-bedrock/request-signer";
const BASE_URL = `${APIM_ROOT}/bedrock-runtime`;
const FOUNDATION_MODELS_URL = `${BASE_URL}/foundation-models`;
const INFERENCE_PROFILES_URL = `${BASE_URL}/inference-profiles`;
const PROVIDER_API = "petrobras-bedrock-converse-stream";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 16_384;
const THINKING_LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type PetrobrasThinkingLevel = ThinkingLevel | "off";
type PetrobrasStreamOptions = SimpleStreamOptions & Record<string, unknown> & { thinkingLevel?: PetrobrasThinkingLevel };
type BedrockThinkingRequestFormat = "adaptive" | "reasoningConfig";

interface BedrockModelSummary {
  modelId: string;
  modelName?: string;
  providerName?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  inferenceTypesSupported?: string[];
  responseStreamingSupported?: boolean;
  converse?: {
    maxTokensMaximum?: number | null;
    /** Bedrock may return boolean/string metadata or the real object shape { embedded?: boolean }. */
    reasoningSupported?: boolean | string | { embedded?: boolean } | Record<string, unknown> | null;
    thinkingLevelMap?: unknown;
    additionalRequestFieldsSchema?: unknown;
  } | null;
  modelLifecycle?: {
    status?: string;
  } | null;
}

interface FoundationModelsResponse {
  modelSummaries?: BedrockModelSummary[];
}

interface InferenceProfileSummary {
  inferenceProfileId: string;
  status?: string;
  models?: Array<{ modelArn?: string }>;
}

interface InferenceProfilesResponse {
  inferenceProfileSummaries?: InferenceProfileSummary[];
}

interface PetrobrasModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  bedrockThinkingFormat?: BedrockThinkingRequestFormat;
  input: ("text" | "image")[];
  inputModalities: string[];
  outputModalities: string[];
  contextWindow: number;
  maxTokens: number;
}

const FALLBACK_MODELS: PetrobrasModelConfig[] = [
  {
    id: "anthropic.claude-3-haiku-20240307-v1:0",
    name: "Anthropic Claude 3 Haiku",
    reasoning: false,
    input: ["text", "image"],
    inputModalities: ["TEXT", "IMAGE"],
    outputModalities: ["TEXT"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "us.anthropic.claude-sonnet-4-6",
    name: "Anthropic Claude Sonnet 4.6",
    reasoning: true,
    bedrockThinkingFormat: "adaptive",
    input: ["text", "image"],
    inputModalities: ["TEXT", "IMAGE"],
    outputModalities: ["TEXT"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "amazon.nova-micro-v1:0",
    name: "Amazon Nova Micro",
    reasoning: false,
    input: ["text"],
    inputModalities: ["TEXT"],
    outputModalities: ["TEXT"],
    contextWindow: 128_000,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
];

let inferenceProfileByFoundationModelId = new Map<string, string>();

function debugEnabled(): boolean {
  const value = process.env.PETROBRAS_IA_GENERATIVOS_DEBUG ?? process.env.PI_DEBUG;
  return typeof value === "string" && /^(1|true|yes|on|debug)$/i.test(value.trim());
}

function debugLog(message: string, details?: Record<string, unknown>): void {
  if (!debugEnabled()) return;
  console.error(`[${PROVIDER_ID}:debug] ${message}${details ? ` ${JSON.stringify(details)}` : ""}`);
}

function resolveStoredApiKey(): string | undefined {
  const fromEnv = process.env[API_KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;

  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  if (!existsSync(authPath)) return undefined;

  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, any>;
    const entry = auth[PROVIDER_ID];
    if (!entry || typeof entry !== "object") return undefined;
    if (typeof entry.key === "string" && entry.key.trim()) return entry.key.trim();
    if (typeof entry.access === "string" && entry.access.trim()) return entry.access.trim();
    if (typeof entry.refresh === "string" && entry.refresh.trim()) return entry.refresh.trim();
  } catch {
    return undefined;
  }

  return undefined;
}

function buildPetrobrasHeaders(serviceName: "bedrock" | "bedrock-runtime", apiKey: string): Record<string, string> {
  // Header contract discovered by inspecting the Python pip package iaaws_lib:
  // iaaws_lib.custom_headers_adder.CustomHeadersAdder adds exactly these keys.
  return {
    "x-ptb-aws-service": serviceName,
    "x-ptb-aws-region": AWS_REGION,
    apikey: apiKey,
  };
}

function buildControlPlaneHeaders(apiKey: string): Record<string, string> {
  // For ListFoundationModels/ListInferenceProfiles the AWS service is the
  // Bedrock control-plane service: "bedrock".
  return buildPetrobrasHeaders("bedrock", apiKey);
}

function buildRuntimeHeaders(apiKey: string, extraHeaders?: Record<string, string>): Record<string, string> {
  return {
    ...extraHeaders,
    ...buildPetrobrasHeaders("bedrock-runtime", apiKey),
  };
}

async function fetchBedrockJson<T>(url: string, apiKey: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: buildControlPlaneHeaders(apiKey),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GET ${url} failed: HTTP ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`);
  }

  return (await response.json()) as T;
}

function mapInputModalities(inputModalities: string[] | undefined): ("text" | "image")[] {
  const normalized = new Set((inputModalities ?? []).map((value) => value.toUpperCase()));
  const input: ("text" | "image")[] = ["text"];
  if (normalized.has("IMAGE")) input.push("image");
  return input;
}

function schemaContainsKey(schema: unknown, keys: readonly string[]): boolean {
  if (!schema) return false;

  if (typeof schema === "string") {
    return keys.some((key) => schema.includes(key));
  }

  if (Array.isArray(schema)) {
    return schema.some((item) => schemaContainsKey(item, keys));
  }

  if (typeof schema !== "object") return false;

  return Object.entries(schema as Record<string, unknown>).some(
    ([key, value]) => keys.includes(key) || schemaContainsKey(value, keys),
  );
}

function schemaContainsReasoningConfig(schema: unknown): boolean {
  return schemaContainsKey(schema, ["reasoningConfig", "reasoning_config"]);
}

function schemaContainsAdaptiveThinking(schema: unknown): boolean {
  return schemaContainsKey(schema, ["thinking"]) && schemaContainsKey(schema, ["output_config", "outputConfig"]);
}

function supportsAdaptiveThinkingModelId(modelId: string): boolean {
  // Newer Claude models in this Petrobras/Bedrock endpoint use Anthropic's
  // adaptive thinking request shape instead of the legacy reasoningConfig shape.
  const normalizedModelId = modelId.replace(/^(?:us|eu|apac)\./, "");
  return [
    "anthropic.claude-sonnet-4-6",
    "anthropic.claude-sonnet-4-5",
    "anthropic.claude-opus-4",
    "anthropic.claude-haiku-4-5",
  ].some((prefix) => normalizedModelId.includes(prefix));
}

function mapReasoningSupported(reasoningSupported: unknown, additionalRequestFieldsSchema?: unknown): boolean {
  const schemaSupportsReasoning = schemaContainsReasoningConfig(additionalRequestFieldsSchema);
  let reasoningEmbedded: boolean | undefined;

  if (typeof reasoningSupported === "boolean") {
    reasoningEmbedded = reasoningSupported;
  } else if (reasoningSupported && typeof reasoningSupported === "object" && !Array.isArray(reasoningSupported)) {
    const objectValue = reasoningSupported as Record<string, unknown>;
    if (typeof objectValue.embedded === "boolean") {
      // Bedrock uses { embedded: boolean } to describe whether reasoning is embedded in responses.
      reasoningEmbedded = objectValue.embedded;
    }
  } else if (typeof reasoningSupported === "string") {
    switch (reasoningSupported.trim().toLowerCase()) {
      case "true":
      case "supported":
      case "yes":
      case "enabled":
        reasoningEmbedded = true;
        break;
      case "false":
      case "unsupported":
      case "no":
      case "disabled":
        reasoningEmbedded = false;
        break;
    }
  }

  if (reasoningEmbedded === true) return true;
  if (schemaSupportsReasoning === true) return true;
  return false;
}

function mapThinkingLevelMap(metadata: unknown): ThinkingLevelMap | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;

  const source = metadata as Record<string, unknown>;
  const mapped: ThinkingLevelMap = {};

  for (const key of THINKING_LEVEL_KEYS) {
    const value = source[key];
    if (typeof value === "string" || value === null) {
      mapped[key] = value;
    }
  }

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function displayName(summary: BedrockModelSummary): string {
  const modelName = summary.modelName ?? summary.modelId;
  return summary.providerName ? `${summary.providerName} ${modelName}` : modelName;
}

function mapFoundationModel(summary: BedrockModelSummary): PetrobrasModelConfig {
  const converse = summary.converse;
  const maxTokens = converse?.maxTokensMaximum;
  const thinkingLevelMap = mapThinkingLevelMap(converse?.thinkingLevelMap);
  const schemaSupportsReasoning = schemaContainsReasoningConfig(converse?.additionalRequestFieldsSchema);
  const schemaSupportsAdaptiveThinking = schemaContainsAdaptiveThinking(converse?.additionalRequestFieldsSchema);
  const knownAdaptiveThinkingModel = supportsAdaptiveThinkingModelId(summary.modelId);
  const reasoningFromMetadata = mapReasoningSupported(converse?.reasoningSupported, converse?.additionalRequestFieldsSchema);
  const bedrockThinkingFormat: BedrockThinkingRequestFormat | undefined =
    schemaSupportsAdaptiveThinking || knownAdaptiveThinkingModel
      ? "adaptive"
      : schemaSupportsReasoning || reasoningFromMetadata
        ? "reasoningConfig"
        : undefined;
  const reasoning = reasoningFromMetadata || bedrockThinkingFormat !== undefined;

  debugLog("mapped Bedrock model reasoning metadata", {
    modelId: summary.modelId,
    reasoning,
    bedrockThinkingFormat,
    reasoningSupportedType: typeof converse?.reasoningSupported,
    reasoningEmbedded:
      converse?.reasoningSupported && typeof converse.reasoningSupported === "object" && !Array.isArray(converse.reasoningSupported)
        ? (converse.reasoningSupported as Record<string, unknown>).embedded
        : undefined,
    schemaSupportsReasoning,
    schemaSupportsAdaptiveThinking,
    knownAdaptiveThinkingModel,
  });

  return {
    id: summary.modelId,
    name: displayName(summary),
    reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(bedrockThinkingFormat ? { bedrockThinkingFormat } : {}),
    input: mapInputModalities(summary.inputModalities),
    inputModalities: summary.inputModalities ?? [],
    outputModalities: summary.outputModalities ?? [],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
  };
}

async function discoverFoundationModels(apiKey: string): Promise<PetrobrasModelConfig[]> {
  const payload = await fetchBedrockJson<FoundationModelsResponse>(FOUNDATION_MODELS_URL, apiKey);
  const summaries = payload.modelSummaries ?? [];
  if (summaries.length === 0) {
    throw new Error("Bedrock returned no modelSummaries");
  }

  return summaries
    .filter((summary) => summary.modelId && (summary.modelLifecycle?.status ?? "ACTIVE") !== "DEPRECATED")
    .map(mapFoundationModel)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function foundationModelIdFromArn(modelArn: string | undefined): string | undefined {
  if (!modelArn) return undefined;
  const marker = "foundation-model/";
  const index = modelArn.indexOf(marker);
  if (index < 0) return undefined;
  return modelArn.slice(index + marker.length);
}

async function discoverInferenceProfiles(apiKey: string): Promise<Map<string, string>> {
  const payload = await fetchBedrockJson<InferenceProfilesResponse>(INFERENCE_PROFILES_URL, apiKey);
  const mappings = new Map<string, string>();

  for (const profile of payload.inferenceProfileSummaries ?? []) {
    if (!profile.inferenceProfileId || profile.status !== "ACTIVE") continue;
    for (const model of profile.models ?? []) {
      const foundationModelId = foundationModelIdFromArn(model.modelArn);
      if (!foundationModelId) continue;

      const current = mappings.get(foundationModelId);
      const candidate = profile.inferenceProfileId;
      if (!current || (candidate.startsWith("us.") && !current.startsWith("us."))) {
        mappings.set(foundationModelId, candidate);
      }
    }
  }

  return mappings;
}

function resolveInvocationModelId(modelId: string): string {
  return inferenceProfileByFoundationModelId.get(modelId) ?? modelId;
}

function addInferenceProfileModelAliases(
  models: PetrobrasModelConfig[],
  profileMappings: Map<string, string>,
): PetrobrasModelConfig[] {
  if (profileMappings.size === 0) return models;

  const modelById = new Map(models.map((model) => [model.id, model]));
  const aliases: PetrobrasModelConfig[] = [];

  for (const [foundationModelId, inferenceProfileId] of profileMappings) {
    if (modelById.has(inferenceProfileId)) continue;

    const foundationModel = modelById.get(foundationModelId);
    if (!foundationModel) continue;

    aliases.push({
      ...foundationModel,
      id: inferenceProfileId,
    });
  }

  if (aliases.length === 0) return models;
  return [...models, ...aliases].sort((a, b) => a.id.localeCompare(b.id));
}

async function oauthLogin(callbacks: any): Promise<any> {
  const apiKey = await callbacks.onPrompt({
    message: "Insira sua chave de API Petrobras IA Generativos:",
  });

  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("API key não pode estar vazia");
  }

  return {
    access: apiKey.trim(),
    refresh: apiKey.trim(),
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
  };
}

async function oauthRefreshToken(credentials: any): Promise<any> {
  return credentials;
}

function oauthGetApiKey(credentials: any): string {
  return credentials.access;
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

function textBlocksFromContent(content: any): any[] {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [];

  return content.flatMap((block) => {
    if (!isRecord(block)) return [];

    if (block.type === "text") {
      return typeof block.text === "string" ? [{ text: block.text }] : [];
    }

    if (block.type === "image") {
      if (typeof block.data !== "string") return [];
      const format = String(block.mimeType ?? "image/png").split("/")[1] ?? "png";
      return [{ image: { format: format === "jpg" ? "jpeg" : format, source: { bytes: Buffer.from(block.data, "base64") } } }];
    }

    return [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findLastAssistantMessage(context: Pick<Context, "messages"> | undefined): AssistantMessage | undefined {
  const messages = context?.messages;
  if (!Array.isArray(messages)) return undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "assistant") return message as AssistantMessage;
  }

  return undefined;
}

function messageContent(message: unknown): unknown[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content;
}

function messageHasToolCalls(message: unknown): boolean {
  return messageContent(message).some((block) => isRecord(block) && block.type === "toolCall");
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function messageHasCompleteThinkingBlock(message: unknown): boolean {
  return messageContent(message).some((block) => {
    if (!isRecord(block) || block.type !== "thinking") return false;

    const hasSignature = hasNonEmptyString(block.thinkingSignature);
    if (block.redacted === true) return hasSignature;

    return hasNonEmptyString(block.thinking) && hasSignature;
  });
}

function additionalModelRequestFieldsEnableThinking(additionalModelRequestFields: unknown): boolean {
  if (!isRecord(additionalModelRequestFields)) return false;

  const thinking = additionalModelRequestFields.thinking;
  if (isRecord(thinking)) {
    const type = thinking.type;
    return type !== "disabled" && type !== "off";
  }

  const reasoningConfig = additionalModelRequestFields.reasoningConfig ?? additionalModelRequestFields.reasoning_config;
  if (isRecord(reasoningConfig)) {
    return reasoningConfig.enabled !== false;
  }

  return false;
}

function shouldDropThinkingForMissingThinkingBlocks(
  context: Pick<Context, "messages"> | undefined,
  additionalModelRequestFields: unknown,
): boolean {
  if (!additionalModelRequestFieldsEnableThinking(additionalModelRequestFields)) return false;

  const lastAssistantMessage = findLastAssistantMessage(context);
  if (!lastAssistantMessage) return false;

  const hasToolCalls = messageHasToolCalls(lastAssistantMessage);
  const hasCompleteThinkingBlock = messageHasCompleteThinkingBlock(lastAssistantMessage);
  const shouldDrop = hasToolCalls && !hasCompleteThinkingBlock;

  if (shouldDrop) {
    debugLog("dropping Bedrock thinking config because the last assistant tool-use message has no complete thinking block", {
      lastAssistantContentBlocks: messageContent(lastAssistantMessage).length,
    });
  }

  return shouldDrop;
}

function thinkingBlockToBedrockReasoningContent(block: unknown): any | undefined {
  if (!isRecord(block) || block.type !== "thinking") return undefined;

  if (block.redacted === true) {
    if (!hasNonEmptyString(block.thinkingSignature)) {
      debugLog("omitted incomplete redacted thinking block from Bedrock replay", { hasSignature: false });
      return undefined;
    }

    return { reasoningContent: { redactedContent: Buffer.from(block.thinkingSignature, "base64") } };
  }

  if (!hasNonEmptyString(block.thinking) || !hasNonEmptyString(block.thinkingSignature)) {
    debugLog("omitted incomplete thinking block from Bedrock replay", {
      hasText: hasNonEmptyString(block.thinking),
      hasSignature: hasNonEmptyString(block.thinkingSignature),
    });
    return undefined;
  }

  return {
    reasoningContent: {
      reasoningText: {
        text: block.thinking,
        signature: block.thinkingSignature,
      },
    },
  };
}

function convertMessages(context: Context): any[] {
  const messages: any[] = [];
  const contextMessages = isRecord(context) && Array.isArray(context.messages) ? context.messages : [];
  let pendingToolResults: any[] = [];

  const flushPendingToolResults = () => {
    if (pendingToolResults.length === 0) return;
    messages.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of contextMessages) {
    if (!isRecord(message)) continue;

    if (message.role === "user") {
      flushPendingToolResults();
      const content = textBlocksFromContent(message.content);
      if (content.length > 0) messages.push({ role: "user", content });
      continue;
    }

    if (message.role === "assistant") {
      flushPendingToolResults();
      if (!Array.isArray(message.content)) continue;

      const content = message.content.flatMap((block: any) => {
        if (!isRecord(block)) return [];

        if (block.type === "text") {
          return typeof block.text === "string" ? [{ text: block.text }] : [];
        }

        if (block.type === "thinking") {
          const reasoningContent = thinkingBlockToBedrockReasoningContent(block);
          if (reasoningContent) {
            debugLog("preserved complete thinking block as Bedrock reasoningContent", {
              redacted: block.redacted === true,
              thinkingLength: typeof block.thinking === "string" ? block.thinking.length : 0,
            });
            return [reasoningContent];
          }
          return [];
        }
        if (block.type === "toolCall") {
          return [{ toolUse: { toolUseId: block.id, name: block.name, input: block.arguments ?? {} } }];
        }
        return [];
      });
      if (content.length > 0) messages.push({ role: "assistant", content });
      continue;
    }

    if (message.role === "toolResult") {
      pendingToolResults.push({
        toolResult: {
          toolUseId: message.toolCallId,
          status: message.isError ? "error" : "success",
          content: textBlocksFromContent(message.content),
        },
      });
      continue;
    }

    flushPendingToolResults();
  }

  flushPendingToolResults();
  return messages;
}

function convertTools(tools: Tool[] | undefined): any | undefined {
  if (!tools || tools.length === 0) return undefined;
  return {
    tools: tools.map((tool) => ({
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: { json: tool.parameters },
      },
    })),
  };
}

function resolveRequestedThinkingLevel(options: SimpleStreamOptions = {}): ThinkingLevel | undefined {
  const extendedOptions = options as PetrobrasStreamOptions;
  const candidate = extendedOptions.thinkingLevel ?? options.reasoning;
  if (candidate === "minimal" || candidate === "low" || candidate === "medium" || candidate === "high" || candidate === "xhigh") {
    return candidate;
  }
  return undefined;
}

function mapThinkingLevelToBudgetToken(model: Pick<Model<any>, "thinkingLevelMap">, level: ThinkingLevel): string | undefined {
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return undefined;
  return typeof mapped === "string" ? mapped : level;
}

function mapThinkingLevelToAdaptiveEffort(model: Pick<Model<any>, "thinkingLevelMap">, level: ThinkingLevel): "low" | "medium" | "high" | undefined {
  if (model.thinkingLevelMap?.[level] === null) return undefined;

  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
      return "high";
  }
}

function resolveBedrockThinkingRequestFormat(
  model: Pick<Model<any>, "id" | "reasoning"> & { bedrockThinkingFormat?: BedrockThinkingRequestFormat },
): BedrockThinkingRequestFormat | undefined {
  if (model.bedrockThinkingFormat) return model.bedrockThinkingFormat;
  if (supportsAdaptiveThinkingModelId(model.id)) return "adaptive";
  if (!model.reasoning) return undefined;
  return "reasoningConfig";
}

function isAdaptiveThinkingActive(
  model: Pick<Model<any>, "id" | "reasoning"> & { bedrockThinkingFormat?: BedrockThinkingRequestFormat },
  options: SimpleStreamOptions = {},
): boolean {
  return resolveBedrockThinkingRequestFormat(model) === "adaptive" && resolveRequestedThinkingLevel(options) !== undefined;
}

function buildAdditionalModelRequestFields(model: Model<any>, options: SimpleStreamOptions = {}): Record<string, unknown> | undefined {
  const thinkingFormat = resolveBedrockThinkingRequestFormat(model);
  if (!thinkingFormat) return undefined;

  const thinkingLevel = resolveRequestedThinkingLevel(options);
  if (!thinkingLevel) return undefined;

  if (thinkingFormat === "adaptive") {
    const effort = mapThinkingLevelToAdaptiveEffort(model, thinkingLevel);
    if (!effort) return undefined;

    const fields = {
      thinking: { type: "adaptive" },
      output_config: { effort },
    };

    debugLog("enabled Bedrock adaptive thinking for stream", {
      modelId: model.id,
      thinkingLevel,
      effort,
    });

    return fields;
  }

  const budgetTokens = mapThinkingLevelToBudgetToken(model, thinkingLevel);
  if (!budgetTokens) return undefined;

  const fields = {
    reasoningConfig: {
      enabled: true,
      budgetTokens,
    },
  };

  debugLog("enabled Bedrock reasoningConfig for stream", {
    modelId: model.id,
    thinkingLevel,
    budgetTokens,
  });

  return fields;
}

const OUTPUT_CONFIG_THINKING_KEYS = new Set(["effort"]);
const REASONING_CONFIG_THINKING_KEYS = new Set(["enabled", "budgetTokens", "budget_tokens"]);

function removeNestedThinkingKeys(
  sanitized: Record<string, unknown>,
  field: "output_config" | "outputConfig" | "reasoningConfig" | "reasoning_config",
  thinkingKeys: ReadonlySet<string>,
  droppedFields: string[],
): void {
  if (!(field in sanitized)) return;

  const value = sanitized[field];
  if (!isRecord(value)) return;

  const remaining = Object.fromEntries(Object.entries(value).filter(([key]) => !thinkingKeys.has(key)));
  if (Object.keys(remaining).length > 0) {
    sanitized[field] = remaining;
    for (const key of Object.keys(value)) {
      if (thinkingKeys.has(key)) droppedFields.push(`${field}.${key}`);
    }
    return;
  }

  delete sanitized[field];
  droppedFields.push(field);
}

function sanitizeAdditionalModelRequestFields(
  additionalModelRequestFields: Record<string, unknown> | undefined,
  context: Pick<Context, "messages"> | undefined,
): Record<string, unknown> | undefined {
  if (!shouldDropThinkingForMissingThinkingBlocks(context, additionalModelRequestFields)) {
    return additionalModelRequestFields;
  }

  if (!isRecord(additionalModelRequestFields)) return undefined;

  const sanitized: Record<string, unknown> = { ...additionalModelRequestFields };
  const droppedFields: string[] = [];

  for (const field of ["thinking", "anthropic_beta"] as const) {
    if (field in sanitized) {
      delete sanitized[field];
      droppedFields.push(field);
    }
  }

  removeNestedThinkingKeys(sanitized, "output_config", OUTPUT_CONFIG_THINKING_KEYS, droppedFields);
  removeNestedThinkingKeys(sanitized, "outputConfig", OUTPUT_CONFIG_THINKING_KEYS, droppedFields);
  removeNestedThinkingKeys(sanitized, "reasoningConfig", REASONING_CONFIG_THINKING_KEYS, droppedFields);
  removeNestedThinkingKeys(sanitized, "reasoning_config", REASONING_CONFIG_THINKING_KEYS, droppedFields);

  debugLog("sanitized Bedrock additionalModelRequestFields", {
    droppedFields,
    remainingFields: Object.keys(sanitized),
  });

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function buildInferenceConfig(model: Model<any>, options: SimpleStreamOptions = {}): NonNullable<ConverseStreamCommandInput["inferenceConfig"]> {
  return {
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(isAdaptiveThinkingActive(model, options)
      ? { temperature: 1 }
      : options.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
  };
}

function parseStreamingJson(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function stringFromBinary(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Buffer.isBuffer(value)) return value.toString("base64");
  return undefined;
}

function extractThinkingPart(value: unknown): { text?: string; signature?: string; redactedContent?: string } | undefined {
  if (typeof value === "string") return { text: value };
  if (!value || typeof value !== "object") return undefined;

  const objectValue = value as Record<string, unknown>;
  const nested = extractThinkingPart(objectValue.reasoningText ?? objectValue.thinkingText);
  const textCandidate = objectValue.text ?? objectValue.thinking ?? objectValue.content;
  const text = typeof textCandidate === "string" ? textCandidate : nested?.text;
  const signatureCandidate = objectValue.signature ?? objectValue.thinkingSignature;
  const signature = typeof signatureCandidate === "string" ? signatureCandidate : nested?.signature;
  const redactedContent = stringFromBinary(objectValue.redactedContent) ?? nested?.redactedContent;

  if (text === undefined && signature === undefined && redactedContent === undefined) return undefined;
  return { text, signature, redactedContent };
}

function extractThinkingDelta(delta: unknown): { text?: string; signature?: string; redactedContent?: string } | undefined {
  if (!delta || typeof delta !== "object") return undefined;
  const objectDelta = delta as Record<string, unknown>;

  for (const key of ["reasoningContent", "reasoning", "thinkingContent"] as const) {
    const thinking = extractThinkingPart(objectDelta[key]);
    if (thinking) return thinking;
  }

  return undefined;
}

function processThinkingDelta(
  event: any,
  thinkingDelta: { text?: string; signature?: string; redactedContent?: string },
  blocks: any[],
  output: AssistantMessage,
  stream: Pick<AssistantMessageEventStream, "push">,
): void {
  const contentBlockIndex = event.contentBlockIndex;
  let thinkingIndex = blocks.findIndex((block: any) => block.index === contentBlockIndex);
  let thinkingBlock: any = blocks[thinkingIndex];

  if (!thinkingBlock) {
    output.content.push({ type: "thinking", thinking: "", thinkingSignature: "", index: contentBlockIndex } as any);
    thinkingIndex = blocks.length - 1;
    thinkingBlock = blocks[thinkingIndex];
    stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
  }

  if (thinkingBlock?.type !== "thinking") return;

  if (thinkingDelta.text) {
    thinkingBlock.thinking += thinkingDelta.text;
    stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: thinkingDelta.text, partial: output });
  }
  if (thinkingDelta.signature) {
    thinkingBlock.thinkingSignature = (thinkingBlock.thinkingSignature ?? "") + thinkingDelta.signature;
  }
  if (thinkingDelta.redactedContent) {
    thinkingBlock.redacted = true;
    thinkingBlock.thinkingSignature = (thinkingBlock.thinkingSignature ?? "") + thinkingDelta.redactedContent;
  }

  debugLog("received Bedrock thinking delta", {
    contentBlockIndex,
    hasText: Boolean(thinkingDelta.text),
    textLength: thinkingDelta.text?.length ?? 0,
    hasSignature: Boolean(thinkingDelta.signature),
    hasRedactedContent: Boolean(thinkingDelta.redactedContent),
  });
}

function processContentBlockDelta(event: any, blocks: any[], output: AssistantMessage, stream: Pick<AssistantMessageEventStream, "push">): void {
  const contentBlockIndex = event.contentBlockIndex;
  const delta = event.delta;
  let index = blocks.findIndex((block: any) => block.index === contentBlockIndex);
  let block: any = blocks[index];

  if (delta?.text !== undefined) {
    if (!block) {
      output.content.push({ type: "text", text: "", index: contentBlockIndex } as any);
      index = blocks.length - 1;
      block = blocks[index];
      stream.push({ type: "text_start", contentIndex: index, partial: output });
    }
    if (block.type === "text") {
      block.text += delta.text;
      stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
    }
    return;
  }

  if (delta?.toolUse && block?.type === "toolCall") {
    block.partialJson = (block.partialJson ?? "") + (delta.toolUse.input ?? "");
    block.arguments = parseStreamingJson(block.partialJson);
    stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input ?? "", partial: output });
    return;
  }

  const thinkingDelta = extractThinkingDelta(delta);
  if (thinkingDelta) {
    processThinkingDelta(event, thinkingDelta, blocks, output, stream);
  }
}

function processContentBlockStop(event: any, blocks: any[], output: AssistantMessage, stream: Pick<AssistantMessageEventStream, "push">): void {
  const index = blocks.findIndex((block: any) => block.index === event.contentBlockIndex);
  const block: any = blocks[index];
  if (!block) return;

  delete block.index;

  if (block.type === "text") {
    stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
  } else if (block.type === "thinking") {
    stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
  } else if (block.type === "toolCall") {
    block.arguments = parseStreamingJson(block.partialJson);
    delete block.partialJson;
    stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
  }
}

function mapStopReason(stopReason: string | undefined): "stop" | "length" | "toolUse" {
  switch (stopReason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "stop";
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const details = (error as any).details;
    return details ? `${error.name}: ${error.message} - ${details}` : `${error.name}: ${error.message}`;
  }
  return String(error);
}

function streamPetrobrasBedrock(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();

  (async () => {
    const output = createOutputMessage(model);
    const apiKey = options.apiKey ?? process.env[API_KEY_ENV];

    try {
      if (!apiKey) {
        throw new Error(`No API key found for ${PROVIDER_ID}. Set ${API_KEY_ENV} or run /login ${PROVIDER_ID}.`);
      }

      const client = new BedrockRuntimeClient({
        region: AWS_REGION,
        endpoint: BASE_URL,
        credentials: { accessKeyId: "petrobras-apim", secretAccessKey: "petrobras-apim" },
        requestHandler: new NodeHttpHandler(),
      });

      client.middlewareStack.add(
        (next) => async (args: any) => {
          args.request.headers = {
            ...args.request.headers,
            ...buildRuntimeHeaders(apiKey, options.headers),
          };
          return next(args);
        },
        { step: "build", name: "petrobrasIaGenerativosHeaders" },
      );

      const convertedMessages = convertMessages(context);
      const additionalModelRequestFields = sanitizeAdditionalModelRequestFields(
        buildAdditionalModelRequestFields(model, options),
        context,
      );
      const commandInput: ConverseStreamCommandInput = {
        modelId: resolveInvocationModelId(model.id),
        messages: convertedMessages,
        system: context.systemPrompt ? [{ text: context.systemPrompt }] : undefined,
        inferenceConfig: buildInferenceConfig(model, options),
        toolConfig: convertTools(context.tools),
        additionalModelRequestFields,
      };

      debugLog("prepared Bedrock ConverseStream payload", {
        modelId: commandInput.modelId,
        messageCount: convertedMessages.length,
        messages: convertedMessages.map((m: any, i: number) => ({
          index: i,
          role: m.role,
          contentCount: m.content?.length || 0,
          types: m.content?.map((c: any) => {
            if (c.type) return c.type;
            if (c.toolUse) return "toolUse";
            if (c.toolResult) return "toolResult";
            if (c.reasoningContent) return "reasoningContent";
            return Object.keys(c)[0];
          }),
          toolUseIds: m.content?.filter((c: any) => c.toolUse)?.map((c: any) => c.toolUse.toolUseId),
          toolResultIds: m.content?.filter((c: any) => c.toolResult)?.map((c: any) => c.toolResult.toolUseId),
        })),
        hasThinking: !!additionalModelRequestFields?.thinking,
        hasReasoningConfig: !!additionalModelRequestFields?.reasoningConfig,
      });

      const nextPayload = await options.onPayload?.(commandInput, model);
      const response = await client.send(
        new ConverseStreamCommand((nextPayload as ConverseStreamCommandInput | undefined) ?? commandInput),
        { abortSignal: options.signal },
      );

      if (response.$metadata.httpStatusCode !== undefined) {
        await options.onResponse?.(
          {
            status: response.$metadata.httpStatusCode,
            headers: response.$metadata.requestId ? { "x-amzn-requestid": response.$metadata.requestId } : {},
          },
          model,
        );
      }

      for await (const item of response.stream ?? []) {
        if (item.messageStart) {
          stream.push({ type: "start", partial: output });
        } else if (item.contentBlockStart?.start?.toolUse) {
          const toolUse = item.contentBlockStart.start.toolUse;
          output.content.push({
            type: "toolCall",
            id: toolUse.toolUseId ?? "",
            name: toolUse.name ?? "",
            arguments: {},
            partialJson: "",
            index: item.contentBlockStart.contentBlockIndex,
          } as any);
          stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
        } else if (item.contentBlockDelta) {
          processContentBlockDelta(item.contentBlockDelta, output.content as any[], output, stream);
        } else if (item.contentBlockStop) {
          processContentBlockStop(item.contentBlockStop, output.content as any[], output, stream);
        } else if (item.messageStop) {
          output.stopReason = mapStopReason(item.messageStop.stopReason);
        } else if (item.metadata?.usage) {
          output.usage.input = item.metadata.usage.inputTokens ?? 0;
          output.usage.output = item.metadata.usage.outputTokens ?? 0;
          output.usage.cacheRead = item.metadata.usage.cacheReadInputTokens ?? 0;
          output.usage.cacheWrite = item.metadata.usage.cacheWriteInputTokens ?? 0;
          output.usage.totalTokens = item.metadata.usage.totalTokens ?? output.usage.input + output.usage.output;
          calculateCost(model, output.usage);
        }
      }

      if (options.signal?.aborted) throw new Error("Request was aborted");
      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content as any[]) {
        delete block.index;
        delete block.partialJson;
      }
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatError(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

function toProviderModel(model: PetrobrasModelConfig) {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(model.bedrockThinkingFormat ? { bedrockThinkingFormat: model.bedrockThinkingFormat } : {}),
    input: model.input,
    cost: ZERO_COST,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export {
  findLastAssistantMessage,
  isRecord,
  messageHasCompleteThinkingBlock,
  messageHasToolCalls,
  sanitizeAdditionalModelRequestFields,
  shouldDropThinkingForMissingThinkingBlocks,
};
export const buildAdditionalModelRequestFieldsForTest = buildAdditionalModelRequestFields;
export const buildInferenceConfigForTest = buildInferenceConfig;
export const convertMessagesForTest = convertMessages;
export const findLastAssistantMessageForTest = findLastAssistantMessage;
export const isRecordForTest = isRecord;
export const messageHasCompleteThinkingBlockForTest = messageHasCompleteThinkingBlock;
export const messageHasToolCallsForTest = messageHasToolCalls;
export const processContentBlockDeltaForTest = processContentBlockDelta;
export const processContentBlockStopForTest = processContentBlockStop;
export const sanitizeAdditionalModelRequestFieldsForTest = sanitizeAdditionalModelRequestFields;
export const shouldDropThinkingForMissingThinkingBlocksForTest = shouldDropThinkingForMissingThinkingBlocks;

export async function discoverPetrobrasModelsForTest(apiKey: string): Promise<PetrobrasModelConfig[]> {
  inferenceProfileByFoundationModelId = await discoverInferenceProfiles(apiKey).catch(() => new Map());
  return addInferenceProfileModelAliases(await discoverFoundationModels(apiKey), inferenceProfileByFoundationModelId);
}

export default async function (pi: ExtensionAPI) {
  const apiKey = resolveStoredApiKey();
  let models = FALLBACK_MODELS;

  if (apiKey) {
    try {
      const [discoveredModels, profileMappings] = await Promise.all([
        discoverFoundationModels(apiKey),
        discoverInferenceProfiles(apiKey).catch(() => new Map<string, string>()),
      ]);
      models = addInferenceProfileModelAliases(discoveredModels, profileMappings);
      inferenceProfileByFoundationModelId = profileMappings;
    } catch (error) {
      debugLog(`Dynamic model discovery failed; using fallback models. ${formatError(error)}`);
    }
  } else {
  }

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    apiKey: API_KEY_ENV,
    api: PROVIDER_API,
    headers: {
      "x-ptb-aws-service": "bedrock-runtime",
      "x-ptb-aws-region": AWS_REGION,
    },
    streamSimple: streamPetrobrasBedrock,
    models: models.map(toProviderModel),
    oauth: {
      name: PROVIDER_NAME,
      login: oauthLogin,
      refreshToken: oauthRefreshToken,
      getApiKey: oauthGetApiKey,
    },
  });
}
