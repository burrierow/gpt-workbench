---
name: kimi-gpt-workbench
description: 用GPT，或把指定会话内容、文件和转写稿交给 WorkBuddy 存入 ima。支持任务跟进和知识库查询。
---

# Kimi Work 的 GPT 工作台

## 迁移当前会话或转存对话

用户明确要求交接已有会话时，从当前可见的对话历史或用户指定并提供的导出中，选取真实用户与助手消息，按时间顺序原样写入 UTF-8 Markdown。角色标记单独成行，使用 `## 用户`、`## 助手`。把当前交接指令、系统提示、工具记录和隐藏推理排除在文件之外。缺失较早消息时说明可导出的范围。只提交用户选定的会话。指定其他 Kimi 对话时，使用 send-chat-to-gpt 技能定位和导出。

- **交给 GPT 继续**。运行工作台入口的 `migrate --source kimi --title "原会话标题" --context-file "对话文件绝对路径"`。可加 `--origin "原会话 ID"`。用新任务 ID 调用 `follow`，向用户交付实际 GPT 会话链接。 工作台将历史截为最多 8,000 字符，优先保留最近消息。
- **交给 WorkBuddy 存 ima**。运行 `ima-save --source kimi --title "原会话标题" --input "对话文件绝对路径"`。目标库沿用已有的个人知识库（本机配置指定）。用 `ima-status --id 转存ID` 查询。 保留转存正文原文。回传转存 ID，WorkBuddy 返回真实 ima 条目回执后再报告已入库。


用户要求把已有的 Kimi 对话迁到 GPT 继续时，使用同插件的 send-chat-to-gpt 技能定位并导出该对话，再提交迁移任务。

## 交给 WorkBuddy 存 ima

用户明确要求「存到 ima」时，目标就是 ima 个人知识库（本机配置指定）。例如「语音转写文字，存到 ima」应在稿件生成后直接派单。选择用户指定的转写稿或会话正文，正文先原样保存为 UTF-8 的 txt 或 md。运行 `ima-save --source kimi --title "资料标题" --input "稿件绝对路径"`，工作台自动填写库名和个人库范围。有本会话标识时可传 `--origin`。如果稿件是同一来源的 GPT 成品，也可传 `--job GPT任务ID`，多份产物用 `--input` 指定其中一份。配置了固定库时使用配置值，未配置时传用户指定的库名。

用 `ima-status --id 转存ID` 查询。queued 表示已交到 WorkBuddy 收件队列，stored 表示 WorkBuddy 已拿到 ima 的条目回执。processing、blocked 和 needs_review 分别表示处理中、缺少条件和等待核对。把转存 ID 与真实状态报给用户。

新任务默认使用 GPT-6.2 Sol + Medium。用户明确指定模型或推理强度时，给 `submit` 加 `--model gpt-6.2-astra` 或 `--effort high`，只传明确指定的项目，原任务文本照常提交。

固定触发语是「用GPT」，GPT 的字母大小写不限，例如「用gpt」「用Gpt」。用户用这句话下达任务时，直接通过本技能以 Kimi 身份派给 GPT，并在当前会话跟进交付。

使用能访问电脑本地文件的 Kimi Work 会话。从环境变量 `GPT_WORKBENCH_ENTRY` 取得本机入口路径。命令格式为 `node "<工作台入口>"`。以下命令均接在该入口后面。

1. 立即把用户的原任务和范围写成 UTF-8 文本文件，运行 `submit --source kimi --prompt-file "任务文件"`。用 `--title` 传原会话标题，标题尚未生成时填简短的任务名。工作台自动添加「【Kimi】」。授权附件用 `--input "绝对路径"`，用户要求 GPT 工作模式时追加 `--mode work`。Kimi 负责派单、接收知识库请求和转发结果，原任务由 GPT 执行。
2. 记下返回的 `id`，在本会话任务目录运行 `follow --id ID --seconds 45`，工具超时至少 65 秒。每次工具调用只执行一次 `follow` 并保留完整 JSON。它持续回复心跳，终态和知识库请求一到就返回。仍在执行时，按最新状态或公开里程碑简报后立即调用下一次 `follow`，沿用同一 ID。用户主动查询进度可用 `status --id ID`。
3. 看到 `knowledgeRequests` 时，在 Kimi 自己已授权的知识库中检索对应问题。只返回必要摘要和可用出处。将回复写成 UTF-8 文件，运行 `knowledge-reply --provider kimi --id 查询ID --reply-file "回复文件"`，继续等待原任务。用户要求在独立会话处理工作台查询时，先运行 `knowledge-next --provider kimi`。查不到就如实回复。
4. `completed` 时直接回复 `text` 和可点击的附件，用 `deliveryArtifacts` 提供的本会话目录路径，未提供时用 `artifacts`。支持链接时附 `chatLink`。任务失败或中断时回传 `error` 和已有会话链接。重新打开会话后用同一 ID 调用 `follow` 就能取回终态。
5. 在同一条终态回复使用 `follow` 返回的额度，按「GPT（Codex）剩余额度 · 5 小时 X% · 一周 Y%」显示 `quota.fiveHourRemainingPercent` 和 `quota.weeklyRemainingPercent`。null 显示「暂无法读取」，0 显示 0%。

回传后，用 `delivery-report --id ID --source kimi --state submitted` 记录渠道已明确受理文字和应交附件。用户确认收到后，上报 `--state confirmed`。附件准备（`deliveryError`）或回传失败时，把原因写入 UTF-8 文本并用 `--state failed --reply-file "原因文件"` 上报。无法核实渠道是否受理时保持 `pending`。补发时在原会话用同一 ID 调用 `follow`，回传用户还没收到的文字和文件，优先使用本次返回的 `deliveryArtifacts`。已确认收到的任务仅在用户要求时补发。

回报任务 ID 与 `execution` 中的状态、实际会话模式、是否运行、模型、推理强度。模型和强度为 null 时说「未上报」。心跳表示工作台在线，`execution.running` 为 true 才能确认 Codex 正在执行。收到 `routingNote` 时同时告知请求模式。

用最新的 `execution.status` 说明当前阶段。`starting_gpt` 表示会话正在启动，`running` 表示已开工。

## 同会话接管

只有宿主提供真实稳定的账号或工作区、当前会话与当前用户消息标识时，用下列命令提交首轮。
```text
relay --source kimi --scope <作用域> --conversation <会话ID> --event <消息ID> --takeover --prompt-file "<本轮原文文件>"
```

在该会话收到后续用户消息时，沿用相同的作用域与会话 ID，使用该消息事件 ID 再次调用 relay，省略 --takeover，无需检查触发词。重试使用同一事件 ID。按任务 ID 取回 GPT 原文与附件，并在原会话交付。宿主未暴露稳定标识或逐消息触发时，继续支持明确派单，说明自动接管不可验证。不要用标题、目录或正文猜测会话 ID。
