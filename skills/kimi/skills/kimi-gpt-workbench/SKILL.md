---
name: kimi-gpt-workbench
description: 用GPT。识别 Kimi Work 任务的固定触发语「用GPT」，忽略 GPT 的大小写，例如「用gpt」。以 Kimi 身份自动派给桌面 Codex，跟进进度并在原会话回传结果和附件。也用于查任务状态及回复 GPT 的 Kimi 知识库查询。
---

# Kimi Work 的 GPT 工作台

新任务默认使用 GPT-6.2 Sol + Medium。用户明确指定模型或推理强度时，给 `submit` 加 `--model gpt-6.2-astra` 或 `--effort high`，只传明确指定的项目，原任务文本照常提交。

固定触发语是「用GPT」，GPT 的字母大小写不限，例如「用gpt」「用Gpt」。用户用这句话下达任务时，直接通过本技能以 Kimi 身份派给 GPT，并在当前会话跟进交付。

使用能访问电脑本地文件的 Kimi Work 会话。本机命令入口是 `node "C:/path/to/gpt-workbench/workbench.mjs"`。以下命令均接在该入口后面。

1. 立即把用户的原任务和范围写成 UTF-8 文本文件，运行 `submit --source kimi --prompt-file "任务文件"`。授权附件用 `--input "绝对路径"`，用户要求 GPT 工作模式时追加 `--mode work`。Kimi 负责派单、接收知识库请求和转发结果，原任务由 GPT 执行。
2. 记下返回的 `id`，在本会话任务目录运行 `follow --id ID --seconds 45`，工具超时至少 65 秒。每次工具调用只执行一次 `follow` 并保留完整 JSON。它持续回复心跳，终态和知识库请求一到就返回。仍在执行时，按最新状态或公开里程碑简报后立即调用下一次 `follow`，沿用同一 ID。用户主动查询进度可用 `status --id ID`。
3. 看到 `knowledgeRequests` 时，在 Kimi 自己已授权的知识库中检索对应问题。只返回必要摘要和可用出处。将回复写成 UTF-8 文件，运行 `knowledge-reply --provider kimi --id 查询ID --reply-file "回复文件"`，继续等待原任务。用户要求在独立会话处理工作台查询时，先运行 `knowledge-next --provider kimi`。查不到就如实回复。
4. `completed` 时直接回复 `text` 和可点击的附件，用 `deliveryArtifacts` 提供的本会话目录路径，未提供时用 `artifacts`。支持链接时附 `chatLink`。任务失败或中断时回传 `error` 和已有会话链接。重新打开会话后用同一 ID 调用 `follow` 就能取回终态。
5. 在同一条终态回复使用 `follow` 返回的额度，按「GPT（Codex）剩余额度 · 5 小时 X% · 一周 Y%」显示 `quota.fiveHourRemainingPercent` 和 `quota.weeklyRemainingPercent`。null 显示「暂无法读取」，0 显示 0%。

回传后，用 `delivery-report --id ID --source kimi --state submitted` 记录渠道已明确受理文字和应交附件。用户确认收到后，上报 `--state confirmed`。附件准备（`deliveryError`）或回传失败时，把原因写入 UTF-8 文本并用 `--state failed --reply-file "原因文件"` 上报。无法核实渠道是否受理时保持 `pending`。补发时在原会话用同一 ID 调用 `follow`，回传用户还没收到的文字和文件，优先使用本次返回的 `deliveryArtifacts`。已确认收到的任务仅在用户要求时补发。

回报任务 ID 与 `execution` 中的状态、实际会话模式、是否运行、模型、推理强度。模型和强度为 null 时说「未上报」。心跳表示工作台在线，`execution.running` 为 true 才能确认 Codex 正在执行。收到 `routingNote` 时同时告知请求模式。

用最新的 `execution.status` 说明当前阶段。`starting_gpt` 表示会话正在启动，`running` 表示已开工。
