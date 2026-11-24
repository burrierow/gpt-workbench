---
name: gpt-workbench
description: GPT 工作台入口，用于派单、查进度、临时查询知识库，或把转写稿和指定会话内容交给 WorkBuddy 存入 ima。
---

# GPT 工作台

## 迁移当前会话或转存对话

用户明确要求交接已有会话时，从当前可见的对话历史或用户指定并提供的导出中，选取真实用户与助手消息，按时间顺序原样写入 UTF-8 Markdown。角色标记单独成行，使用 `## 用户`、`## 助手`。把当前交接指令、系统提示、工具记录和隐藏推理排除在文件之外。缺失较早消息时说明可导出的范围。只提交用户选定的会话。

- **交给 GPT 继续**。运行工作台入口的 `migrate --source gpt --title "原会话标题" --context-file "对话文件绝对路径"`。可加 `--origin "原会话 ID"`。用新任务 ID 调用 `follow`，向用户交付实际 GPT 会话链接。 工作台将历史截为最多 8,000 字符，优先保留最近消息。
- **交给 WorkBuddy 存 ima**。运行 `ima-save --source gpt --title "原会话标题" --input "对话文件绝对路径"`。加 `--library "明确指定的库名"`。用 `ima-status --id 转存ID` 查询。 保留转存正文原文。回传转存 ID，WorkBuddy 返回真实 ima 条目回执后再报告已入库。


新任务默认使用 GPT-6.2 Sol，推理强度为 Medium。用户明确指定模型或推理强度时，给 `submit` 加 `--model gpt-6.2-astra` 或 `--effort high`，只传明确指定的项目，并保留原任务文本。

使用有本机文件访问权限的桌面会话。从环境变量 `GPT_WORKBENCH_ENTRY` 取得本机入口路径。命令格式为 `node "<工作台入口>"`。以下命令均接在该入口后面。

用 `submit` 新建 GPT 任务时，以 `--title` 传入派单会话标题。标题尚未生成时，使用简短的任务名称。工作台按实际派单来源添加前缀。

## 交给 WorkBuddy 存 ima

用户明确要求转存时，以当前渠道的来源提交。Kimi 的「存到 ima」固定指 ima 个人知识库（本机配置指定），直接运行 `ima-save --source kimi --title "资料标题" --input "稿件绝对路径"`。GPT 使用 `--source gpt --library "具体库名"`。如果用户指定的是会话正文，先原样保存为 UTF-8 的 txt 或 md。可用 `--origin` 记录会话引用。直接引用同一渠道已完成的 GPT 产物可用 `--job GPT任务ID`。录音仍在转写时，等文字稿生成再转存。提交只代表进入 WorkBuddy 收件队列，用 `ima-status --id 转存ID` 查询，并按实际状态向用户回报。

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

## 同会话接管

只有宿主提供真实稳定的账号或工作区、当前会话与当前用户消息标识时，用下列命令提交首轮。
```text
relay --source gpt --scope <作用域> --conversation <会话ID> --event <消息ID> --takeover --prompt-file "<本轮原文文件>"
```

在该会话收到后续用户消息时，沿用相同的作用域与会话 ID，使用该消息事件 ID 再次调用 relay，省略 --takeover，无需检查触发词。重试使用同一事件 ID。按任务 ID 取回 GPT 原文与附件，并在原会话交付。宿主未暴露稳定标识或逐消息触发时，继续支持明确派单，说明自动接管不可验证。不要用标题、目录或正文猜测会话 ID。
