# Echo Agent CLI

安装目录中的 `echo-agent.cmd` 使用桌面版同一个后端、角色、权限和会话，不另建 Agent。安装包包含运行环境。`--data-dir PATH` 指向数据入口目录，也可设置 `ECHO_DATA_DIR`。

```powershell
.\echo-agent.cmd status --json
.\echo-agent.cmd doctor --json
.\echo-agent.cmd app start
.\echo-agent.cmd roles
.\echo-agent.cmd tasks
.\echo-agent.cmd chat --role ROLE_ID "检查当前计划" --stream-json
.\echo-agent.cmd task run review.policies TASK_ID --request-id RUN_ID --wait
```

`status`、`doctor` 区分 CLI、桌面和后端构建；应用未启动时仍显示数据位置和安装路径。`plugins`、`models`、`mcp`、`logs` 提供只读诊断，不返回凭据。

`chat` 默认等待完成，支持 `--conversation ID`、`--attach PATH`（可重复）和标准输入 `-`。附件沿用桌面通用附件层：图片上限 8 MB，文本上限 256 KB；不是知识库大文件导入。`--stream-json` 输出实际送达的聊天消息和最终执行结果；`--no-wait` 只返回受理回执，之后用 `chat-status REQUEST_ID` 查询。审批仍在桌面处理，CLI 不扩大权限。

`task run TYPE ID` 触发已有自动化任务。`--wait` 使用任务插件贡献的执行回执；不支持跟踪的任务明确返回 `tracking: false`，受理不等同于完成。用固定的 `--request-id` 核对同一次提交，避免重复触发。

```powershell
.\echo-agent.cmd jobs list --json
.\echo-agent.cmd jobs show PROVIDER/JOB_ID
.\echo-agent.cmd jobs watch PROVIDER/JOB_ID --stream-json
.\echo-agent.cmd jobs pause PROVIDER/JOB_ID
.\echo-agent.cmd jobs resume PROVIDER/JOB_ID
```

任务列表投影现有会话、导入、记忆整理和索引任务，没有第二套调度器。暂停、续跑、取消只在来源插件声明支持时可用；卸载插件会撤销对应控制接口。`commands` 列出插件注册的额外命令，`command ID --input FILE` 调用其受权限约束的公开操作。

```powershell
.\echo-agent.cmd knowledge vaults
.\echo-agent.cmd knowledge import "D:\Materials\lecture.mp4" --vault LIBRARY_ID --folder Courses
.\echo-agent.cmd knowledge search "检索内容" --vault LIBRARY_ID --strategy hybrid
.\echo-agent.cmd knowledge inspect ENTRY_ID --vault LIBRARY_ID
.\echo-agent.cmd knowledge pipeline show
.\echo-agent.cmd knowledge migrate plan --vault LIBRARY_ID
.\echo-agent.cmd knowledge migrate apply PLAN_ID --request-id MIGRATION_ID
.\echo-agent.cmd knowledge migrate status
```

`pipeline save --input FILE` 保存统一入库配置，不自动重跑全库。`migrate plan` 默认复用已有正文、转录和附件；加 `--reparse` 才检查需要更新的解析设置。迁移可 `pause`、`resume ID`；`rollback ID` 恢复索引绑定，不回退正文编辑。发生版本冲突时保留旧索引，重新预览后再执行。

```powershell
.\echo-agent.cmd update check
.\echo-agent.cmd update stage "D:\Downloads\Echo.echo-update"
.\echo-agent.cmd update apply
.\echo-agent.cmd app restart
```

`update check` 查询 GitHub Releases；`stage` 不带路径时下载已检查到的 GitHub 更新，带路径时暂存本地安装包。两种来源在桌面明确区分。`update status` 查看构建和回滚状态，`update rollback` 准备上一版程序。`apply` 提交更新请求后立即退出 CLI，避免锁住要替换的运行环境。

更新可全程通过 CLI 完成：先 `update stage PATH`，再 `update apply`，最后重新调用 `update status --json` 核对桌面/后端构建一致且 `journal.phase` 为 `complete`。`maintenance` 显示正在等待的安全点和未保存编辑；不会绕过这些阻塞。后端暂时离线时，`update status` 仍可读取安装版本和落盘的更新、回滚回执，并明确返回 `backend: unavailable`，不会将“已受理”误认为“安装成功”。

重启、退出和更新由桌面宿主执行。后端先暂停新任务，等待未保存编辑、推理和消息投递到达安全点；能安全暂停的导入和索引会保存进度，启动确认完成后续跑。`app cancel` 取消等待并恢复调度。等待超时会保留当前进程和数据，不直接强杀任务。

`--json` 输出单个 JSON；`--stream-json` 输出 JSONL。等待超时不会终止后台任务，错误回执保留请求编号。失败、取消、待核对状态返回非零退出码。
