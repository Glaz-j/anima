# Synthetic-Persona-Chat：下载与格式适配

结论：可以沿用现有聊天文件结构，适合先验证“聊天 → 人格档案 → NPC”流程。缺少真实时间、稳定的跨会话身份和长期行为记录，因此不能直接当作长期真人聊天的等价替代。

本次下载、转换和验证未读取私人聊天，也未调用模型 API；尚未生成或评测新的人格。

## 已落盘的数据

数据目录：[data/public/synthetic-persona-chat](../../data/public/synthetic-persona-chat/)。整个目录被 Git 忽略。

四份原始 CSV 合计 38,379,252 字节，约 38.38 MB。下表为 2026-10-01 对固定版本的实际解析结果。“可直接解析”仅表示说话人标签明确，不代表语义质量或人设一致性已经通过评测。

| 上游分区 | 原始对话 | 可直接解析 | 待检查 | 可直接解析的发言 |
| --- | ---: | ---: | ---: | ---: |
| 新合成人设 synthetic | 11,001 | 10,964 | 37 | 190,827 |
| PersonaChat 人设 train | 8,938 | 8,720 | 218 | 237,387 |
| PersonaChat 人设 valid | 1,000 | 973 | 27 | 26,985 |
| PersonaChat 人设 test | 968 | 945 | 23 | 25,931 |
| 合计 | 21,907 | 21,602 | 305 | 481,130 |

305 段有旁白、无说话人标签的续行、特殊格式或空对话，整段暂不纳入转换样例。没有删除原始数据，也没有猜测这些行的归属。待检查清单在 `prepared/review-needed.jsonl`，可通过 CSV 文件名与记录序号定位；记录序号从表头后的第一条数据开始，不是文本文件物理行号。

全部原始数据已经下载。目前只把新合成人设分区的前 3 段合格对话转换成了 6 个角色视角，各有 7–8 条本人发言。两个视角共享同一段原始对话，不应作为独立样本分到训练集与测试集两边。

## 先看这几个文件

- [第一位角色的聊天输入](../../data/public/synthetic-persona-chat/prepared/samples/synthetic-000001-user1/analysis-input.md)：用于人格提取，只有对话，没有参考人设。
- [同一段对话中另一位角色的输入](../../data/public/synthetic-persona-chat/prepared/samples/synthetic-000001-user2/analysis-input.md)：验证“我 / 对方”视角切换。
- [结构化消息](../../data/public/synthetic-persona-chat/prepared/samples/synthetic-000001-user1/messages.jsonl)与[回复样本](../../data/public/synthetic-persona-chat/prepared/samples/synthetic-000001-user1/private-chat-examples.jsonl)：对应现有 QQ 中间格式。
- [参考人设](../../data/public/synthetic-persona-chat/prepared/evaluation/reference-personas.jsonl)：仅供评测者使用，不加入“只从聊天提取人格”的输入。
- [完整统计与校验清单](../../data/public/synthetic-persona-chat/prepared/dataset-report.json)。

本机另外运行了已安装的 yourself-skill 原版解析器，六份样例的总消息数、本人消息数均核对通过，结果在 `prepared/compatibility-check.json`。该兼容性检查依赖工作区旁边的本地复现项目，下面的独立准备脚本不依赖它。

## 与现有格式的映射

实际 CSV 只有三列：`user 1 personas`、`user 2 personas`、`Best Generated Conversation`。对话列是一段多行文字，每次发言通常以 `User 1:` 或 `User 2:` 开头。

| 原始信息 | 现有格式中的表示 |
| --- | --- |
| 一条 CSV 记录 | 一个独立 `conversation_id`，包含分区和记录序号 |
| 本次选定的角色 | `account_id`；其发言 `is_self = true` |
| 每行明确的说话人 | `sender_id`，按标签识别，不假定轮流发言 |
| 发言正文 | `text`，只移除说话人前缀与首尾空白 |
| 原始发言顺序 | `sort_sequence` |
| 时间、引用、媒体等缺失信息 | 时间与引用留空，不编造时间戳或现实经历 |
| 双方原始人设 | 单独放进 `evaluation/reference-personas.jsonl` |

每个角色目录包含：

```text
messages.jsonl               全部消息，含本人和对方
self-text.jsonl              只保留本人文字
private-chat-examples.jsonl  上文 → 本人回复，沿用旧文件名
parser-input.json            yourself-skill 通用 JSON 解析入口
analysis-input.md            保留说话人标记的阅读版
```

`messages.jsonl` 的 23 个顶层字段与现有 QQ 标准化输出相同，`platform` 使用 `synthetic-persona-chat`。对话样本仍约定 `assistant` 为当前模拟对象，`user` 为对方；新增 `account_id` 便于混合多份材料时分辨对象。

时间字段为 `null`。旧 QQ 的窗口构造函数依赖时间相减，不能直接调用；此次适配器在单段对话内取最多 8 次先前发言，不使用小时过滤，也不按 5 分钟合并短消息。以后任何时间统计消费者都需要处理缺失时间。

原始 `User 1` 并不是全库同一个人。当前按“分区 + 会话 + 角色”分配身份，不自动把不同会话合并。记录了参考人设文本的哈希，但它只表示文本相同。新合成人设分区按去除行首尾空白后的完整文本计算有 3,980 组，最多重复 15 次；这不是已验证的人物身份数。

## 适合怎样验证人格提取

先让模型只看 `analysis-input.md`，生成有对话证据的人物档案，再由评测者对照原始对话与参考人设。

例如第一段聊天确实提到搬到波特兰追求烹饪事业，但参考人设中的马拉松、百老汇音乐等信息没有在这段聊天出现。不能要求提取器猜出这些未披露信息，也不能把原始人设当作所有聊天事实的完整清单。

目前每个样例只有一次短会话，适合检查说话人归属、事实提取、少量偏好和档案注入。它们不足以支持丰富的情绪模式、长期决策方式或亲密关系行为结论。原版 yourself-skill 的部分词频规则面向中文，能读入英文并不意味着这些风格统计同样有效。

可以先保留英文验证流程；以后中文展示的翻译应标明为派生材料，不把译文当作原始说话风格。

## 重现

需要 Python 3.10+，只使用标准库，不需要 `pip install`。这是数据准备工具，不影响 TypeScript NPC 运行时。

在 Anima 根目录运行：

```powershell
python -B -X utf8 scripts/datasets/prepare_synthetic_persona_chat.py
```

首次运行会下载固定版本的四份 CSV 和上游 README，核对 SHA-256，然后检查全量数据并转换 3 段样例。已有原始文件会先验校验值再复用；不会覆盖已有输出目录。需要另做一轮时：

```powershell
python -B -X utf8 scripts/datasets/prepare_synthetic_persona_chat.py --sample-conversations 10 --output data/public/synthetic-persona-chat/prepared-10
```

归属与窗口测试：

```powershell
python -B -X utf8 -m unittest discover -s scripts/datasets -p 'test_*.py' -v
```

本次 6 项测试通过，覆盖角色视角、跨会话身份、缺失时间、异常说话人标签、正文中的说话人字样，以及上下文不包含未来发言。

## 来源与许可

来源：[Google Research Datasets / Synthetic-Persona-Chat](https://github.com/google-research-datasets/Synthetic-Persona-Chat)。固定提交：`1f367a0f05d388ca96ebbbc9e5752ab19ac76510`。

作者：Pegah Jandaghi、XiangHai Sheng、Xinyi Bai、Jay Pujara、Hakim Sidahmed。

论文：[Faithful Persona-based Conversational Dataset Generation with Large Language Models](https://arxiv.org/abs/2312.10007)。上游声明数据采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。原始许可声明保存在 `raw/UPSTREAM-README.md`，转换结果附有 `prepared/ATTRIBUTION.md`，记录来源与转换方式。

原始 CSV、样例和分析产物仍放在被 Git 忽略的数据目录；此次新增的准备脚本、测试和本说明可随代码分享。
