# pi-agent-core 调用示例

先阅读 `npc.ts` 中的五个步骤：准备记忆、实现工具、创建 Agent、订阅事件、调用 `prompt()`。`demo-model.ts` 单独处理模型配置。

从 Anima 根目录运行，使用已有 npm 依赖和 Node.js，无需额外安装工具：

```powershell
npm run example:pi
```

默认是明确标注的**离线演示**：使用 pi-ai 的 `fauxProvider` 预设两轮模型响应，真正运行 `Agent`、参数校验、记忆工具、结果回传和事件订阅。它没有调用真实大模型，也不会产生模型 API 费用。

第一轮预设调用 `recall_memory`；第二轮从实际工具返回中取出记忆并输出。因此你可以修改 `npc.ts` 中的 `memories` 再运行，观察返回内容变化。离线演示的查询与回复格式预先写定，不会理解自由输入。

## 使用真实模型

在根目录将 `.env.example` 复制为 `.env`，填写：

```dotenv
PI_EXAMPLE_PROVIDER=anthropic
PI_EXAMPLE_MODEL=claude-sonnet-4-6
PI_EXAMPLE_API_KEY=填入你自己的密钥
```

这里的 provider/model 是当前 pi-ai 内置目录中存在的示例组合，可替换为你使用的组合。若使用网关，可额外设置 `PI_EXAMPLE_BASE_URL`，但网关必须兼容所选模型的协议；仅换地址不能转换 API 协议。`.env` 已被 Git 忽略。

然后运行：

```powershell
npm run example:pi -- --live
```

也可以换一句观察：

```powershell
npm run example:pi -- --live '小雨问你：我们约的是哪个时间？'
```

这时由真实模型选择工具参数和生成回复，会使用配置的模型 API。示例每次启动都是新会话，最多 4 轮模型调用，每轮最多 512 个输出 token，60 秒后请求取消。缺少密钥、模型不存在或模型调用失败时会明确报错，不会切换为离线回复。

## 如何读代码

- `systemPrompt`：人格与角色规则，未来由 NPC 层的模板拼装。
- `tools`：注册给 Agent 的工具，`execute()` 是我们写的真实执行函数。
- `streamFn`：把 Agent 的模型请求交给 pi-ai。
- `subscribe()`：接收文字、工具调用和运行过程的事件。
- `prompt()`：启动一次运行；同一 Agent 对象再次调用时可延续它的上下文。
- `state.messages`：本轮累计的会话消息，不等于已经落盘的长期记忆。

示例中的人物与记忆均为虚构，记忆只用数组和关键词匹配演示。回复仅打印到终端，尚未接入行动协议、世界或长期记忆存储。

接口以项目锁定的 pi `0.84.2` 为准。参考 [Agent 官方文档](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md) 和 [pi-ai 官方文档](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)；上游主分支的接口可能更新。
