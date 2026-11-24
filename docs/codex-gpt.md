# Codex / GPT 接入

## 安装与配置

安装 Windows 版 Codex 并登录 ChatGPT。安装 Node.js 24 或更新版本。从项目根目录把 `config.example.json` 复制为私有的 `config.json`。按本机情况填 Clash 配置文件路径、策略组和 WorkBuddy 恢复程序路径。桌面 CLI 在 PATH 时可留空 `codexExe`。设置 `GPT_WORKBENCH_ENTRY` 为本包 `workbench.mjs` 的绝对路径。

把 `skills/gpt/gpt-workbench` 复制到用户技能目录 `%USERPROFILE%/.agents/skills`，重新加载 Codex 聊天。使用 `node ./workbench.mjs doctor --check-session` 核对本机路由和账号登录。生产启动方式及数据目录见 README。

## 可复用提示词

> 用户明确要求派单时，将任务原文和授权附件交给 GPT 工作台。宿主若提供本条消息和会话的稳定标识，按接管协议处理。取得任务 ID 后等待结果，在来源聊天原样回传答复和文件。正在当前 GPT 会话执行的工作直接沿用本会话。

## 验证与更新

App Server 支持 `thread/start` 和 `thread/resume`。本包通过这两个接口为受控适配器创建和恢复目标会话。当前桌面 GPT/Codex Skill 可派单、查询和回传，尚未验证桌面 GPT 聊天能够把每条用户消息及其稳定事件 ID 自动交给本包，并将结果直接注入原聊天。已在 GPT 会话发出的后续消息由该聊天继续处理。

更新时停空本机队列，原位置替换源码和 Skill，保留私有配置及数据，重启已安装的监听器。执行 `doctor --check-session` 后从来源提交两个虚构消息，核对 `threadId`、上下文与产物。

[Codex App Server 文档](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
