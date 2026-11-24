# 千问办公接入

## 安装与配置

在支持本机 stdio MCP 的千问办公客户端，用 `qwenwork-connector.example.json` 安装「GPT 工作台」连接器。把示例参数替换为 `qwenwork-mcp.mjs` 的本机绝对路径。启用后应看到 `submit_gpt_task`、`follow_gpt_task`、`get_gpt_conversation` 和 `report_gpt_delivery`。

从技能页导入 `skills/qwenwork/gpt-workbench-qwenwork`，或复制至当前客户端实际激活的资料目录。本机 Windows 部署使用 `%LOCALAPPDATA%/Qianwen/User Data/qwen-agent/<当前配置目录>/skills`。配置目录应从本机已启用资料识别。

## 可复用提示词

> 用户明确说用 GPT 时调用 `submit_gpt_task` 并保留原文及附件。宿主提供稳定作用域、会话和事件标识时，首轮传 `takeover: true`。同会话后续消息沿用作用域和会话标识，每条传自己的事件 ID。沿着同一个工作台任务 ID 等待，并在原会话交付原始文字和附件。

## 验证与更新

本包的 stdio MCP 已提供有状态派单和查询接口。客户端启用后，先验证明确派单、按 ID 取回文件和交付回执。当前本机 MCP 配置使用工具调用参数，未验证千问办公桌面为连接器注入稳定消息 ID，也未验证连接器能订阅后续每条消息、阻止来源模型处理或主动向原聊天交付。

更新时替换 MCP 入口，同步 Skill，重启连接器并重开测试聊天。确认新工具可见，完成一次虚构派单和附件回传。受控宿主可另按接管协议验收无触发词的连续追问。

[千问办公连接器管理](https://www.alibabacloud.com/help/zh/qwenwork/connectors-management)
