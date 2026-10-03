# 生存建造与建筑考试

本轮在现有双循环身体系统中增加 `build` 持续技能。人格大脑选择建筑、工地、材料与行为策略；施工器负责有限蓝图内的正常移动、逐块放置、分片续建与真实结果确认。不能用一次授权接收代表建筑完成。

## 建筑与接口

目前提供村庄小屋、景观护栏桥、庭院围墙、瞭望塔、开放工坊、花园凉亭六种结构。每种支持 oak/spruce 两种材料组合、0/90/180/270 度旋转。高处施工通过蓝图中的永久维护阶梯、已有结构与正常跳跃完成，不使用传送或创造模式。

大脑先通过 `construction_plan` 查询材料、范围和通路。它只提供公共蓝图知识，`terrainVerified=false`、`inventoryVerified=false` 明确要求大脑自己观察工地并核实库存。材料不足可采集、合成、补给后继续；施工不会自动拆除冲突方块。

```json
{"blueprint":"village-house","origin":{"x":0,"y":64,"z":0},"rotation":0,"palette":"oak"}
```

准备好之后用 `body_plan` 提交，例如以下步骤；expectedVersion 必须来自真实身体状态。

```json
{"type":"build","blueprint":"village-house","origin":{"x":0,"y":64,"z":0},"rotation":0,"palette":"oak","batchBlocks":12}
```

`origin` 是地基方块坐标，不是人物脚部坐标。一次时间片最多放置 12 块，完整目标最多 512 块，施工水平半径为 24 格。普通授权仍有版本、有效期、撤销、死亡和反应接管约束。中断后从真实已加载方块恢复，匹配的目标方块不会重复消耗。完整结构及保留的室内、门洞必须满足条件才 `reached=true`；缺料、冲突或无法到达应返回部分进度和失败原因。

## 独立考场

```powershell
npm run minecraft:exam -- serve
npm run minecraft:build-exam -- list
npm run minecraft:build-exam -- run --task build-village-house-oak-01 --mode skill
npm run minecraft:build-exam -- run --task all --mode skill
npm run minecraft:build-exam -- run --task build-village-house-oak-01 --mode agent
npm run test:build
```

只允许已标记的独立服务 25575/25585。考试不改造正式世界；同一考场任务串行执行，不能同时启动两名考生。14 道题包括六种建筑的原方向 oak 与旋转90度 spruce，以及两道九格水沟桥梁题。水沟侧岸离桥面较远，施工必须利用岸边和已建桥面延伸。它们是单独的 stage 2 建筑套件，不改变已有十道基础生存题的门槛。

考前清理场地并给考生精确、有限的生存材料。正式计时后裁判只读服务器状态，逐个检验目标方块、保留空气格及最终材料消耗。结果写在忽略目录 `var/minecraft/build-exam/<runId>/`，保存公开题目、执行版本、服务器判据、覆盖率、库存和身体回执。`skill` 模式测试施工器；`agent` 模式测试 pi 规划到施工的完整链路，两者成绩必须分开报告。

2026-10-04 本地实测，Minecraft 1.21.4：14 种条件均有真实服务器通过记录，目标方块覆盖率 100%、通道未堵、材料消耗与清单一致。村屋、护栏桥、围墙和水沟桥梁另用真实 pi＋`gpt-6-luna` 完成，实际调用了 `construction_plan` 和 `body_plan`：

| Agent 任务 | 方块数 | 用时 | 验收 |
| --- | ---: | ---: | --- |
| oak 村屋 | 229 | 114 秒 | 通过 |
| oak 护栏桥 | 49 | 63 秒 | 通过 |
| oak 庭院围墙 | 164 | 176 秒 | 通过 |
| oak 九格水沟桥 | 49 | 78 秒 | 通过 |

其余条件在 `skill` 模式验证；不能把施工器的成绩算成模型规划成绩。以上为单次运行结果，不是长期成功率。375 项相关回归通过；最终门洞完成标记和入口站位修正另通过 167 项相关检查，考试的目标方块和保留空气格没有变化。

当前考试主要验证规定结构的可执行性；复杂自然河谷、地形整平、建筑审美和自由设计能力仍需扩展测试。水沟题是已知、有限的人工考场，不代表任意地形均可施工。固定蓝图通过不等于能够自由生成任意建筑，也不等于实际 NPC 已自主决定在正式世界建造。

## 设计参考

[MineAnyBuild](https://github.com/MineAnyBuild/MineAnyBuild) 将建筑规划与可执行的空间结构联系起来；[APT](https://github.com/spearsheep/APT-Architectural-Planning-LLM-Agent) 提供建筑规划 agent 的参考。本实现使用自己的有限蓝图和 Mineflayer 身体接口，没有复现这些项目的完整模型或成绩。

## 皮肤

四套原创标准 64×64 皮肤位于 `adapters/minecraft/viewer/skins`，可用 `npm run minecraft:skins` 重新生成。观察页面按玩家名字加载本地皮肤；`http://127.0.0.1:18792/skins/preview.html` 使用同一玩家模型预览四套皮肤，不接入游戏世界。

独立 Java 实例可运行 `npm run minecraft:skin-client` 安装固定版本 Fabric 0.16.10 与 [CustomSkinLoader](https://github.com/xfl03/MCCustomSkinLoader) 15.0.1。脚本校验官方文件、复制四套 PNG、配置仅按本地用户名加载；不修改全局游戏或服务器，也不启动客户端。安装后网页的“进入游戏”按钮和隔离 HMCL 实例都使用该配置。不要再次用原版 `launcher.py --prepare --mode normal` 覆盖它；需要重做时重新运行皮肤安装命令。

客户端接入日志已确认 Fabric、CustomSkinLoader 与四名 NPC 各自的本地 PNG 成功加载；四套外观另在同一网页玩家模型中正面核验。原版未安装模组的离线客户端仍显示默认皮肤。CustomSkinLoader 为 GPL-3.0-only 官方未修改组件，只从官方来源下载，不将第三方 JAR 纳入仓库。
