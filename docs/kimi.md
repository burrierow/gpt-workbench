# Kimi Work 接入

## 安装与配置

部署在能够读写工作台本机文件的 Kimi Work。可在技能页上传 `skills/kimi/skills/kimi-gpt-workbench/SKILL.md` 和打包后的 `send-chat-to-gpt` 技能。已有本机插件部署可用 `skills/kimi` 中的原生插件，在当前安装使用的导入入口安装或运行已配置的 `Sync-AgentSkills.ps1`。本机 Windows 技能目录曾使用 `%APPDATA%/kimi-desktop/daimon-share/daimon/skills`。设置 `GPT_WORKBENCH_ENTRY` 并重启客户端。需要固定的 ima 个人目标库时，在私有配置填写 `kimiImaLibrary`。

## 可复用提示词

> 用户说「用GPT」时原样提交该条消息及获授权文件。有宿主提供的稳定作用域、会话和事件 ID 时，首轮申请接管，随后用原会话标识转发每条用户消息。按任务 ID 等待，原样回传 GPT 答复和附件。用户指定迁移某段历史时，只传其选定的内容。

## 验证与更新

本包保留明确派单、历史迁移、等待和原聊天附件暂存。历史迁移 Skill 能定位已选定的 Kimi Code 历史会话。Kimi Code 文档公开了带会话 ID 的 `UserPromptSubmit`、排队事件及阻断 Kimi 模型的能力。当前 Kimi Work 本地插件仅配置技能入口，尚未验证其桌面和手机远程聊天向本插件传递每条消息、稳定消息 ID，并允许插件直接异步回传原答复和附件。

更新时重新导入对应 Skill 或原生插件，重启后从同一远程聊天派发虚构任务，核对 `follow` 结果和原聊天附件。只有宿主能提供全部接管条件时，才启用无触发词续接。

[Kimi 插件](https://www.kimi.com/help/plugins-and-skills/overview) · [Kimi Code Hooks](https://www.kimi.com/code/docs/kimi-code-cli/customization/hooks.html)
