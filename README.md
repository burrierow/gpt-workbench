# GPT 工作台

在这台 Windows 电脑上，WorkBuddy 或 Kimi Work 接到明确要求交给 GPT 的任务后，通过本地收件目录提交。工作台使用桌面应用随附的 Codex App Server 和现有 ChatGPT 登录来执行自动任务。任务有独立工作目录、会话链接及产物列表。

## 安装

需要 Windows、Node.js 24、已登录 ChatGPT 的 Codex，以及配置了本地控制器的 Clash Verge。通过 WorkBuddy 派单或恢复线路时，还需要安装 WorkBuddy。用同一个普通 Windows 用户运行这些应用和监听器。

1. 把 `config.example.json` 复制为 `config.json`，填写本机的绝对路径。配置文件里的 `dataDir` 是工作台队列目录，`codexExe` 是 Codex CLI 路径，`clash.profile` 是 Clash Verge 运行时配置文件。设置 `clash.group` 为实际用于访问 ChatGPT 的可手动选择策略组。可选的 `kimiTaskRoot` 和 `historySectionId` 可以留空。
2. 从 PowerShell 运行 `node .\workbench.mjs doctor`，再运行 `node .\workbench.mjs workbuddy-check` 核对恢复入口。
3. 运行 `node .\workbench.mjs serve` 前台监听，或者运行 `Start-Workbench.ps1` 把日志放到配置的数据目录。保持监听器在线后再派单。
4. 使用相应的 `skills/` 模板。把技能中示例的 `C:/path/to/gpt-workbench/workbench.mjs` 替换为实际入口，再按宿主应用的方式安装。Kimi 插件目录为 `skills/kimi`，也可单独导入其中的技能。

## 从手机使用

从已连接电脑的 WorkBuddy 助理或 Kimi Work 远程会话发送：

> 用GPT。根据我附的文件提取三个要点，生成一份 Markdown。

固定触发语中的 GPT 大小写不限。

新任务默认使用 **GPT-6.2 Sol + Medium**。单笔任务可在开头写「用 GPT-6.2 Astra + High。帮我……」，也可以先写「用GPT」，再分行填写「模型：GPT-6.2 Astra」和「推理强度：High」。两项可以分别覆盖。命令行调用 `submit` 时，`--model` 和 `--effort` 优先于提示词开头的设置。

同一个 WorkBuddy 连发的任务按各自的任务 ID 并行执行。一条消息中的多项独立任务也可以分别派单，先全部发出，再按各自的 ID 跟进和交付。

派单 Agent 用工作台技能提交任务，并通过原渠道回复文字和附件。渠道需要支持回传本机文件。查询或恢复跟进时，把工作台任务 ID 发给原派单 Agent。

WorkBuddy 和 Kimi 回传每笔任务的终态时，会附上当前 Codex 账号 5 小时和一周窗口的剩余百分比。自动任务随终态回执提供 `quota`。较早的任务可以用 `quota` 命令补查当前值。额度暂无法读取时，任务结果和附件照常交付。

所有新任务都自动派发。手机说「用 GPT 工作模式」时，工作台采用当前可自动启动的桌面 Codex，并回报请求模式和实际模式。旧 Work 队列中的待领取任务会沿用原 ID 自动开始。已开始的旧 Work 会话继续原任务。WorkBuddy 和 Kimi 派发的会话会出现在桌面应用的 **Codex** 任务历史中，标题以「工作台」开头。工作台也会保存「GPT 工作台」分组归属，桌面侧栏的分组刷新可能滞后。任务状态包含会话链接。参见 [ChatGPT 与 Codex 的桌面入口](https://learn.chatgpt.com/docs/use-chatgpt)。

`status` 和 `wait` 的 `execution` 会列出当前状态、会话模式、是否运行、模型和推理强度。只有 Codex 确认回合已启动，才标记为正在运行。模型与强度取自 Codex 的会话配置。Work 模式可用 `work-report --id ID --model "当前模型" --effort "当前推理强度"` 回报可确认的参数，未上报的值为 null。心跳反映工作台在线。

每次心跳可携带最近的公开任务进度，例如计划步骤、检索、工具调用和文件更新。`wait --id ID --seconds 60 --after-state submitted --after-progress 0` 会在阶段或进度变化时提前返回。将最新的 `state` 和 `progress.sequence` 传进下一次等待，终态照常返回。新任务收件后各自检查线路并启动独立会话，可以同时执行。一笔任务的结束或失败只关闭该笔任务的会话进程。进度采集使用 Codex 事件，不额外请求模型。

WorkBuddy 用 `follow --id ID --seconds 30`，Kimi 用 `follow --id ID --seconds 45`。进行中的公开进度随这一轮等待回传，终态和知识库请求可以提前返回。终态同时返回结果、Codex 额度和附件路径。WorkBuddy 使用 `present_files` 直传原产物。在 Kimi 本机任务目录运行时，工作台把产物准备在该会话下的 `gpt-results-<ID>`。

## Windows 上的运行位置

- 可选：用 Windows 任务计划程序让监听器在当前用户登录时启动。监听器每 10 秒补扫并更新运行状态。手机远程连接依赖电脑在线和派单应用保持登录。
- 工作台以普通 Windows 用户身份运行。每项任务从自己的工作目录启动独立的 Codex 进程，使用免管理员初始化的 MXC 和 `workspace-write` 执行本地命令。工作台单独在进程启动参数中选择 MXC。参见 [Codex Windows 沙箱](https://learn.chatgpt.com/docs/windows/windows-sandbox)。
- `config.json` 中的 `dataDir` 存放队列、运行日志和交付文件。每个任务的 `jobs/<ID>/workspace` 下有 `inputs`、`artifacts`；对应目录里的 `status.json` 和 `result.json` 给出状态、返回文本和实际文件路径。
- 自动 Codex 任务开始前通过 Clash 探测 ChatGPT 的账户接口，以不带凭据收到预期的 HTTP 401 确认接口可达。执行中每 30 秒统一复查。超过 2 秒或接口不可达时，通过 WorkBuddy 的本地任务运行器执行恢复，该命令不需要模型在线。只调整 **🧲 AI** 选择组，按配置的候选地区测速，逐个验证切换后的实际线路；都失败时回到原选项。并行任务共用正在进行的检查和恢复。
- Codex 在 `initialize`、`account/read` 或 `thread/start` 遇到工作区路由超时或连接故障时，工作台会记录请求名、耗时和错误，调用 WorkBuddy 尝试换线，并保留原任务 ID 重试启动一次。已发出 `turn/start` 的任务不会自动重放。结果中的 `startupFailures` 和 `network` 可用于核对启动故障、恢复执行方和线路验证结果。
- 入口断线时，尚未开工的自动任务以 `waiting_network` 状态等待重试，期间本地心跳继续。线路恢复后各自启动。如果已实际开始的 GPT 会话返回终止错误，保留原会话链接和状态，供核对后继续。参见 [CodeBuddy 本机任务接口](https://cloud.tencent.com/document/product/1831/137064)和 [Mihomo API](https://wiki.metacubex.one/en/api/)。
- 按需查询知识库时，GPT 写入带任务 ID 的查询。原派单 Agent 在等待期间可以接收并使用自己的授权知识库回答。要查另一端时，需要那一端已有运行中的会话调用技能处理对应请求。自动 Codex 任务关闭记忆写入设置，保留可查看的任务会话记录。参见 [Codex 记忆设置](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 技能和自检

- [GPT 技能](skills/gpt/gpt-workbench/SKILL.md)
- [WorkBuddy 技能](skills/workbuddy/gpt-workbench/SKILL.md)
- [Kimi 技能](skills/kimi/skills/kimi-gpt-workbench/SKILL.md)

在本目录的 PowerShell 中检查运行状态：

```powershell
node ./workbench.mjs doctor
node ./workbench.mjs workbuddy-check
node ./workbench.mjs status --id '<任务 ID>'
```

`doctor` 检查 ChatGPT 登录、监听器和当前 Clash 连接。`workbuddy-check` 请 WorkBuddy 执行一次只读代理检查，可验证本地派单路径。安装 Kimi Work 本地插件后，若应用已在运行，重启应用以加载插件。也可从 Kimi Work 的「技能」页上传本目录下的 Kimi `SKILL.md`。参见 [Kimi 技能导入说明](https://www.kimi.com/features/skills)。
