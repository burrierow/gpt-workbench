---
name: gpt-workbench
description: 用GPT。识别 WorkBuddy 任务的固定触发语「用GPT」，忽略 GPT 的大小写，例如「用gpt」。自动派给桌面 Codex，跟进进度并在原会话回传结果和附件。也用于查任务状态及回复 GPT 的 WorkBuddy 知识库查询。
---

# WorkBuddy 工作台

新任务默认使用 GPT-6.2 Sol + Medium。用户明确指定模型或推理强度时，给 `submit` 加 `--model gpt-6.2-astra` 或 `--effort high`，只传明确指定的项目，原任务文本照常提交。

固定触发语是「用GPT」，GPT 的字母大小写不限，例如「用gpt」「用Gpt」。用户用这句话下达任务时，直接把后面的任务交给 GPT，并在当前会话跟进交付。

本机命令入口是 `node "C:/path/to/gpt-workbench/workbench.mjs"`。以下命令均接在该入口后面。

1. 把原任务和范围写成 UTF-8 文本文件，直接运行 `submit --source workbuddy --prompt-file "任务文件"`。复用本机已有的授权附件路径，手机附件尚未落盘时先下载一次，再用 `--input "绝对路径"` 附上。用户说「用 GPT 工作模式」时追加 `--mode work`。入口或附件有问题时，按 `submit` 返回的错误处理。任务分析由 GPT 完成。
2. 每项独立任务分别写文件、调用 `submit` 并记录自己的 `id`。同一条消息列出多项独立任务时，先提交全部任务，再开始跟进。跟进期间收到新的「用GPT」任务时，立即按同样方式提交并加入跟进。
3. 对每个任务 ID 并行运行 `follow --id ID --seconds 30`，工具超时至少 50 秒。每次只执行一次 `follow`，保留完整 JSON。终态和知识库请求会提前返回。仍在执行时，用 `execution.status` 和最新的公开里程碑简报，再用同一 ID 继续 `follow`。谁先到终态就先回传谁。等待命令会回复心跳。单独查进度用 `status --id ID`。
4. 看到 `knowledgeRequests` 时，在 WorkBuddy 自己已授权的知识库中检索对应问题。只返回必要摘要和可用出处。将回复写成 UTF-8 文件，运行 `knowledge-reply --provider workbuddy --id 查询ID --reply-file "回复文件"`，然后继续等待原任务。用户要求在独立会话处理工作台查询时，先运行 `knowledge-next --provider workbuddy`。查不到就明确回复，并保留出处信息。查询正文和出处只用于本次请求。
5. 当状态为 `completed`，在原手机来路或当前会话直接回复 `text`，并用一次 `present_files` 将该任务 `artifacts` 中的原始绝对路径作为 `files` 提交。支持链接时附 `chatLink`。若附件上传不可用，报告具体文件和渠道限制。失败或中断时回传 `error` 和已有会话链接。重新取回交付时，用同一任务 ID 调用 `follow`。
6. 在同一条终态回复使用 `follow` 返回的 `quota.fiveHourRemainingPercent` 和 `quota.weeklyRemainingPercent`，按「GPT（Codex）剩余额度 · 5 小时 X% · 一周 Y%」显示。null 显示「暂无法读取」，0 显示 0%。

回传后，用 `delivery-report --id ID --source workbuddy --state submitted` 记录渠道已明确受理文字和应交附件。用户确认收到后，上报 `--state confirmed`。附件准备（`deliveryError`）或回传失败时，把原因写入 UTF-8 文本并用 `--state failed --reply-file "原因文件"` 上报。无法核实渠道是否受理时保持 `pending`。补发时在原会话用同一 ID 调用 `follow`，回传用户还没收到的文字和文件。已确认收到的任务仅在用户要求时补发。

向用户反馈任务 ID 和 `execution` 中的状态、实际模式、是否运行、模型及推理强度。模型和强度为 null 时说「未上报」。心跳表示工作台在线，`execution.running` 为 true 才能确认 Codex 正在跑。收到 `routingNote` 时同时告知请求模式。时间戳以 Z 结尾代表 UTC，向用户显示北京时间时加八小时。
