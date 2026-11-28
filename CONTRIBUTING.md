# 贡献指南

[项目首页](README.md) · [开发文档](docs/README.md#架构与接口)

## 报告问题

请提供应用版本、操作系统、复现步骤、预期结果和实际结果。界面问题可附脱敏截图，运行问题可附相关错误和请求编号。凭据、伙伴私有提示词、聊天记录及本机资料应从附件中移除。

[提交 Issue](https://github.com/Kzkz233/echo-agent/issues) · [安全说明](SECURITY.md)

## 开发环境

| 依赖 | 用途 |
| --- | --- |
| Node.js 24+ | 后端、脚本和测试 |
| pnpm | 使用 package.json 中指定的版本安装依赖 |
| Rust stable 与 MSVC C++ 构建工具 | Windows 桌面壳与原生组件 |
| WebView2 | Windows 桌面界面 |

```powershell
pnpm install --frozen-lockfile
pnpm verify
```

为开发实例指定独立数据目录。以下命令在 PowerShell 中运行。

```powershell
$env:ECHO_DATA_DIR = Join-Path $env:TEMP 'Echo-dev'
pnpm build
pnpm dev
```

后端启动后输出本机地址。连接页面使用该数据目录下 connection.json 的地址与令牌。开发前端可在第二个终端执行 `pnpm web`，默认地址为 `http://127.0.0.1:5173`。

构建 Windows 安装包

```powershell
pnpm desktop:build
```

## 代码结构

| 目录 | 职责 |
| --- | --- |
| apps/server | 应用组装、HTTP 与 CLI 入口 |
| apps/workbench | React 工作台、共享样式和导航 |
| apps/desktop | Tauri 桌面壳与窗口管理 |
| packages/contracts | 数据和接口约定 |
| packages/kernel | 存储、授权、调度、会话与扩展注册 |
| packages/backends | Agent 和执行器适配 |
| plugins | 内置功能插件 |
| native | Windows 采集与桌宠组件 |
| examples | 独立扩展示例 |
| tests | 隔离测试与合成服务 |

## 实现约定

- 通过类型化操作和扩展接口调用其他模块，依赖保持无环。
- 插件停用时释放定时器、订阅、进程和 worker。
- 会话历史由 Echo 管理，保存原生工具调用与结果。未知执行结果需要核对后处理。
- 测试使用临时数据和本机合成模型服务。真实模型调用与外部消息测试需要明确配置。
- 示例使用虚构身份和材料。新增依赖与素材时补充许可证及来源。

[应用架构](docs/ARCHITECTURE.md) · [插件接口](docs/PLUGINS.md)

## 验证

提交前运行 `pnpm verify`，覆盖类型、翻译、测试和生产构建。根据修改范围补充对应检查。

| 修改范围 | 补充检查 |
| --- | --- |
| 桌面壳 | `cargo test --manifest-path apps/desktop/Cargo.toml` 与桌面构建 |
| 原生组件 | `cargo test --manifest-path native/Cargo.toml` 与桌面构建 |
| 界面 | 对应 UI smoke 脚本，以及深浅色和窄窗口检查 |
| 插件 | 启用、停用、依赖缺失与配置保留 |
| 文档 | 链接、命令、界面名称和 Markdown 渲染 |

## 提交变更

Pull Request 说明要解决的问题、完成后的行为和验证结果。涉及界面时附对比截图，涉及数据格式时说明迁移与恢复。文档修改遵循项目文档规范。

原创代码贡献按 Apache-2.0 发布。第三方代码和素材保留原许可证。

[文档规范](docs/DOCUMENTATION.md) · [发布规范](docs/RELEASING.md) · [第三方声明](THIRD_PARTY_NOTICES.md)
