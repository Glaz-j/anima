# 栖灵 · Anima

让人格带着记忆，在不同世界中栖居。

Anima 是一个模拟人格运行系统：从聊天记录与角色设定构建人物，让人物拥有各自的记忆、认识和目标，并通过统一接口进入不同的虚拟世界。

## 当前阶段

当前已建立目录骨架和模块边界，并提供独立的 pi-agent-core 调用示例。NPC 服务业务代码和世界适配尚未实现。下一步集中设计 NPC 层。

第一阶段聚焦少量 NPC 的自主行动、交流与记忆延续。角色使用统一的初始身份设定：

> 每个 NPC 知道自己是合成人格，对外声称自己是人类意识上传者，同时起初相信其他居民都是真正的人类上传者。

角色只拥有自己的私有信息。后续认识如何变化，应由它实际获得的信息和经历决定。

## 目录

```text
anima/
├── apps/
│   └── npc-service/       NPC 服务入口与运行调度
├── packages/
│   ├── npc-core/          人格、记忆、关系认知与决策流程
│   ├── pi-runtime/        对 pi 的封装，实现 NPC 的模型运行接口
│   ├── protocol/          NPC 与世界之间的共享数据契约
│   └── bridge/            消息交付、行动领取与结果回执
├── adapters/
│   └── ai-town/           AI Town 适配位置，当前仅预留
├── worlds/                世界实现位置，当前仅预留
├── docs/
│   ├── architecture.md    顶层设计与依赖边界
│   └── npc-next.md        下一步 NPC 层的设计议题
├── data/                  本地人格与记忆数据位置
├── var/                   本地运行日志、临时文件与实验产物位置
├── package.json           私有 npm workspace 配置
└── package-lock.json      固定整个工作区的依赖版本
```

## 核心约定

- NPC 服务拥有人格、私有身份、长期记忆、对他人的认识和当前目标。
- 世界拥有空间、时间、规则、行动执行和实际事件。
- NPC 提交行动意图，世界返回执行结果；收到意图不等于行动已经发生。
- 世界按角色可见范围提供观察，NPC 根据观察形成自己的认识和记忆。
- 长期记忆采用 Anima 自己的数据结构；pi 会话记录属于运行上下文。
- 共享协议独立于 pi、Convex 和具体游戏引擎。

## 工作区

计划采用 TypeScript，使用 npm workspaces 组织模块。`packages/pi-runtime` 声明了 `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-ai`，直接依赖固定为 `0.84.2`，间接依赖由根目录的 `package-lock.json` 固定。

目前仍没有可运行的 NPC 服务；各模块 `src/` 目录以 `.gitkeep` 占位。可运行的教学示例位于 `packages/pi-runtime/examples/`，后续设计确认后再加入服务实现。

### 安装依赖

准备 Node.js **22.19.0 或更新版本**及 npm，然后在本 README 所在目录执行：

```sh
npm ci
```

这条命令安装整个工作区的依赖，包括 pi 的运行库。无需单独安装全局 pi CLI，也无需下载 pi 源码。首次安装需要访问 npm 包仓库。

后续由 `packages/pi-runtime` 在代码中导入 `Agent`，接入 `pi-ai` 的模型调用，并注册 Anima 的 NPC 工具。人格、提示词拼装和长期记忆由 NPC 层管理。模型 API 配置与服务启动方式将在实现 NPC 服务时补充；安装依赖本身不会调用模型。

### 运行 pi 调用示例

```sh
npm run example:pi
```

默认使用预设模型响应，在本地展示 Agent 查询记忆、接收工具结果、输出回复的完整循环。按 [示例说明](packages/pi-runtime/examples/README.md) 配置 `.env` 后，加上 `-- --live` 可使用真实模型 API。该示例独立于未来的 NPC 服务实现。

### 分享代码

提交源码、各模块的 `package.json`、根目录的 `package-lock.json` 和 `.npmrc`。协作者下载后运行同样的 `npm ci`，即可安装锁定的依赖版本。

`node_modules/` 是安装产物，不提交到仓库。个人数据、运行日志与 `.env` 本地配置也已通过 `.gitignore` 排除。共享仓库以 `anima/` 为根目录，现有聊天导出数据保留在相邻目录。

现有导出数据位于 `../humanClone/exports/`，仍保留原位。这里尚未复制、导入或调用模型处理这些数据。

详细边界见 [顶层架构](docs/architecture.md)，下一步见 [NPC 层设计议题](docs/npc-next.md)。
