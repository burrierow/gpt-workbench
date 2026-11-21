---
name: gpt-workbench
description: GPT 工作台入口，用于自动派单、按任务 ID 查进度，或临时向 WorkBuddy、Kimi 查询已授权的知识库。
---

# GPT 工作台

新任务默认使用 GPT-6.2 Sol，推理强度为 Medium。用户明确指定模型或推理强度时，给 `submit` 加 `--model gpt-6.2-astra` 或 `--effort high`，只传明确指定的项目，并保留原任务文本。

使用有本机文件访问权限的桌面会话。本机命令入口是 `node "C:/path/to/gpt-workbench/workbench.mjs"`。以下命令均接在该入口后面。

## Kimi Work 派单

在 Kimi 中，遇到「用GPT」（忽略 GPT 的大小写）直接按以下步骤执行。本技能包含完整的派单方法。

1. 将原任务写成 UTF-8 文本，立即运行 `submit --source kimi --prompt-file "任务文件"`。授权附件用 `--input "绝对路径"`，用户要求 GPT 工作模式时追加 `--mode work`。原任务由 GPT 执行。
2. 记下返回的 `id`，在本会话任务目录运行 `follow --id ID --seconds 45`（工具超时至少 65 秒）。每次调用只执行一次并保留完整 JSON。未完成时用 `execution.status` 或最新公开进度简报，再用同一 ID 继续 `follow`。出现 `knowledgeRequests` 时，在已授权的 Kimi 知识库查询，回复写成 UTF-8 后运行 `knowledge-reply --provider kimi --id 查询ID --reply-file "回复文件"`，再继续跟进。
3. 终态直接回传 `text` 或 `error`、已有的 `chatLink`，并用 `deliveryArtifacts` 作为原会话附件路径，未提供时用 `artifacts`。附上「GPT（Codex）剩余额度 · 5 小时 X% · 一周 Y%」，数字取 `quota.fiveHourRemainingPercent` 和 `quota.weeklyRemainingPercent`，null 显示「暂无法读取」，0 显示 0%。重新查询交付仍用原 ID 调用 `follow`。

## GPT 和 WorkBuddy

WorkBuddy 使用它的本地工作台技能及 `--source workbuddy`。

- 按任务 ID 查看进度时运行 `status --id ID`，读取 `execution`。需要派单时使用 `submit --source gpt --prompt-file "任务文件"`。「用 GPT 工作模式」追加 `--mode work`，工作台自动派发到当前可用的桌面 Codex 入口。任务已在当前会话执行时继续当前会话。
- 原生 Work 旧会话已开始执行时可继续原任务。用 `work-report --id ID --model "当前模型" --effort "当前推理强度"` 上报能够确认的设置。把交付文件保存在任务的 `artifacts`，完成后运行 `work-finish --id ID --reply-file "结果文件"`。有实际的当前会话链接时可追加 `--chat-link "会话链接"`。
- **查询外部知识库**时，仅在用户授权的任务范围内提问。写 UTF-8 问题文件，运行 `knowledge-ask --provider workbuddy --job 任务ID --prompt-file "问题文件" --seconds 25`，查询 Kimi 时改成 `--provider kimi`。派单方正在等待同一任务时会收到问题，其他来源需要对应 Agent 在自己的会话里处理该请求。返回 `pending` 时用 `knowledge-wait --provider 来源 --id 查询ID --seconds 25` 继续等。结果用于当前任务和必要引用。别把外部内容写入 GPT 的长期记忆、技能或跨任务配置。Work 模式下如果无法阻止把本聊天用于长期记忆，先报告这一限制，再等用户决定是否继续查询。
