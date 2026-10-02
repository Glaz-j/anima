# 世界实现位置

世界实现或集成说明。

世界负责空间、时间、规则、行动执行与实际事件。具体世界通过适配器与 NPC 服务交换协议数据。

2026-10-02 已确定 Minecraft 为第一阶段世界。接入原型位于 `adapters/minecraft/`：原生客户端由 HMCL 启动，Mineflayer 角色通过 HTTP API 在本地服务器行动。普通实例 `Anima-Local-1.21.4` 与 Bot 连接同一个 `127.0.0.1:25565` 服务器；试玩单人实例是另一个世界。

后续角色交互以 Minecraft 为验证入口，人格、检索和长期记忆继续由 NPC 层管理。世界资源和存档位于被 Git 忽略的 `var/minecraft/`，详细运行方式见 [接入说明](../adapters/minecraft/README.md)。此目录保留集成说明及未来世界实现。
