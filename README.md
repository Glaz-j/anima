# 栖灵 · Anima

让人格带着记忆，在不同世界中栖居。

Anima 是一个模拟人格运行系统：从聊天记录与角色设定构建人物，让人物拥有各自的记忆、认识和目标，并通过统一接口进入不同的虚拟世界。

## 当前阶段

当前确定 **Minecraft Java 版作为第一阶段世界**，NPC 的移动、交谈与互动都在这个世界中验证。已有本地服务器、HMCL 客户端、Mineflayer 原生行动、pi-agent-core 工具循环、人格与原作检索、各 NPC 的持久世界记忆和事件调度。本地 CLIProxyAPI 的工具调用已验证；正式的跨世界共享协议与持久交付队列尚未完成。

通过 yourself-skill 方法整理的五份本地角色 skill 已准备好：谢耳朵、电影版福尔摩斯、死侍、吕子乔、胡一菲。独立 skill、pi 教学示例与文字会客室保留作调试和对照。Minecraft 由 NPC 层组装人格、原作材料与自己的新经历，使用适合游戏行动的独立提示模板。

当前端到端目标是四人格完整生存：从随机主世界空手开始，协作获取资源、进入下界和末地，最终击败末影龙。已有 NPC 执行链路，完整流程仍需实测，详见 [生存实验说明](docs/minecraft-survival.md)。

第一阶段聚焦少量 NPC 的自主行动、交流与记忆延续。角色使用统一的初始身份设定：

> 每个 NPC 知道自己是合成人格，对外声称自己是人类意识上传者，同时起初相信其他居民都是真正的人类上传者。

角色只拥有自己的私有信息。后续认识如何变化，应由它实际获得的信息和经历决定。

## 目录

```text
anima/
├── apps/
│   └── npc-service/       文字角色会客室入口
├── packages/
│   ├── npc-core/          人格、记忆、关系认知与决策流程
│   ├── pi-runtime/        对 pi 的封装，实现 NPC 的模型运行接口
│   ├── protocol/          NPC 与世界之间的共享数据契约
│   └── bridge/            NPC 事件合并、唤醒与并发调度
├── adapters/
│   ├── minecraft/         Minecraft 观察、行动与本地实验入口
│   └── ai-town/           历史候选适配位置，当前仅预留
├── worlds/                世界集成说明；本地存档位于 var/minecraft/
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

采用 TypeScript，使用 npm workspaces 组织模块。`packages/pi-runtime` 声明了 `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-ai`，直接依赖固定为 `0.84.2`，间接依赖由根目录的 `package-lock.json` 固定。

`apps/npc-service` 提供本地角色会客室；`npc-core` 管理角色材料、检索、聊天记录与世界记忆，`pi-runtime` 负责模型接口和工具循环。Minecraft 服务入口组装身体执行与 `bridge` 中的调度器；教学示例仍独立保留在 `packages/pi-runtime/examples/`。

### 安装依赖

准备 Node.js **22.19.0 或更新版本**及 npm，然后在本 README 所在目录执行：

```sh
npm ci
```

这条命令安装整个工作区的依赖，包括 pi 的运行库。无需单独安装全局 pi CLI，也无需下载 pi 源码。首次安装需要访问 npm 包仓库。

`packages/pi-runtime` 在代码中导入 `Agent`，接入 `pi-ai` 的模型调用，并注册角色材料检索工具。人格与对话记录在 NPC 层管理；安装依赖本身不会调用模型。

### 直接使用角色 skill

本机生成结果在 `.claude/skills/{sheldon,sherlock,deadpool,lvziqiao,huyifei}/`。每个目录包含组合后的 `SKILL.md`、性格规则 `persona.md`、角色记忆 `self.md`、元数据和材料证据索引。

先读取某个角色的 `SKILL.md`，再按该角色对话即可；不需要启动服务或安装 pi。Claude Code 的 skill 发现机制与其他宿主不同，不应把目录里的名称直接当作所有应用都支持的斜杠命令。当前 Codex 对话可以用“角色名：消息”指定试聊对象。

这五份档案由 Codex 根据已下载的 RoleBench / CPED 材料整理，再调用 yourself-skill 原始文件生成器打包，属于待试聊校正的初稿。文件留在 Git 忽略目录，首次下载仓库不会自带这些本地产物；原始材料仍在 `data/roles/`。

Minecraft 也能复用这些已有档案：先读取 `data/roles/<id>/profile.json`；没有该文件时，从独立 skill 的性格、记忆、元数据和证据索引在内存组装并校验来源。无需为了接入世界重复生成一份人格。干净仓库没有本地 catalogue 时会明确使用自拟起步人格，而非声称已加载完整影视材料。

### 实验性角色会客室

以下是后续可选的运行方式，与直接使用上述 skill 分开。目前只验证了本地组件测试及模型连通性，尚未验证完整浏览器聊天流程。此实验的 `roles:build` 仍生成单独的运行时档案，并非使用独立 skill 的必经步骤。

已有角色材料和档案时，在 Anima 根目录执行：

```powershell
npm run chat
```

打开 <http://127.0.0.1:18790>，选择角色开始聊天。默认只读复用本机 pi 的自定义 API key 配置；也可按照 `.env.example` 设置自己的模型。此功能调用真实模型 API。

首次从源码准备五个人物：

```powershell
npm run roles:prepare
npm run roles:build
npm run chat
```

第一步需要 Python 3.10+ 和网络，只下载并核对公开台词材料；第二步调用模型，从分散抽样的材料生成有来源的人格初稿。原始数据、生成档案与聊天记录均保留在 Git 忽略目录。详细结构、模型配置和验证边界见 [角色会客室说明](apps/npc-service/README.md)。

### 运行 pi 调用示例

```sh
npm run example:pi
```

默认使用预设模型响应，在本地展示 Agent 查询记忆、接收工具结果、输出回复的完整循环。按 [示例说明](packages/pi-runtime/examples/README.md) 配置 `.env` 后，加上 `-- --live` 可使用真实模型 API。该示例独立于未来的 NPC 服务实现。

### Minecraft 本地实验室

`npm run minecraft:up` 默认启动或续跑四人格完整生存世界，打开 <http://127.0.0.1:18791> 查看状态与行动；`npm run minecraft:launcher -- --mode normal` 打开普通客户端实例，通过 `127.0.0.1:25565` 进入同一世界。HMCL 的试玩单人实例是单独的调试入口。首次资源准备、模型配置、API 和实例边界见 [Minecraft 接入说明](adapters/minecraft/README.md)。

`npm run minecraft:survival` 启动独立的随机主世界，让四个人格空手开始普通生存并自主协作。已有世界运行时先用 `npm run minecraft:stop` 关闭旧实例。`minecraft:dragon` 保留为直接进入末地的辅助战斗诊断，不代表完整生存目标。身体动作由 Mineflayer 原生执行；`approach` 接近可见对象时使用 Pathfinder 的纯规划器，未加载其运动控制器。控制页支持四个 NPC 的第三人称实时画面切换，以及「进入游戏」启动本机原生客户端加入同一个世界；浏览器画面是实时世界数据重绘。

本机已配置并验证 EasyCLIProxyAPI 的 pi 工具调用，兼容接口地址为 `http://127.0.0.1:8317/v1`。项目通过 `ANIMA_*` 显式选择接口，未设置时仍读取本机 pi 的原有 provider；协作者需要准备自己的模型配置。示例见 `.env.example`，设计边界见 [世界接入工作说明](docs/world-integration-brief.md)。

### 分享代码

提交源码、各模块的 `package.json`、根目录的 `package-lock.json` 和 `.npmrc`。协作者下载后运行同样的 `npm ci`，即可安装锁定的依赖版本。

`node_modules/` 是安装产物，不提交到仓库。个人数据、运行日志与 `.env` 本地配置也已通过 `.gitignore` 排除。共享仓库以 `anima/` 为根目录，现有聊天导出数据保留在相邻目录。

现有私人聊天导出位于 `../humanClone/exports/`，仍保留原位；由这些材料生成的本地档案和证据放在被 Git 忽略的 `data/` 中，不随项目发布。

公开数据试验已加入 Synthetic-Persona-Chat 的下载和样例适配脚本。它沿用聊天中间格式，原始数据与转换样例保存在 `data/public/`；使用方法、格式映射与局限见 [数据适配说明](docs/datasets/synthetic-persona-chat.md)。

中文影视角色试验提供 CPED 的下载、角色统计和材料整理脚本，已验证吕子乔与苏明玉两份角色包。数据规模、角色候选与复现方法见 [CPED 检查说明](docs/datasets/cped.md)。

详细边界见 [顶层架构](docs/architecture.md)，下一步见 [NPC 层设计议题](docs/npc-next.md)。
