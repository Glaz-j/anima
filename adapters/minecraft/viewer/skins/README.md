# Anima 原创角色皮肤

四套 64×64、经典四像素手臂皮肤：谢耳朵的绿色闪电衫、福尔摩斯的深色外套和围巾、死侍的红黑面罩、胡一菲的浅色外套与红色内搭。由代码绘制，不含社区转载素材，按 CC0-1.0 发布。

重新生成：从仓库根目录运行 `node scripts/minecraft/generate-skins.mjs`。

PNG 使用标准 Minecraft Java UV 布局，可导入支持自定义皮肤的客户端。浏览器观察器使用仓库内的同一份 PNG。运行 `npm run minecraft:skin-client` 可为隔离 Java 实例安装 Fabric 与仅读取本地 PNG 的 CustomSkinLoader；四名角色的本地配置均已在客户端加载日志中验证。未安装该模组的普通离线客户端仍显示默认皮肤。安装方式与验证范围见 [建造和皮肤说明](../../../../docs/minecraft-building.md)。
