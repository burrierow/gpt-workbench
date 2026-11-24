---
name: gpt-workbench-qwenwork
description: 在千问办公中派 GPT 任务或把指定稿件交给 WorkBuddy 存入 ima。使用本机工作台连接器。
---

# 用 GPT 工作台

## 迁移当前会话或转存对话

用户明确要求交接已有会话时，从当前可见的对话历史或用户指定并提供的导出中，选取真实用户与助手消息，按时间顺序原样写入 UTF-8 Markdown。角色标记单独成行，使用 `## 用户`、`## 助手`。把当前交接指令、系统提示、工具记录和隐藏推理排除在文件之外。缺失较早消息时说明可导出的范围。只提交用户选定的会话。

- **交给 GPT 继续**。调用 `migrate_gpt_chat`，传原会话标题和选中的 Markdown 正文或本机绝对路径。之后沿用 `follow_gpt_task`。 工作台将历史截为最多 8,000 字符，优先保留最近消息。
- **交给 WorkBuddy 存 ima**。调用 `send_to_workbuddy_ima`，传 `library`、`title` 和原始正文 `text` 或文件 `input`。用 `get_workbuddy_ima_status` 查询。 保留转存正文原文。回传转存 ID，WorkBuddy 返回真实 ima 条目回执后再报告已入库。


## 交给 WorkBuddy 存 ima

用户明确要求转存到具体 ima 知识库时，调用 `send_to_workbuddy_ima` 并传 `library`、`title`，以及原文 `text`、本机文件绝对路径 `input` 或本渠道已完成的 GPT 任务 `job`。多个产物时加 `input` 指明文件。可传会话引用 `origin`。用 `get_workbuddy_ima_status` 查询，queued 表示进入 WorkBuddy 收件队列，stored 表示 ima 已接受。

## 派发 GPT 任务

宿主提供真实稳定的账号或工作区、会话、用户消息标识时，首轮在 `submit_gpt_task` 附上 `scope`、`conversation`、`event`、`takeover: true`。之后在同会话收到每条用户消息，沿用作用域与会话 ID，填写本轮事件 ID，省略 `takeover`，无需检查触发词。重试沿用该条消息的事件 ID。用 `get_gpt_conversation` 查询绑定。回传 GPT 原始文字和附件。

宿主未传递真实标识或未触发当前 Skill 时，自动接管不可验证。有明确派单时按下列流程处理。避免从标题、正文或本机目录猜测标识。

在千问办公桌面会话中使用「GPT 工作台」本机连接器。手机或网页发来的任务由目标电脑上的千问办公会话处理。「用GPT」忽略英文字母大小写。

1. 调用 `submit_gpt_task`，把用户的原任务原样作为 `prompt`，用 `title` 传原会话标题。标题尚未生成时填简短的任务名，工作台自动添加「【千问办公】」。授权附件先取得本机路径，再作为 `inputs` 传入。用户指定模型、推理级别或 GPT 工作模式时，传入对应的 `model`、`effort` 或 `mode: work`。每项独立任务先各自派出并记住 ID。
2. 用 `follow_gpt_task` 按各任务 ID 分别等待，`seconds` 设为 30。任务仍在执行时按 `execution.status` 和最新公开进度简报，然后沿用原 ID 继续跟进。工具未连通时，说明连接器的实际报错。
3. 完成后，把 `text` 和 `chatLink` 回传到原会话。通过当前渠道的本地附件功能发送 `artifacts` 中的文件。渠道只支持路径时，如实给出可用路径。失败或中断时回传 `error`。随终态给出 GPT（Codex）5 小时与一周剩余额度，分别读取 `quota.fiveHourRemainingPercent` 和 `quota.weeklyRemainingPercent`，空值显示「暂无法读取」。
4. 附件工具明确受理后调用 `report_gpt_delivery` 记录 `submitted`，用户确认已收到时记录 `confirmed`。发送报错时记录 `failed`，并用 `detail` 说明原因。用同一 ID 取回并补发。
