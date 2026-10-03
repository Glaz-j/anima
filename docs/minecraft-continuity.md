# 持续工作与提前规划

针对“做一段动作，再空闲很久”的问题，保留 pi 的推理循环和独立身体控制器，增加提前规划与失败快速重规划。目的在于减少有工作可做时的接续空档，不以重复按键或模型调用数作为成绩。

## 运行机制

1. 身体发现有效计划只剩 1–2 步，或剩余授权不足 15 秒，发出 `planning-needed`。每版本、每个剩余步数只通知一次；空计划、已完成、已阻塞不会持续发通知。
2. 调度器在空闲时提前唤醒大脑，默认合并窗口 250ms；同一 NPC 始终只有一个推理任务。活动轮中提示合并到下一次模型请求，模型生成期间身体继续执行。
3. 大脑可用 `body_append({expectedVersion, steps, ttlMs?})` 提前追加。授权版本递增，`intent.id` 不变，当前技能不会重启。已完成步骤、采集与搭桥预算、应急策略均保留；整个计划仍最多 12 步，满后需重新规划。
4. 追加省略 TTL 时保留期限，提供 TTL 时只延长、不缩短。停止、取消、到期或明确阻塞的计划不可被追加复活。没有模型明确授权就不会自动续租或生成后续任务。
5. 当前计划发生明确的导航/跳跃失败时，`goal-blocked` 触发校验：版本、回执及已知最新状态仍匹配，且当前请求尚未获知该失败，才中止过时推理。返回 `body-replan`，不计为供应商失败，也不取消仍授权的身体自保。
6. 任务结束或失败后，调度器可以按 250ms 接续；这不是模型响应保证。供应商故障仍退避，普通心跳和聊天节流保持原有设置。重新规划开始时如身体待补充或已阻塞，优先执行规划，跳过额外的目标审议。

每次模型请求仍刷新身体状态，修改命令必须携带该请求实际看到的版本。追加前已经启动的技能会带原版本完成，但根据相同 `intent.id` 计入当前连续计划；替换目标使用新 ID，旧目标不能推进新目标。模型取消、任务停止、技能收尾与身体控制权的原有约束不变。

## 连续性实验

使用独立考场 `25575/25585`，不修改主世界 `25565`。入口无 `--run` 时仅显示帮助；要求考场已按 [技能考场说明](minecraft-skill-exam.md) 启动且没有其他玩家。

```powershell
npm run test:continuity

# 机制实验：脚本规划每批两步，人工等待 2 秒。不是 LLM 成绩。
npm run minecraft:continuity -- --run --mode scripted --variant baseline --task route
npm run minecraft:continuity -- --run --mode scripted --variant optimized --task route

# 真实 pi Agent，两组相同模型、公开目标、技能库和最多 12 步的规划能力。
npm run minecraft:continuity -- --run --mode agent --variant baseline --task route --model gpt-6.1-sol
npm run minecraft:continuity -- --run --mode agent --variant optimized --task route --model gpt-6.1-sol

# 旧计划遇到一次障碍后重新规划。
npm run minecraft:continuity -- --run --mode agent --variant baseline --task obstacle --model gpt-6.1-sol
npm run minecraft:continuity -- --run --mode agent --variant optimized --task obstacle --model gpt-6.1-sol
```

两组使用同一份源码与正式 `NpcScheduler`，是整组功能消融，不是历史 commit 复现。baseline 关闭追加工具、提前通知、活动推理的失败中断和紧急审议跳过，保留原 4 秒事件节流、10 秒心跳。optimized 启用这些功能。真实 Agent 可以一开始就排完路线，不能为展示优化而强制它每次只排两步。

路线题由服务器实际坐标和落地状态确认六个检查点；最后一站要求落地并在目标半径内持续 300ms。障碍题在第一轮注入明确标注的旧计划，局部障碍使其失败，之后才进入真实规划。因此它测试失败后的调度与纠正，不能单独证明生成中的旧模型被及时取消；后者由带延迟与版本竞争的集成测试覆盖。

每次生成全新私有记忆，结果和事件保存在 `var/minecraft/skill-exam/continuity/`。报告包含源码指纹、实际模型、服务器证据、独占控制数量和清理结果。只有服务器裁判能确认任务成功，模型回答和技能启动次数不算成绩。

主要指标：接续空档、最大空档、失败到重新规划/实际动作的时间、任务完成时间、模型调用数和模型与身体重叠时间。`noNativeWorkMs` 按模型等待、脚本延迟、其他空档互斥分解；`modelWaitMs` 包含审议和执行推理，可能与身体工作重叠，不能再与空档相加。持有技能控制权不等于产生有效进展，仍须结合服务器检查点。

生产诊断新增 `modelRequests`，逐次记录请求开始、结束、耗时、结果与实验注入延迟；不记录密钥、端点或提示词。它区分单次模型等待与整轮思考，避免把扫描、聊天、记忆写入和调度等待全部解释成“模型反应慢”。

局限：固定短路线不能证明开放世界生存能力；一次真实模型对照也不足以作稳定性结论。应保留失败样本，交替运行多次，尤其检查 NPC 是否仍在有效工作、是否反复提交相同失败动作，以及有理由等待是否被误当成性能问题。
