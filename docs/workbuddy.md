# WorkBuddy 接入

## 安装与配置

使用能够访问工作台电脑的 WorkBuddy 桌面或已连接的助理。把 `skills/workbuddy/gpt-workbench` 安装到当前版本使用的技能目录。本机 Windows 部署验证过 `%USERPROFILE%/.workbuddy/skills`。让宿主进程继承 `GPT_WORKBENCH_ENTRY`，并在新聊天里确认工作台技能可用。只有配置 WorkBuddy 线路恢复时，才需在私有 `config.json` 中配置它的桌面程序、CLI 和 Git Bash。

## 可复用提示词

> 用户明确要求用 GPT 时，提交其消息原文和获授权的附件。如果宿主提供稳定账号或工作区、会话和消息标识，首条用接管模式，之后在同一会话收到的用户消息逐条转发。根据原任务 ID 等待并原样回复，将文件通过本会话的附件能力交付。没有宿主标识时处理明确派单并告知自动接管范围。

## 验证与更新

本机捆绑的 CLI 可使用 `--session-id` 或 `--resume`。企业 ACP 文档列出由受控客户端可用的用户消息 ID。现有工作台 Skill 通过本地命令执行，并用 `present_files` 在正在处理该任务的来源会话上传文件。尚未验证 WorkBuddy 桌面或现有远程助理向 Skill 传递每条原始用户事件并绕过本地模型回复，或者在来源回合结束后主动发送原答复和附件。

升级时更新 Skill 后重开测试聊天。执行一次明确派单，按原 ID 检查终态、原文、本地文件和实际回执。接入受控宿主时，再验证两个独立聊天和无触发词的后续事件。

[WorkBuddy ACP 扩展](https://cloud.tencent.com/document/product/1831/137025)
