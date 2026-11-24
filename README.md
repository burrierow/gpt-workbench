# GPT 工作台

GPT 工作台在 Windows 上运行。WorkBuddy、Kimi Work、千问办公和本机 Codex 可通过各自入口提交任务。工作台使用 Codex App Server 和现有 ChatGPT 登录执行任务。每条消息有独立工作目录、回执及产物。

## 安装

安装 Node.js 24 或更新版本、Codex 和 Python 3。将 `config.example.json` 复制为私有的 `config.json`，填写本机代理、数据目录与可选 WorkBuddy 恢复设置。用 `node ./workbench.mjs doctor --check-session` 检查配置。测试可运行 `node ./workbench.mjs serve`。常驻部署可以给当前 Windows 用户设置登录触发项，以本机 `pythonw.exe` 运行 `Start-Workbench.pyw`，并传系统 PowerShell 可执行文件路径。

使用 [同会话接管](docs/conversation-relay.md) 的宿主可持续把真实用户消息转给首轮 GPT 会话。查看 [Codex / GPT](docs/codex-gpt.md)、[WorkBuddy](docs/workbuddy.md)、[Kimi Work](docs/kimi.md) 和 [千问办公](docs/qwenwork.md) 的配置、提示词及验证范围。

## 从手机使用

从已连接电脑的 WorkBuddy 助理或 Kimi Work 远程会话发送：

> 用GPT。根据我附的文件提取三个要点，生成一份 Markdown。

固定触发语中的 GPT 大小写不限。

新任务默认使用 **GPT-6.2 Sol + Medium**。单笔任务可在开头写「用 GPT-6.2 Astra + High。帮我……」，也可以先写「用GPT」，再分行填写「模型：GPT-6.2 Astra」和「推理强度：High」。两项可以分别覆盖。命令行调用 `submit` 时，`--model` 和 `--effort` 优先于提示词开头的设置。

单次明确派单仍分配独立的任务 ID。接管模式下，同一来源会话的消息按收件顺序执行，独立来源会话可以并行。

派单 Agent 用工作台技能提交任务，并通过原渠道回复文字和附件。渠道需要支持回传本机文件。查询或恢复跟进时，把工作台任务 ID 发给原派单 Agent。

WorkBuddy 和 Kimi 回传每笔任务的终态时，会附上当前 Codex 账号 5 小时和一周窗口的剩余百分比。自动任务随终态回执提供 `quota`。较早的任务可以用 `quota` 命令补查当前值。额度暂无法读取时，任务结果和附件照常交付。

所有新任务都自动派发。手机说「用 GPT 工作模式」时，工作台采用当前可自动启动的桌面 Codex，并回报请求模式和实际模式。旧 Work 队列中的待领取任务会沿用原 ID 自动开始。已开始的旧 Work 会话继续原任务。工作台新任务使用「【派单 Agent】会话标题」，来源前缀为「【wb】」「【Kimi】」「【千问办公】」或「【GPT】」。工作台优先用派单时提供的会话标题，缺省时用首行任务正文。Codex 会话使用客户端默认标题。外部 Agent 派单时会保存「GPT 工作台」分组归属，桌面侧栏的分组刷新可能滞后。任务状态包含会话链接。参见 [ChatGPT 与 Codex 的桌面入口](https://learn.chatgpt.com/docs/use-chatgpt)。

`status` 和 `wait` 的 `execution` 会列出当前状态、会话模式、是否运行、模型和推理强度。只有 Codex 确认回合已启动，才标记为正在运行。模型与强度取自 Codex 的会话配置。Work 模式可用 `work-report --id ID --model "当前模型" --effort "当前推理强度"` 回报可确认的参数，未上报的值为 null。心跳反映工作台在线。

每次心跳可携带最近的公开任务进度，例如计划步骤、检索、工具调用和文件更新。`wait --id ID --seconds 60 --after-state submitted --after-progress 0` 会在阶段或进度变化时提前返回。将最新的 `state` 和 `progress.sequence` 传进下一次等待，终态照常返回。新任务收件后各自检查线路并启动独立会话，可以同时执行。一笔任务的结束或失败只关闭该笔任务的会话进程。进度采集使用 Codex 事件，不额外请求模型。

WorkBuddy 用 `follow --id ID --seconds 30`，Kimi 用 `follow --id ID --seconds 45`。进行中的公开进度随这一轮等待回传，终态和知识库请求可以提前返回。终态同时返回结果、Codex 额度和附件路径。WorkBuddy 使用 `present_files` 直传原产物。在 Kimi 本机任务目录运行时，工作台把产物准备在该会话下的 `gpt-results-<ID>`。

## Windows 上的运行位置

- 任务计划程序中的 **GPT Workbench Listener** 在当前 Windows 用户登录时通过 `pythonw.exe` 和 `Start-Workbench.pyw` 无控制台启动。进程空闲时监听文件事件，每 10 秒补扫并更新运行状态。派单端执行等待命令时，会回应心跳。电脑开机和手机远程连接仍依赖各自桌面应用的正常登录。
- 看门狗在监听器退出或健康记录停止更新 60 秒时自动启动新的监听器。恢复记录保存在工作台数据目录的 `watchdog.log`，健康记录保存在 `listener-health.json`。
- GPT 任务连续 5 分钟没有有效进展或网络不可达时，工作台中断该任务。公开输出、工具活动和计划推进会更新进展时间。普通心跳和重连通知只用于状态反馈。来源 Agent 的 `follow` 会立即收到 `interrupted`、具体原因和已有会话链接，并结束对该 ID 的等待。
- 工作台以普通 Windows 用户身份运行。每项任务从自己的工作目录启动独立的 Codex 进程，使用免管理员初始化的 MXC 和 `workspace-write` 执行本地命令。工作台单独在进程启动参数中选择 MXC。参见 [Codex Windows 沙箱](https://learn.chatgpt.com/docs/windows/windows-sandbox)。
- `config.json` 中的 `dataDir` 存放队列、运行日志和交付文件。每个任务的 `jobs/<ID>/workspace` 下有 `inputs`、`artifacts`；对应目录里的 `status.json` 和 `result.json` 给出状态、返回文本和实际文件路径。
- 自动 Codex 任务开始前通过 Clash 探测 ChatGPT 的账户接口，以不带凭据收到预期的 HTTP 401 确认接口可达。执行中每 30 秒复查。线路过慢或不可达时通过 WorkBuddy 的本地任务运行器执行恢复。恢复程序只调整 `clash.group` 指定的策略组，并逐个验证候选线路。验证均失败时恢复原选项。并行任务共用正在进行的检查和恢复。只需探测线路时可设置 `networkRecovery: false`。
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

`doctor` 检查 ChatGPT 登录、监听器和当前 Clash 连接。`workbuddy-check` 请 WorkBuddy 执行一次只读代理检查，可验证本地派单路径。安装 Kimi Work 本地插件后重启客户端加载。也可从 Kimi Work 的「技能」页上传本目录下的 Kimi `SKILL.md`。参见 [Kimi 技能导入说明](https://www.kimi.com/features/skills)。

运行 `node ./workbench.mjs doctor --check-session` 可通过任务使用的代理检查创建临时 Codex 会话。诊断分别返回线路探测、登录和会话检查。任务状态的 `startupStep` 和 `startupChecks` 会记录初始化、登录、创建会话和开工确认各步骤的状态与耗时。监听器重启时会恢复已经落盘的结果，并保留已经开工的任务会话链接。

跨渠道回传后，由原渠道运行 `node ./workbench.mjs delivery-report --id ID --source workbuddy --state submitted`。Kimi 使用 `--source kimi`。渠道明确受理后可记为 `submitted`，用户确认收到后记为 `confirmed`，准备或发送失败记为 `failed` 并通过 `--reply-file` 提供原因。没有可核实的回执时显示 `pending`。用 `status` 查询回传状态，用原 ID 重新调用 `follow` 取出原成品补发。

周报试用的任务文案、虚构附件和记录方法见 [周报试用](周报试用.md)。

「GPT 工作台」按会话创建时间从新到旧显示。联调、验收和自动测试通过 `submit --diagnostic` 创建临时会话，任务状态和产物仍可按任务 ID 查阅。

## 同步各端技能和迁移对话

`skills/` 保存各端的工作台技能。已有同步安装可保留私有 `skill-targets.json`，运行 `pwsh -File ./Sync-AgentSkills.ps1` 同步并校验四端，同时刷新 Kimi 原生插件。新安装可按各客户端文档导入。

已有对话迁移使用 `migrate --source 来源 --title "原会话标题" --context-file "对话文件"`。千问办公对应 `migrate_gpt_chat`。工作台把最近最多 8,000 字符作为历史附件送入新的 GPT 会话。把选定的会话原文交给 WorkBuddy 入库仍使用 `ima-save`，千问办公对应 `send_to_workbuddy_ima`。

## 跨 Agent 转存到 ima

```text
Kimi / 千问办公 / GPT → ima-save → 本地转存队列 → WorkBuddy 领取 → ima 上传和入库
                         ↑                 ← ima-finish 写回入库回执 ←─┘
```

每笔转存为 `ima.store`，执行方为 WorkBuddy。队列保留来源、可选原会话或 GPT 任务 ID、目标库、标题、独立文件副本和 SHA-256。同一个库名与文件内容的重复转发返回原转存 ID。领取及回执采用原子提交，避免两个 WorkBuddy 会话重复处理。提交和实际入库分别显示为 `queued` 和 `stored`。

在 Kimi 原会话可以说「语音转写文字，存到 ima」。可在私有配置的 `kimiImaLibrary` 中设置默认目标库。Kimi 原样转发选中的稿件。在 WorkBuddy 会话调用「处理 ima 转存队列」，WorkBuddy 使用已有 ima 连接器，完成后回写库 ID 和条目 ID。用 `ima-status --id 转存ID` 查结果。

## 制作发布包

从项目根目录运行 `pwsh -File ./Build-Release.ps1`。脚本使用固定文件清单、顺序和 ZIP 时间戳，输出压缩包及 SHA-256。运行 `node --test tests/relay.test.mjs` 验证本地流程。
