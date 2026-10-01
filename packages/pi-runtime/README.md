# pi 运行适配

这里封装 pi 的模型调用、上下文处理、工具循环、中断和运行事件，实现 NPC 核心定义的接口。

角色长期记忆由 NPC 核心管理。pi 的会话与运行记录按需持久化，具体方式待设计。

## 依赖

本模块使用以下 npm 运行库，直接依赖固定为 `0.84.2`：

- `@earendil-works/pi-agent-core`：Agent 状态、工具执行循环和运行事件。
- `@earendil-works/pi-ai`：模型与供应商调用接口。

在仓库根目录执行 `npm ci` 即可安装，无需全局安装 `pi-coding-agent`。依赖源码由 npm 安装到 `node_modules/`，版本由根目录锁文件管理。

## 后续接入

由本模块导入 `Agent`，配置模型流式调用函数、上下文转换与 NPC 工具，实现 `npc-core` 定义的运行接口。工具直接注册到 Agent，不依赖 `pi-coding-agent` 的 Extension 加载机制。

当前已提供 [Agent 调用示例](examples/README.md)，包含离线演示和真实模型模式。服务运行适配尚未实现，`src/` 仍为占位目录。
