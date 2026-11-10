# Echo Agent 命令行

启动 Echo Agent 后，在 PowerShell 中运行安装目录里的 `echo-agent.cmd`。命令使用桌面版已有的角色、会话和任务。安装包内置运行环境。

```powershell
.\echo-agent.cmd doctor --json
.\echo-agent.cmd roles
.\echo-agent.cmd tasks
.\echo-agent.cmd task run review.policies TASK_ID --wait
.\echo-agent.cmd chat --role ROLE_ID "帮我检查当前计划"
```

`tasks` 列出任务类型和任务编号。用 `task status TYPE ID` 查看任务近况。运行记忆整理时可加 `--wait`，或用 `task status TYPE ID --request-id REQUEST_ID` 查询该次整理。其他任务的提交回执表示请求已受理。

`chat` 默认等待回复。加 `--no-wait` 可取得请求编号，再用 `chat-status REQUEST_ID` 查询。脚本可以自带 `--request-id` 标识同一个会话提交。CLI 等待超时后，后台运行仍可继续。结果失败或待核对时，CLI 返回非零退出码。

`--json` 输出机器可读的结果。数据放在自定义位置时，可用 `--data-dir PATH` 或设置 `ECHO_DATA_DIR`。工具权限沿用目标会话，审批在桌面工作台完成。
