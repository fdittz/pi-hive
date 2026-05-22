const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

async function loadProviderModule() {
	return import("../index.ts");
}

function captureProviderRegistration() {
	let registration;
	return {
		pi: {
			registerProvider(id, config) {
				registration = { id, config };
			},
		},
		get registration() {
			return registration;
		},
	};
}

describe("supportsExtendedThinking", () => {
	test("não trata gpt-5-chat-latest como modelo de reasoning", async () => {
		const { supportsExtendedThinkingForTest } = await loadProviderModule();

		assert.equal(supportsExtendedThinkingForTest("gpt-5-chat-latest"), false);
	});

	test("mantém gpt-5-turbo como modelo de reasoning", async () => {
		const { supportsExtendedThinkingForTest } = await loadProviderModule();

		assert.equal(supportsExtendedThinkingForTest("gpt-5-turbo"), true);
	});

	test("reconhece Claude Haiku 4.5 com extended thinking", async () => {
		const { supportsExtendedThinkingForTest } = await loadProviderModule();

		assert.equal(supportsExtendedThinkingForTest("claude-haiku-4-5"), true);
	});

	test("detecta somente famílias conservadoras com extended thinking", async () => {
		const { supportsExtendedThinkingForTest } = await loadProviderModule();

		for (const id of [
			"gpt-5",
			"gpt-5-mini",
			"gpt-5-turbo",
			"gpt-5.2-pro",
			"o3",
			"o3-mini",
			"o4-mini",
			"o4-mini-deep-research",
			"claude-3-7-sonnet",
			"claude-sonnet-4-20250514",
			"claude-opus-4-1",
			"claude-haiku-4-5",
		]) {
			assert.equal(supportsExtendedThinkingForTest(id), true, `${id} deveria suportar thinking`);
		}

		for (const id of [
			"gpt-4o",
			"gpt-5-chat-latest",
			"gpt-35-turbo",
			"claude-3-haiku",
			"claude-3-5-sonnet",
			"embedding-model",
			"text-embedding-3-large",
		]) {
			assert.equal(supportsExtendedThinkingForTest(id), false, `${id} não deveria suportar thinking`);
		}
	});
});

describe("thinkingLevelMapForModel e compatForModel", () => {
	test("mapeia níveis de thinking por família e ajusta compat dinamicamente", async () => {
		const { thinkingLevelMapForModelForTest, compatForModelForTest } = await loadProviderModule();

		assert.deepEqual(thinkingLevelMapForModelForTest("gpt-5"), { off: null });
		assert.deepEqual(thinkingLevelMapForModelForTest("gpt-5.2"), { off: null, xhigh: "xhigh" });
		assert.equal(thinkingLevelMapForModelForTest("o3"), undefined);
		assert.deepEqual(thinkingLevelMapForModelForTest("claude-sonnet-4-20250514"), {
			minimal: "low",
			xhigh: "high",
		});
		assert.deepEqual(thinkingLevelMapForModelForTest("claude-haiku-4-5"), {
			minimal: "low",
			xhigh: "high",
		});
		assert.equal(thinkingLevelMapForModelForTest("gpt-5-chat-latest"), undefined);
		assert.equal(thinkingLevelMapForModelForTest("gpt-4o"), undefined);

		assert.deepEqual(compatForModelForTest("gpt-5", true), {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsStore: false,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "openai",
		});
		assert.deepEqual(compatForModelForTest("gpt-4o", false), {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsStore: false,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
		});
	});
});

describe("mapModel", () => {
	test("marca modelos com thinking e preserva limites/nome da resposta LiteLLM", async () => {
		const { mapModelForTest } = await loadProviderModule();

		const gpt5 = mapModelForTest({
			id: "gpt-5",
			display_name: "GPT Cinco",
			max_context_tokens: "12345",
			litellm_params: { max_tokens: "6789" },
		});
		assert.equal(gpt5.name, "GPT Cinco");
		assert.equal(gpt5.reasoning, true);
		assert.deepEqual(gpt5.thinkingLevelMap, { off: null });
		assert.equal(gpt5.compat.supportsReasoningEffort, true);
		assert.equal(gpt5.compat.thinkingFormat, "openai");
		assert.equal(gpt5.contextWindow, 12345);
		assert.equal(gpt5.maxTokens, 6789);

		const claude = mapModelForTest({ id: "claude-sonnet-4-20250514" });
		assert.equal(claude.reasoning, true);
		assert.deepEqual(claude.thinkingLevelMap, { minimal: "low", xhigh: "high" });
		assert.equal(claude.compat.supportsReasoningEffort, true);

		const nonThinking = mapModelForTest({ id: "gpt-4o" });
		assert.equal(nonThinking.reasoning, false);
		assert.equal(nonThinking.compat.supportsReasoningEffort, false);
		assert.equal(Object.hasOwn(nonThinking, "thinkingLevelMap"), false);
	});
});

describe("descoberta dinâmica e fallback estático", () => {
	test("descobre modelos LiteLLM via fetchModels e filtra rotas não-chat", async (t) => {
		const { discoverPetrobrasTextoModelsForTest } = await loadProviderModule();
		const previousFetch = global.fetch;
		t.after(() => {
			global.fetch = previousFetch;
		});

		global.fetch = async (url, options) => {
			assert.match(String(url), /\/v1\/models$/);
			assert.equal(options.headers["api-key"], "secret-key");
			return {
				ok: true,
				json: async () => ({
					data: [
						{ id: "gpt-5-mini", name: "GPT-5 Mini" },
						{ id: "embedding-model" },
						{ id: "claude-opus-4-1" },
					],
				}),
			};
		};

		const models = await discoverPetrobrasTextoModelsForTest("secret-key");
		assert.deepEqual(
			models.map((model) => model.id),
			["gpt-5-mini", "claude-opus-4-1"],
		);
		assert.equal(models[0].reasoning, true);
		assert.equal(models[1].reasoning, true);
	});

	test("cai para modelos estáticos quando não há chave ou a descoberta falha", async (t) => {
		const { discoverPetrobrasTextoModelsForTest } = await loadProviderModule();
		const previousFetch = global.fetch;
		t.after(() => {
			global.fetch = previousFetch;
		});

		global.fetch = async () => {
			throw new Error("não deveria buscar sem chave");
		};
		const withoutKey = await discoverPetrobrasTextoModelsForTest(undefined);
		assert.ok(withoutKey.some((model) => model.id === "gpt-5"));

		global.fetch = async () => ({
			ok: false,
			status: 500,
			statusText: "Erro",
			text: async () => "falha",
		});
		const fallback = await discoverPetrobrasTextoModelsForTest("secret-key");
		assert.ok(fallback.some((model) => model.id === "gpt-5"));
		assert.ok(fallback.some((model) => model.id === "claude-sonnet-4-20250514"));
	});
});

describe("modelos estáticos registrados", () => {
	test("registra fallback estático com reasoning/compat consistentes", async (t) => {
		const provider = await loadProviderModule();
		const capture = captureProviderRegistration();
		const previousApiKey = process.env.PETROBRAS_IA_API_KEY;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousFetch = global.fetch;
		delete process.env.PETROBRAS_IA_API_KEY;
		process.env.PI_CODING_AGENT_DIR = "/tmp/petrobras-provider-test-empty-agent-dir";
		global.fetch = async () => {
			throw new Error("não deveria buscar sem chave");
		};
		t.after(() => {
			if (previousApiKey === undefined) delete process.env.PETROBRAS_IA_API_KEY;
			else process.env.PETROBRAS_IA_API_KEY = previousApiKey;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			global.fetch = previousFetch;
		});

		await provider.default(capture.pi);

		assert.equal(capture.registration.id, "petrobras-ia-texto");
		const models = capture.registration.config.models;
		const gpt4o = models.find((model) => model.id === "gpt-4o");
		const gpt5 = models.find((model) => model.id === "gpt-5");
		const claude = models.find((model) => model.id === "claude-sonnet-4-20250514");

		assert.equal(gpt4o.reasoning, false);
		assert.equal(gpt5.reasoning, true);
		assert.equal(claude.reasoning, true);
		for (const model of models) {
			assert.equal(model.compat.supportsReasoningEffort, model.reasoning);
			assert.equal(model.compat.maxTokensField, "max_tokens");
		}
	});

	test("registra streamSimple próprio sem depender de openai-completions", async (t) => {
		const provider = await loadProviderModule();
		const capture = captureProviderRegistration();
		const previousApiKey = process.env.PETROBRAS_IA_API_KEY;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousFetch = global.fetch;
		delete process.env.PETROBRAS_IA_API_KEY;
		process.env.PI_CODING_AGENT_DIR = "/tmp/petrobras-provider-test-empty-agent-dir";
		global.fetch = async () => {
			throw new Error("não deveria buscar sem chave");
		};
		t.after(() => {
			if (previousApiKey === undefined) delete process.env.PETROBRAS_IA_API_KEY;
			else process.env.PETROBRAS_IA_API_KEY = previousApiKey;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			global.fetch = previousFetch;
		});

		await provider.default(capture.pi);

		assert.equal(capture.registration.config.apiKey, "PETROBRAS_IA_API_KEY");
		assert.equal(capture.registration.config.oauth.name, "Petrobras IA Texto");
		assert.equal(typeof capture.registration.config.streamSimple, "function");
		assert.notEqual(capture.registration.config.api, "openai-completions");
	});
});

describe("headers Petrobras IA Texto", () => {
	test("converte Authorization Bearer em api-key e remove Authorization", async () => {
		const { rewritePetrobrasAuthHeadersForTest } = await loadProviderModule();

		const headers = rewritePetrobrasAuthHeadersForTest(
			{
				Authorization: "Bearer request-key",
				"api-key": "stale-key",
				Accept: "application/json",
			},
			"fallback-key",
		);

		assert.equal(headers["api-key"], "request-key");
		assert.equal(headers.accept, "application/json");
		assert.equal(Object.hasOwn(headers, "authorization"), false);
	});

	test("fetch customizado garante api-key antes de enviar request", async () => {
		const { createPetrobrasFetchForTest } = await loadProviderModule();
		let sentHeaders;
		const wrappedFetch = createPetrobrasFetchForTest("fallback-key", async (_url, init) => {
			sentHeaders = Object.fromEntries(new Headers(init.headers).entries());
			return new Response("{}", { status: 200 });
		});

		await wrappedFetch("https://example.invalid/v1/chat/completions", {
			headers: new Headers({ Authorization: "Bearer sdk-key" }),
		});

		assert.equal(sentHeaders["api-key"], "sdk-key");
		assert.equal(Object.hasOwn(sentHeaders, "authorization"), false);
	});
});
