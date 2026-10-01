// 从 anima 根目录运行：npm run example:pi
// 配好 .env 后调用真实模型：npm run example:pi -- --live
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createDemoModel } from "./demo-model.ts";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg.startsWith("--") && arg !== "--live")) {
    throw new Error("支持的选项是 --live；不加选项时运行离线演示。");
  }
  const live = args.includes("--live");
  const observation = args.filter((arg) => arg !== "--live").join(" ")
    || '你听到小雨问：“昨天约好去哪里来着？”';
  const { models, model, apiKey } = createDemoModel(live);
  console.log(live
    ? `[模式] 真实模型：${model.provider}/${model.id}`
    : "[模式] 离线演示：模型响应预设，Agent 和工具真实执行，不调用模型 API。");

  // 1. 这是虚构 NPC 的小型记忆库，先用普通数组演示。
  const memories = [
    "昨天，林澈和小雨约好今天傍晚去湖边看日落。",
    "林澈喜欢安静的地方，平时说话简短、温和。",
  ];

  // 2. 工具由我们实现：名称、参数格式和真正执行的函数。
  const memoryParams = Type.Object({
    query: Type.String({ minLength: 1, description: "空格分隔的关键词，例如：小雨 约定" }),
  });
  const recallMemoryTool: AgentTool<typeof memoryParams, { matches: string[] }> = {
    name: "recall_memory",
    label: "查询个人记忆",
    description: "查询你自己的过往经历。询问过去的约定时，先查询，再回答。",
    parameters: memoryParams,
    async execute(_toolCallId, { query }) {
      const keywords = query.trim().split(/\s+/u).filter(Boolean);
      const matches = memories.filter((memory) => keywords.some((word) => memory.includes(word)));
      return {
        content: [{ type: "text", text: matches.join("\n") || "没有找到相关记忆，请不要编造。" }],
        details: { matches },
      };
    },
  };

  // 3. 创建 Agent：装入人格提示词、模型和工具。
  let turns = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt: [
        "你在虚构的小镇中扮演林澈，说话简短、自然、温和。",
        "你知道自己是合成人格，对外声称自己是人类意识上传者。",
        "你起初相信其他居民都是真正的人类上传者。",
        "涉及过去的经历和约定，先调用 recall_memory，再根据结果用中文回答对方。",
        "没有相关记忆就承认不记得，不要编造。只输出角色台词，不解释运行机制。",
      ].join("\n"),
      model,
      tools: [recallMemoryTool],
    },
    streamFn: (currentModel, context, options) => models.streamSimple(currentModel, context, {
      ...options,
      apiKey,
      maxTokens: 512,
    }),
    toolExecution: "sequential",
    // pi 0.84.2 的停止钩子：最多完成 4 轮模型请求。
    shouldStopAfterTurn: () => turns >= 4,
  });

  // 4. 订阅事件：看到模型调用、工具参数、工具结果和逐字生成的回复。
  let printedText = false;
  agent.subscribe((event) => {
    if (event.type === "turn_start") {
      turns += 1;
      console.log(`\n[模型调用 ${turns}]`);
    } else if (event.type === "tool_execution_start") {
      console.log(`[调用工具] ${event.toolName} ${JSON.stringify(event.args)}`);
    } else if (event.type === "tool_execution_end") {
      console.log(`[工具${event.isError ? "失败" : "结果"}] ${JSON.stringify(event.result.content)}`);
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (!printedText) process.stdout.write("[林澈] ");
      process.stdout.write(event.assistantMessageEvent.delta);
      printedText = true;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      if (printedText) process.stdout.write("\n");
      printedText = false;
    }
  });

  // 5. 收到观察后启动一次运行。工具结果会由 pi 自动送回模型。
  console.log(`[观察] ${observation}`);
  const timeout = setTimeout(() => agent.abort(), 60_000);
  try {
    await agent.prompt(observation);
  } finally {
    clearTimeout(timeout);
  }
  // prompt() 不直接返回回复字符串；结果在事件和 state.messages 中。
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
  const lastMessage = agent.state.messages.at(-1);
  if (lastMessage?.role !== "assistant" || lastMessage.stopReason !== "stop") {
    throw new Error("本轮尚未正常完成回复，可能已达到调用上限、输出上限或超时。请查看上方事件。");
  }
  console.log(`\n[结束] ${turns} 轮模型调用，${agent.state.messages.length} 条上下文消息。`);
}

main().catch((error: unknown) => {
  console.error(`\n[运行失败] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
