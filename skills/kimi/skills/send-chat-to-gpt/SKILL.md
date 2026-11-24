---
name: send-chat-to-gpt
description: 把某个已有对话（chat）的完整上下文导出并发送给 GPT 工作台，让用户在 GPT 侧继续该对话。对话可能在本机 Kimi Work 历史里，也可能在 kimi.com 网页版（用户给出 kimi.com/chat/... 链接或本机找不到时）。触发语如「把 chat"XXX"的对话上下文发送到 GPT」「把那个对话发给 GPT，我在那边继续」「导出 XX 对话给 GPT」。也适用于定位/列出本机历史对话、把对话记录导出为 Markdown。提交、跟进、回传的细节遵循 gpt-workbench 技能。
---

# 发送对话上下文给 GPT

## 流程

### 1. 定位对话

本机对话用：

```bash
python "{skill_dir}/scripts/list_chats.py" --grep "用户说的标题关键词"
```

- 可用 `--home "<kimi-code home 目录>"` 指定包含 `sessions` 的目录，也可设置 `KIMI_CODE_HOME`。优先级为 `--home`、`KIMI_CODE_HOME`、Windows 的 `%APPDATA%/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home`。其他平台或自定义安装可显式指定目录。
- 输出每个对话的标题（取自 ctitle 记录）、首条用户消息、conv 目录，按时间倒序。
- `--grep` 同时匹配标题、首条消息和对话全文；关键词对不上标题时改用内容词重试。
- 用户给的标题与列表都不完全一致时，把最相关的候选（标题+首条消息）给用户确认后再继续，不要擅自猜。
- 不要向当前会话（用户正在说话的这条）发送，除非用户明确要的就是它。

### 1b. 对话在 kimi.com 网页版（用户给出 kimi.com/chat/... 链接，或本机列表全不匹配）

走 kimi-webbridge 技能（需要用户浏览器已装 Kimi 浏览器扩展并登录 kimi.com；未装则引导安装，装完由用户点一次「添加至浏览器」）：

0. **只有标题、没有链接时也能找**：`navigate` 到 `https://www.kimi.com/`，`evaluate` 读取 `document.querySelectorAll('a[href*="/chat/"]')` 的标题与 href，匹配用户给的标题得到对话链接。侧边栏默认只显示最近几十个，更早的对话翻 `/chat/history` 页。手机 App 的对话与网页版同账号云同步，同样走这条路。
1. `navigate` 打开对话 URL（Windows 下所有请求写 JSON 文件用 `curl.exe --data-binary @file` 发送）。若用户说「把我浏览器里正打开的这个对话发给 GPT」且未给链接：用 `find_tab`（`{"url":"kimi.com","active":true}`）借用用户当前标签页，`document.title` 确认是对话后直接进入本小节第 3 步。
2. 页面 `document.title` 确认是对话标题。对话消息节点是 `.segment.segment-user` / `.segment.segment-assistant`，列表是虚拟滚动，一次只渲染约 10 条。
3. 用 `evaluate` 执行滚动收集脚本 `scripts/extract_kimi_web.js`（读它取代码）：找到含 segment 的滚动容器，`scrollTop=0` 后逐步下滚收集、按「角色+前 100 字」去重，返回全部消息 JSON。结果 `-o` 存文件再解析。
4. 清理文本：去掉消息末尾的「复制 / 分享」等按钮行，assistant 开头的计划标题行可保留。按时间顺序写成本地 `chat_context.md`，每条消息以独占一行的 `## 用户` 或 `## Kimi` 开头，正文放在标题之后，然后进入第 2b 步。
5. 内置浏览器（InAppBrowser）没有用户登录态，读不了 kimi.com 对话，不要走那条路。

### 2. 导出上下文（本机对话）

```bash
python "{skill_dir}/scripts/extract_chat.py" "<conv目录>" -o "<当前工作区>/chat_context.md" --title "<对话标题>"
```

- 只保留真实用户提问和助手正文，自动过滤 think、工具调用、系统注入、技能加载文本；附件显示为 `[附件: 文件名]`。

### 3. 提交、跟进、回传

优先使用环境变量 `GPT_WORKBENCH_ENTRY` 指定的 `workbench.mjs` 绝对路径。从项目内加载本技能时，若未设置环境变量，从技能目录向上四级定位项目根目录，并检查其中是否存在 `workbench.mjs`。本机安装版可使用 `<工作台入口>`。下面的 `<工作台入口>` 均替换为解析后的路径，包含空格时保留引号。

```text
node "<工作台入口>" migrate --source kimi --title "<对话标题>" --context-file "<chat_context.md 绝对路径>"
node "<工作台入口>" follow --id "<任务 ID>" --seconds 45
node "<工作台入口>" delivery-report --id "<任务 ID>" --source kimi --state submitted
```

从当前 Kimi 会话的任务目录运行命令。工作台自动保留最近消息，上限为 8,000 字符。用户明确选择全量迁移时，可用 `submit --source kimi --title "<对话标题>" --prompt-file "<简短续接指令>" --input "<chat_context.md 绝对路径>"`。续接指令说明附件是历史资料，并让 GPT 确认接管后等待用户继续。用返回的同一任务 ID 跟进，每次 `follow` 的工具超时至少设为 65 秒。

用户要把该对话交给 WorkBuddy 入库时，改用 `ima-save --source kimi --title "<对话标题>" --input "<chat_context.md 绝对路径>"`，保留选中对话原文。

进度、终态和交付回执按同插件的 `kimi-gpt-workbench` 技能处理，回报 `chatLink`、模型和额度。上面的 `delivery-report` 示例仅在终态结果已由渠道明确受理后执行。完整交付流程需要支持 `delivery-report` 的工作台版本。
