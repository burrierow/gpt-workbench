# 同会话接管

首条经用户授权的派单使用 `relay --takeover`。宿主把随后收到的每条真实用户消息依次提交给 `relay`。后续调用沿用原来的来源、作用域和会话 ID，并填写该条消息自己的事件 ID。无需再检查触发词。

| 参数 | 取值 |
| --- | --- |
| `--source` | `gpt`、`workbuddy`、`kimi` 或 `qwenwork` |
| `--scope` | 宿主提供的稳定账号或工作区标识。单账号独占安装可配置一个固定的安装作用域 |
| `--conversation` | 当前来源会话的稳定 ID |
| `--event` | 该条用户消息的稳定 ID。投递重试使用原 ID |
| `--prompt-file` | 当轮原始用户消息的 UTF-8 文件。可重复用 `--input` 附上获授权的原文件 |

```powershell
node ./workbench.mjs relay --source workbuddy --scope example-account --conversation example-chat --event message-1 --takeover --prompt-file ./first.txt
node ./workbench.mjs relay --source workbuddy --scope example-account --conversation example-chat --event message-2 --prompt-file ./follow-up.txt
node ./workbench.mjs conversation-status --source workbuddy --scope example-account --conversation example-chat
```

适配器应按宿主事件顺序逐条提交，确认工作台受理后即可提交下一条，无需等待 GPT 完成。工作台按提交顺序串行发往同一 GPT 会话。不同作用域或会话可以并行。首次仍在排队时，后续消息也可以受理。

适配器对每条消息保存任务 ID 和原会话投递地址，通过 `follow --id ID --seconds 30` 取回状态。终态按次序原样发送 `text` 并附上 `deliveryArtifacts` 或 `artifacts`。错误使用 `error`，可附 `chatLink`。状态和失败回执可由适配器直接生成，业务答复来自 GPT。发送确认由渠道产生，回执命令见 README。若回传结果不确定，先查原会话实际送达情况，再使用同一任务 ID 取回原件。

若首轮未取得 GPT 会话 ID，已排队的跟进会收到失败回执，用户可从来源会话发起一次新的接管。若监听器重启前已尝试向 GPT 发送该轮，工作台保留同一任务与会话链接并报告中断，供核对。单笔旧派单仍可用原 ID 跟进。旧任务中的标题、路径或备注不足以可靠补建绑定。

`config.json` 的数据目录包含私有的 `conversations.sqlite`、任务目录、结果及附件。迁移电脑或回滚前请停空队列，保留整个数据目录及相应 Codex 会话历史。来源标识应取自宿主事件。不要从标题、正文或模型猜测 ID。

## 客户端接入

- [Codex / GPT](codex-gpt.md)
- [WorkBuddy](workbuddy.md)
- [Kimi Work](kimi.md)
- [千问办公](qwenwork.md)
