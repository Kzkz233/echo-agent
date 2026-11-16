# 更新与恢复

[文档](README.md) / 更新与恢复

## 应用内更新

1. 打开 **设置 → 运行维护 → 版本与更新**。
2. 点击 **检查更新**，从 GitHub Releases 获取稳定版本。
3. 下载并暂存更新，保存编辑内容后点击 **重启并更新**。
4. 启动后核对桌面、前端与后端的版本和构建标识。

手动导入 `.echo-update` 文件也使用同一更新流程。界面会标明更新来自 GitHub 或本地文件。

## 下载文件

| Release 文件 | 用途 |
| --- | --- |
| `Echo-Agent_<版本>_x64-setup.exe` | 首次安装或使用安装程序升级 |
| `Echo-<版本>-public-win-x64.echo-update` | 在已安装的 Echo 中导入更新 |
| `Echo-<版本>-source.zip` | 对应该版本的项目源码 |
| `SHA256SUMS.txt` | 下载文件的 SHA-256 校验值 |

安装包内含桌面程序、后台运行时和命令行。模型凭据与外部服务由用户配置。更新包文件名中的 `public` 标记发布产物范围，所有安装使用同一套应用程序。

PowerShell 中可计算下载文件的校验值，与 `SHA256SUMS.txt` 对照。

```powershell
Get-FileHash '.\Echo-Agent_0.21.1_x64-setup.exe' -Algorithm SHA256
```

## 命令行更新

在 Echo 安装目录中执行下列命令。

```powershell
.\echo-agent.cmd update check
.\echo-agent.cmd update stage
.\echo-agent.cmd update apply
```

`update apply` 返回提交结果。重启后再次检查，完成状态应为 `journal.phase = complete`，桌面与后端构建应一致。

```powershell
.\echo-agent.cmd update status --json
.\echo-agent.cmd doctor --json
```

暂存本地包时，在 `update stage` 后提供文件路径。运行中的推理、消息投递或未保存编辑可能阻止重启，使用 `maintenance` 查看等待项。

[完整命令行指南](CLI.md)

## 数据与恢复

更新替换安装目录中的程序文件。角色、会话、任务、权限、知识库、外部 MCP 和自行安装的扩展保存在用户数据目录。更新前会保存主数据库快照，知识库内容按各自目录管理。

新版本需在限定时间内完成启动确认，并核对三个构建标识。启动失败或完整性检查失败时，更新器恢复上一版程序。当前用户数据继续保留。

设置页的 **准备回滚** 可使用上一版成功运行的程序。回滚需要满足数据格式兼容条件。上一版程序、失败候选和更新日志位于安装目录旁的更新目录，供故障恢复时核对。

完整备份与恢复见存储文档。

[存储与备份](STORAGE.md)
