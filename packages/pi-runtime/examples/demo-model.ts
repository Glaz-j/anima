// 把模型配置放在单独的文件里，让 npc.ts 专注展示 Agent 的调用方式。
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export function createDemoModel(live: boolean) {
  if (!live) {
    // 离线模式：模型请求的响应是预设的，Agent 循环和工具执行仍走真实代码。
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("recall_memory", { query: "小雨 约定" })],
        { stopReason: "toolUse" },
      ),
      (context) => {
        // 从实际工具返回中取内容；修改 npc.ts 中的记忆后，演示回复也会变化。
        const result = context.messages.findLast(
          (message) => message.role === "toolResult" && message.toolName === "recall_memory",
        );
        const text = result?.role === "toolResult"
          ? result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
          : "没有找到记忆。";
        return fauxAssistantMessage(fauxText(`我查到的记忆是：${text}`));
      },
    ]);
    return { models, model: faux.getModel(), apiKey: undefined };
  }

  const apiKey = process.env.PI_EXAMPLE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("真实模型模式需要 PI_EXAMPLE_API_KEY。请参考 .env.example 配置 .env。");
  }

  const provider = process.env.PI_EXAMPLE_PROVIDER?.trim() || "anthropic";
  const modelId = process.env.PI_EXAMPLE_MODEL?.trim() || "claude-sonnet-4-6";
  const models = builtinModels();
  const selectedModel = models.getModel(provider, modelId);
  if (!selectedModel) {
    throw new Error(`当前 pi-ai 目录中没有模型 ${provider}/${modelId}，请检查配置。`);
  }

  const baseUrl = process.env.PI_EXAMPLE_BASE_URL?.trim();
  const model = baseUrl ? { ...selectedModel, baseUrl } : selectedModel;
  return { models, model, apiKey };
}
