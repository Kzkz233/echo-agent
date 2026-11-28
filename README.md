<p align="center">
  <img src="apps/desktop/icons/icon.png" width="80" height="80" alt="Echo 标志">
</p>

<h1 align="center">Echo Agent</h1>

<p align="center">有记忆、能协作的桌面 AI 伙伴。</p>

<p align="center">
  <a href="https://github.com/Kzkz233/echo-agent/releases/latest">下载 Windows 版</a> ·
  <a href="docs/GETTING-STARTED.md">快速开始</a> ·
  <a href="docs/README.md">文档</a> ·
  <a href="https://github.com/Kzkz233/echo-agent/releases">更新日志</a>
</p>

<p align="center">
  <a href="https://github.com/Kzkz233/echo-agent/releases/latest"><img src="https://img.shields.io/github/v/release/Kzkz233/echo-agent?label=release&amp;color=242931" alt="最新版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-242931" alt="Apache 2.0"></a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/chat-dark.png">
  <img src="docs/screenshots/chat-light.png" alt="Echo 聊天界面，展示示例伙伴 Aria 的连续对话" width="1100">
</picture>

Echo 是一款开源的 Windows 桌面应用。你可以和 AI 伙伴聊天，请她查资料，也可以把需要持续跟进的事交给她。每位伙伴都有自己的记忆。你为她选择模型，也决定她能使用哪些工具。

## 核心能力

- **聊天** — 在电脑上和伙伴聊到一半，出门可以在绑定的 QQ 上接着聊。你可以分别设置她在 Echo 和 QQ 上的说话风格。
- **知识与记忆** — 把文档或音视频放进知识库，用关键词或按大意找原文。伙伴还可以定期整理你们聊过的约定。
- **任务** — 把一项工作交给子任务，或设定每周要做的事。在任务页查看进度、处理审批，并选择在哪里收结果。
- **桌宠** — 让伙伴出现在桌面上，用气泡和她聊天。实时观察可单独开启，由你指定允许观察的范围。
- **扩展** — 开发者可以用插件添加工具、页面和自动化任务。已有的 MCP 服务也可以接入 Echo，再授权给需要它的伙伴。

## 安装与开始

1. 下载最新 Release 中的 **Windows x64 安装程序**，文件名以 `_x64-setup.exe` 结尾。
2. 在欢迎页选择先和 Aria 还是 Coda 聊，点击 **开始聊天**。
3. 连接支持工具调用的语言模型。首次设置完成后，两位伙伴都会出现在侧栏。模型也可以在 **设置 → 模型服务** 中管理。

安装程序会检测 WebView2，缺失时引导安装。Aria 和 Coda 各有自己的桌宠和八张聊天表情。从 0.22.15 起提供这两位初始伙伴。

[安装与首次配置](docs/GETTING-STARTED.md) · [更新与恢复](docs/UPDATES.md)

## 文档

| 使用 Echo | 开发与扩展 |
| --- | --- |
| [伙伴、记忆与群聊](docs/CHARACTERS.md) | [应用架构](docs/ARCHITECTURE.md) |
| [任务与自动化](docs/FEATURES.md#任务与自动化) | [插件开发](docs/PLUGINS.md) |
| [知识库与音视频](docs/FEATURES.md#知识库与音视频) | [独立扩展](docs/independent-extensions.md) |
| [模型服务](docs/INFERENCE.md) | [界面与主题](docs/DESIGN-SYSTEM.md) |
| [命令行](docs/CLI.md) | [贡献指南](CONTRIBUTING.md) |

[浏览全部文档](docs/README.md)

## 数据与权限

伙伴、会话和知识库默认存放在本机。连接在线模型、文档解析或消息服务后，请求所需内容会发送给相应服务。工具和工作目录按伙伴授权，屏幕观察默认关闭，核心记忆变更需要审批。

[数据存储](docs/STORAGE.md) · [隐私说明](docs/PRIVACY.md) · [安全说明](SECURITY.md)

## 参与项目

欢迎提交问题、文档改进和代码贡献。报告问题时，请附版本、复现步骤及经过脱敏的日志。开发环境和验证方法见贡献指南。

[问题反馈](https://github.com/Kzkz233/echo-agent/issues) · [贡献指南](CONTRIBUTING.md)

## 许可证

Echo 原创代码以及 Aria 和 Coda 的头像、全身图、桌宠和表情采用 Apache-2.0 许可。[许可证](LICENSE) · [伙伴美术署名](apps/workbench/public/assets/starter-characters/CREDITS.txt) · [第三方声明](THIRD_PARTY_NOTICES.md)
