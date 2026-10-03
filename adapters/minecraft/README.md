# Minecraft 本地实验室

原生 Minecraft Java 客户端可以由开源 HMCL 或控制页的「进入游戏」按钮启动；Mineflayer 角色通过本地 HTTP API 进入实际服务器。默认版本 1.21.4，便携 Java 21，无需修改系统 Java 配置。

## 启动

在 Anima 根目录执行。当前安装脚本面向 Windows，需要 Node 22.19+、Python 3.10+，首次准备需要网络和约 1 GB 磁盘空间。启动自主生存前，先按根目录 `.env.example` 配置自己的模型接口。

```powershell
npm ci
npm run minecraft:setup -- --client
python -B -X utf8 scripts/minecraft/launcher.py --prepare --mode normal
npm run minecraft:up
```

打开控制页后，点击「进入游戏」即可用准备好的普通实例连接同一个世界。也可以用 `npm run minecraft:launcher -- --mode normal` 打开 HMCL 并手动启动。独立试玩入口是 `npm run minecraft:launcher -- --mode demo`：选择 `Anima-Demo-1.21.4` 启动，它保留 Minecraft 原生试玩限制，进入的是单人世界。游戏授权与第三方启动器是两件事。

打开 <http://127.0.0.1:18791> 查看四个人格的自主生存。`npm run minecraft:up` 默认启动完整生存；也可用 `npm run minecraft:start` 在前台运行同一模式，按 Ctrl+C 关闭。

也可显式使用 `npm run minecraft:survival`，角色是谢耳朵、福尔摩斯、死侍、胡一菲。它使用独立随机主世界存档、Easy 难度、空背包起点、正常生存规则、NPC 调度和持久记忆；启动前需要配置可用的模型接口。已有其他世界占用端口时，先停止旧服务。完整规则和胜利判定见 [生存实验说明](../../docs/minecraft-survival.md)。

旧双人沙盒需显式设置 `ANIMA_MC_SCENARIO=sandbox`，其中 `LinChe` 和 `XiaoYu` 会收到开局物品，白天固定且不自然刷怪。`npm run minecraft:dragon` 保留为直接进入末地的历史诊断；这两种模式都不计入完整生存结果。命令行 `--survival` / `--dragon` 优先于环境变量，同时指定两者会报错。

```powershell
npm run minecraft:stop
```

关闭 API 会保存并停止它启动的服务器；原生试玩客户端单独关闭。服务在本机后台运行，不会自动设置开机启动。

试玩单人世界与 Bot 的独立服务器是两个世界。另已加入普通本地实例 `Anima-Local-1.21.4`，可用 HMCL 的离线身份 `AnimaObserver` 连接 `127.0.0.1:25565`，与 Bot 进入同一世界。已实际验证原生客户端进服。离线身份不提供游戏授权，要求微软认证的服务器需使用相应正版账号登录。

打开普通实例（先启动本地世界）：

```powershell
npm run minecraft:up
npm run minecraft:launcher -- --mode normal
```

在 HMCL 中点击启动 `Anima-Local-1.21.4`，它会自动连接本地世界。以后不指定 `--mode` 时使用最近准备的实例；显式加 `--mode demo` 可切回试玩。两个实例使用独立游戏目录，库文件和素材通过硬链接复用。

## 观察 NPC 与加入游戏

控制页顶部的四个角色按钮会切换实时第三人称镜头。镜头持续跟随所选角色，可以拖动旋转、滚轮缩放、重置或全屏。画面来自该 NPC 实际加载的区块和实体；浏览器使用 Prismarine Viewer 重绘，不是 Java 客户端的视频流，光照、材质与部分动画可能不同。每次切换创建独立的镜头会话，释放旧页面、订阅和渲染资源，过期状态消息不会覆盖当前选择。前台可见时，画面加载超时或心跳丢失会自动重连最多两次，之后显示手动重试入口；切到后台或滚出屏幕时暂停超时判定，返回后保留镜头并留出恢复时间。已显示的真实地形可继续观察，其余区块在后台逐步补齐。重生或更换维度时重建场景；观察不会操控 NPC，也不会向其记忆提供其他角色的数据。

「进入游戏」会使用现有隔离普通实例的官方客户端资源，直接启动原生窗口并请求连接当前本地服务器，以 `AnimaObserver` 加入。无需经过 HMCL 的第二次启动点击。已有客户端或 HMCL 在运行时不会重复创建窗口；界面区分已启动进程与实际在线。此按钮要求 Windows 和已准备的 `Anima-Local-<version>` 实例，不会自动下载或修改账户。日志在 `var/minecraft/play-client.log`。如果首次尚未准备普通实例，可先执行 `python -B -X utf8 scripts/minecraft/launcher.py --prepare --mode normal`。

玩家可以正常移动、采集、建造和聊天。普通聊天由 16 格内 NPC 听见；`[世界] 消息` 可向所有 NPC 广播。加入是实际参与同一生存世界，玩家行为会影响这个世界。

## API

API 只监听本机，默认端口 18791。启动时随机生成 Bearer token，保存在被 Git 忽略的 `var/minecraft/api-session.json`。不要提交或分享此文件。控制页自动读取本次会话。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/health` | 版本、服务器地址、在线角色数 |
| `GET /api/experience` | 实时画面地址、原生客户端可用状态与玩家在线状态 |
| `POST /api/play/launch` | 启动固定的本地原生客户端，重复请求合并；无任意命令参数 |
| `GET /api/experiment` | 生存进展、场景规则与调度状态 |
| `POST /api/experiment/start` | 四角色准备好后启动自主试炼 |
| `POST /api/experiment/stop` | 停止自主调度，保留世界和角色 |
| `GET /api/bots` | 所有角色的公开状态 |
| `POST /api/bots` | 创建角色：`name`、`persona`、可选 `roleId`，最多 4 个 |
| `GET /api/bots/:name/observe` | 本角色的位置、背包、可见实体、附近方块和近期经历 |
| `POST /api/bots/:name/actions` | 双循环下用于 scan/recipes/say/broadcast；身体动作通过 intent 提交 |
| `GET /api/bots/:name/control` | 身体授权版本、当前目标、技能、进度和实际回执 |
| `POST /api/bots/:name/intent` | 提交 expectedVersion、steps、ttlMs、reactions；202 只表示接收 |
| `POST /api/bots/:name/tasks` | 输入 `instruction`，调用实际模型执行目标 |
| `POST /api/bots/:name/stop` | 锁存停止，撤销目标，等待真实执行器收尾 |
| `POST /api/shutdown` | 保存并关闭本地实验室 |

除 health/session 外，接口需要 `Authorization: Bearer TOKEN`。POST 行动与任务需 `Content-Type: application/json`。

服务默认使用独立双循环（`ANIMA_MC_DUAL_LOOP=false` 可用于旧串行接口诊断）。模型思考与身体技能拥有独立生命周期；授权有期限，版本不匹配的旧计划会被拒绝。提交 intent 前先读取本角色 control.version；steps 最多12步，reactions 显式选择 surface/eat/defend/flee，ttlMs 为1000–300000。相同计划默认只续租、保留进度，明确重做才用 restart=true；人工停止后须用新观察版本并显式 resume=true 恢复。接收回执不是完成证明，要查看匹配版本的技能结果和实际世界状态。详见 [身体控制契约](../../docs/body-controller-contract.md) 与 [技能考场](../../docs/minecraft-skill-exam.md)。

PowerShell 示例不把 token 打印到终端：

```powershell
$mcSession = Get-Content var/minecraft/api-session.json -Raw | ConvertFrom-Json
$mcHeaders = @{ Authorization = 'Bearer ' + $mcSession.token }
Invoke-RestMethod ($mcSession.baseUrl + '/api/bots/Sheldon/observe') -Headers $mcHeaders
Invoke-RestMethod ($mcSession.baseUrl + '/api/bots/Sheldon/tasks') -Method Post `
  -Headers $mcHeaders -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes('{"instruction":"观察附近，然后向福尔摩斯打个招呼。"}'))
```

行动示例（双循环下身体动作放入 `intent.steps`；查询与交谈仍通过 actions）：

```json
{"type":"goto","x":3,"y":-60,"z":0}
{"type":"say","message":"你好，小雨。"}
{"type":"broadcast","message":"我想和大家商量集合地点。"}
{"type":"look","x":3,"y":-59,"z":0}
{"type":"place","x":2,"y":-60,"z":0,"item":"cobblestone"}
{"type":"dig","x":2,"y":-60,"z":0}
{"type":"wait","ms":1000}
{"type":"move","controls":["forward","sprint"],"ms":1000}
{"type":"equip","item":"netherite_sword","destination":"hand"}
{"type":"consume"}
{"type":"attack","entityId":123,"durationMs":1000}
{"type":"shoot","entityId":123}
{"type":"interact","entityId":123}
{"type":"toss","item":"cobblestone","count":1}
{"type":"scan","name":"log","kind":"blocks","maxDistance":24,"count":8}
{"type":"recipes","item":"wooden_pickaxe"}
{"type":"craft","item":"oak_planks","count":4}
{"type":"gather","block":"oak_log","count":3,"maxDistance":16}
{"type":"smelt","input":"raw_iron","fuel":"coal","count":2,"position":{"x":1,"y":64,"z":1}}
{"type":"container","position":{"x":2,"y":64,"z":1},"operation":"list"}
{"type":"sleep","position":{"x":3,"y":64,"z":1}}
{"type":"stop"}
```

示例中的实体 ID 必须替换成当前观察中的 `nearbyEntities[].id`，不能照抄。`consume` 使用已经装备在主手的食物。

`goto` 的目标是角色脚部坐标，目标距离最多 32 格；先用原生移动控制直行，可处理一格跳跃与最多三格的已知安全下降。遇到部分障碍时，会在当前眼位可见的 4 格局部范围内尝试绕行，整个动作限时 12 秒，不加载寻路插件，不自动挖路或垫方块。只有实际在原目的地稳定落地才确认到达；高墙、危险或未知地形仍可能失败。`approach` 接近当前可见的方块（`position` 整数格坐标）或实体（`entityId`），让身体寻找交互站位；`gather` 也用它接近已选中的可见资源。接近动作通过固定版本 Pathfinder 的纯规划器读取 32 格内已加载碰撞几何，原生移动逐段执行，最多 12 秒；不返回完整地图或隐藏目标位置，不自动挖路、垫方块或攻击。实体不可见时停止。挖掘/放置限制在 4.5 格内，等待和直接移动最多 5 秒。采集、合成、熔炼与容器动作最多 45 秒，其余动作最多 15 秒；未完成时保留实际背包增量、已挖块数或熔炉剩余材料。原生近战检查接触距离，弓箭对静止目标做空气阻力与重力补偿。结果的 `status` 是 `completed`、`failed` 或 `cancelled`；操作完成不代表必然获得资源或杀死敌人，需检查具体回执。接口不提供任意游戏指令或代码执行。

## 模型与人格

复用 `packages/pi-runtime/src/model.ts` 的配置：支持 `.env` 的 `ANIMA_*` 变量，或只读复用本机 pi 配置。真实任务会产生模型 API 费用，每次最多 6 个行动、8 轮调用、90 秒。模型的文字回复只显示在控制台；需要在游戏中说话必须实际调用 `say`（16 格本地交谈）或 `broadcast`（主动选择世界频道，正文最多 240 字）。

创建角色时可传入安全的 `roleId`，由 NPC 层加载本地人格、原作事实与证据检索。Minecraft 的 `llm.ts` 负责连接身体与任务锁，pi 循环已移到 `packages/pi-runtime/src/world-agent.ts`。NPC 只读取自己的观察和实际收到的近处交谈、世界频道原话；广播不自动共享坐标、背包或私人记忆，原作关系不会自动变成当前世界关系。

加载优先级是 `data/roles/<id>/profile.json`，其次为已有 `.claude/skills/<id>/` 中的 `persona.md`、`self.md`、`meta.json` 和 `evidence.json`。后者只在内存组装并核对本地材料来源，不复制档案或再次调用生成模型。只有没有整个角色 catalogue 的干净环境才采用四份自拟起步人格；已有档案损坏或来源不符会报错。两种有效本地资料都标记为 `local-profile`。

世界记忆保存在 `data/world-memory/<worldId>/<npcId>/<roleId>.jsonl`，区分观察/回执事实、他人说法和个人计划，支持同一世界进程重启后恢复。新生存世界使用独立命名空间，旧末地经历不会带入。自主模式通过 `packages/bridge/src/npc-scheduler.ts` 合并事件、按空闲周期唤醒四个 NPC，并限制互相聊天造成的连续唤醒。普通沙盒仍主要由操作者提交目标。微信/QQ 原始数据不进入这次公开角色试炼。

本地 EasyCLIProxyAPI 已配置在 `http://127.0.0.1:8317/v1`。要选择它，在项目 `.env` 中设置 `ANIMA_API=openai-completions`、`ANIMA_PROVIDER=easycliproxy`、`ANIMA_MODEL=gpt-6-luna`、`ANIMA_BASE_URL=http://127.0.0.1:8317/v1`，并将代理的本地访问密钥填入 `ANIMA_API_KEY`。这些是显式切换步骤；本说明和 `.env.example` 不会修改实际配置。

2026-10-02 的当前整合已验证通过本地 CLIProxyAPI 执行 pi 工具调用，NPC 人格、原作检索、独立记忆和调度均已接入。四角色从零生存直至屠龙的完整结果仍需实测；模型接口与单项工具成功不能代替完成目标。设计边界见 [整合说明](../../docs/world-integration-brief.md) 和 [生存实验说明](../../docs/minecraft-survival.md)。

## 文件与验证

下载文件、世界存档、模型任务记录都保存在 Git 忽略的 `var/minecraft/`。官方 Mojang 文件校验 SHA-1，Java 与 HMCL 校验 SHA-256。安装脚本不会覆盖世界存档。

```powershell
npm run test:minecraft
npm run test:world
npm run minecraft:smoke
npm run minecraft:smoke -- --live
```

普通 smoke 针对显式设置 `ANIMA_MC_SCENARIO=sandbox` 后启动的 `LinChe` / `XiaoYu` 沙盒，会实际执行进服、移动、邻近聊天、放置与挖块检查；`--live` 额外调用实际模型，回执写入 `var/minecraft/smoke-result.json`。这是带世界副作用的沙盒检查，不用于正在进行的四人格试炼。旧沙盒版本曾通过普通 smoke、真实模型与 HMCL 原生客户端进服测试；当前原生执行改造另由 `test:world` 检查，端到端结果应以这次运行的新回执为准。

当前服务使用 Pathfinder 2.4.5 的纯规划器帮助 `approach` 接近对象、`travel(x,z)` 走向自选水平区域，未加载其运动控制器；移动、停止与碰撞仍通过原生身体执行。`travel` 由身体求落脚高度，最多 32 格、12 秒，不开路垫块，仍可能返回部分移动或无路。网页现在启用只读的第三人称实时观察；实际游玩通过原生 Minecraft 客户端完成。

## 多世界

HMCL 的“各实例独立”可以分开存档和模组。并行启动多个单人世界需要多个独立游戏实例与窗口；不要让两个进程同时写同一个存档。

NPC 实验建议每个世界使用一个独立服务器进程、存档目录和端口。普通沙盒可用 `ANIMA_MC_HOST`（限本机）、`ANIMA_MC_PORT`、`ANIMA_MC_VERSION` 接入已启动的本地世界，`ANIMA_MC_API_PORT` 设置控制台端口。共用只读 Viewer 默认监听 API 端口加一（18792），可用 `ANIMA_MC_VIEWER_PORT` 修改，所有角色共用一个端口，只有打开的镜头订阅数据。末影龙试炼要求由 Anima 管理服务器进程，以便设置实验规则和读取权威胜利结果。当前默认脚本只自动管理一个服务器，多世界管理界面尚未实现。

来源：[HMCL](https://github.com/HMCL-dev/HMCL)、[实例隔离](https://docs.hmcl.net/launcher/isolation.html)、[Mineflayer](https://github.com/PrismarineJS/mineflayer)、[Minecraft 官方试玩](https://www.minecraft.net/en-us/free-trial)。
