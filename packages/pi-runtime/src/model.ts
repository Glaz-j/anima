import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

// Credentials stay on the server. Reading pi's existing configuration never edits it.
export async function loadModel(options: { modelId?: string } = {}) {
  // An explicit choice is local to this call; concurrent NPCs keep their own model.
  const selectedId = options.modelId?.trim() || process.env.ANIMA_MODEL;
  if (process.env.ANIMA_API_KEY || process.env.PI_EXAMPLE_API_KEY) {
    const apiKey = (process.env.ANIMA_API_KEY || process.env.PI_EXAMPLE_API_KEY)!.trim();
    const provider = process.env.ANIMA_PROVIDER || process.env.PI_EXAMPLE_PROVIDER || "openai";
    const id = selectedId || process.env.PI_EXAMPLE_MODEL;
    if (!id) throw new Error("请在 .env 中填写 ANIMA_MODEL。");
    const baseUrl = process.env.ANIMA_BASE_URL || process.env.PI_EXAMPLE_BASE_URL;
    const models = builtinModels();
    const builtin = models.getModel(provider, id);
    if (builtin && !process.env.ANIMA_API) {
      return { models, model: baseUrl ? { ...builtin, baseUrl } : builtin, apiKey, source: "env" };
    }
    if (!baseUrl) throw new Error("自定义模型需要 ANIMA_BASE_URL。");
    if (process.env.ANIMA_API && process.env.ANIMA_API !== "openai-completions") {
      throw new Error("自定义接口目前支持 openai-completions；内置模型请不设置 ANIMA_API。");
    }
    return customModel(provider, { id, name: id }, { baseUrl }, apiKey, "env");
  }

  const directory = process.env.ANIMA_PI_CONFIG_DIR || join(homedir(), ".pi", "agent");
  let config: any, auth: any;
  try {
    [config, auth] = await Promise.all([
      readFile(join(directory, "models.json"), "utf8").then(JSON.parse),
      readFile(join(directory, "auth.json"), "utf8").then(JSON.parse),
    ]);
  } catch {
    throw new Error("未找到模型配置。请按 .env.example 配置 ANIMA_*，或使用本机 pi 的模型配置。");
  }
  const provider = process.env.ANIMA_PI_PROVIDER || Object.keys(config.providers || {})
    .find((name) => auth[name]?.type === "api_key" && config.providers[name]?.models?.length);
  if (!provider) throw new Error("pi 配置中没有可用的 API key 模型。");
  const definition = config.providers[provider];
  const selected = selectedId
    ? definition?.models?.find((m: any) => m.id === selectedId) || { id: selectedId, name: selectedId }
    : definition?.models?.[0];
  if (!selected || auth[provider]?.type !== "api_key" || !auth[provider]?.key) {
    throw new Error("指定的 pi provider/model 没有可用的 API key 配置。");
  }
  if ((selected.api || definition.api) !== "openai-completions") {
    throw new Error("本地 pi 自定义配置暂只支持 openai-completions；其他协议请使用 .env 内置模型。");
  }
  return customModel(provider, selected, definition, auth[provider].key, "pi-config");
}

function customModel(provider: string, selected: any, definition: any, apiKey: string, source: string) {
  const model: Model<"openai-completions"> = {
    id: selected.id, name: selected.name || selected.id, provider,
    api: "openai-completions", baseUrl: definition.baseUrl,
    reasoning: selected.reasoning ?? false, input: ["text"],
    // Zero costs here mean unknown; the UI never presents these as a price estimate.
    cost: selected.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: selected.contextWindow || 65536, maxTokens: selected.maxTokens || 8192,
    compat: {
      supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
      supportsStrictMode: false, maxTokensField: "max_tokens", ...selected.compat,
    },
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: provider, name: provider, models: [model], baseUrl: model.baseUrl,
    auth: { apiKey: { name: provider, resolve: async () => ({ auth: { apiKey } }) } },
    api: openAICompletionsApi(),
  }));
  return { models, model, apiKey, source };
}

export type ModelRuntime = Awaited<ReturnType<typeof loadModel>>;
