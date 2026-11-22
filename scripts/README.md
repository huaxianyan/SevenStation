# 开发与验证脚本

这些脚本都只在本机用，不进发布产物。

## `dev-run.ps1`

杀掉正在跑的实例、构建、带调试端口启动。开发时每次都走它，省得手动记环境变量。

```powershell
pwsh -File scripts/dev-run.ps1
# 想隔离会话记录（不污染真实会话）时：
pwsh -File scripts/dev-run.ps1 -SessionDir work\smoke\sessions
```

启动后可以用 `scripts/ui-smoke.mjs` 连上去检查界面。

## `start-center.ps1` / `stop-center.ps1`

平时用这两个，不走 `dev-run.ps1`（那个会构建并开调试端口）。

```powershell
pwsh -File scripts/start-center.ps1 # 后台起来，不弹窗口
pwsh -File scripts/start-center.ps1 -Listen http://0.0.0.0:8787
pwsh -File scripts/stop-center.ps1
```

已经在跑就直接返回，不会起第二个。

## `install-autostart.ps1`

登录后自动把 Seven Station Core 拉起来（Windows 计划任务）。

```powershell
pwsh -File scripts/install-autostart.ps1 # 装上
pwsh -File scripts/install-autostart.ps1 -Status # 看现在什么状态
pwsh -File scripts/install-autostart.ps1 -Remove # 卸掉
```

## `ui-smoke.mjs`

用 CDP 驱动真实窗口跑一遍主链路：列表渲染 → 新建会话 → 发一条 prompt →
看到流式状态 → 收尾生效 → 正文非空。失败时打印页面异常并以非零码退出。

```bash
node scripts/ui-smoke.mjs --cwd work\smoke\ui-ws
```

前置条件：应用已经用 `--remote-debugging-port=9222` 启动（`dev-run.ps1` 会做）。
`--cwd` 指定新会话的工作目录，必须已存在。这个脚本会真的调用一次模型。
