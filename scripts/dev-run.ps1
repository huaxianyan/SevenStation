# 起 SevenStation.Core（Seven Station Core）+ Seven Station 桌面客户端。
#
# 用法：
# pwsh -File scripts/dev-run.ps1
# pwsh -File scripts/dev-run.ps1 -SessionDir work\smoke\sessions
# pwsh -File scripts/dev-run.ps1 -Listen http://0.0.0.0:8787 # 给局域网里的别的设备连
param(
    [string]$SessionDir = "",
    [string]$Listen = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

$serverProject = Join-Path $root "src/SevenStation.Core/SevenStation.Core.csproj"
$desktopProject = Join-Path $root "src/SevenStation.Desktop"
$serverExe = Join-Path $root "src/SevenStation.Core/bin/Debug/net10.0/SevenStation.Core.exe"
$desktopExe = Join-Path $root "src/SevenStation.Desktop/target/debug/SevenStation.exe"
$logDir = Join-Path $env:LOCALAPPDATA "SevenStation/logs"

# rustup 装的工具不一定在当前会话的 PATH 里。
$cargoBin = Join-Path $env:USERPROFILE ".cargo/bin"
if (Test-Path $cargoBin) { $env:PATH = "$cargoBin;$env:PATH" }

Get-Process SevenStation, SevenStation.Core -ErrorAction SilentlyContinue | Stop-Process -Force
# 强杀主进程后 WebView2 的浏览器进程会留下来占着缓存目录，客户端就打不开了。
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
    Where-Object { $_.CommandLine -like '*SevenStation*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400

dotnet build $serverProject -v q --nologo
if ($LASTEXITCODE -ne 0) { throw "SevenStation.Core 构建失败" }

Push-Location $desktopProject
try {
    cargo build
    if ($LASTEXITCODE -ne 0) { throw "客户端构建失败" }
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
if ($SessionDir) {
    New-Item -ItemType Directory -Force -Path $SessionDir | Out-Null
    $env:PI_CODING_AGENT_SESSION_DIR = $SessionDir
    Write-Host "会话目录：$SessionDir"
}
if ($Listen) { $env:SEVENSTATION_LISTEN = $Listen }
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"

# Seven Station Core 的启动地址印在 center.out.log 里，里面带访问令牌。
Start-Process -FilePath $serverExe -WorkingDirectory (Split-Path $serverExe) `
    -RedirectStandardOutput (Join-Path $logDir "center.out.log") `
    -RedirectStandardError (Join-Path $logDir "center.err.log") | Out-Null

$probe = if ($Listen) { $Listen.Replace("0.0.0.0", "127.0.0.1") } else { "http://127.0.0.1:8787" }
for ($i = 0; $i -lt 60; $i++) {
    try {
        Invoke-WebRequest "$probe/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
        break
    } catch {
        Start-Sleep -Milliseconds 500
    }
}

Start-Process -FilePath $desktopExe -WorkingDirectory $desktopProject `
    -RedirectStandardOutput (Join-Path $logDir "desktop.out.log") `
    -RedirectStandardError (Join-Path $logDir "desktop.err.log") | Out-Null
Write-Host "Seven Station Core：$probe"
# Seven Station Core 按 D7 搬到机器级目录，开发时也一样；下面这几行告诉你去哪看令牌和日志。
$coreHome = Join-Path $env:ProgramData "SevenStation.Core"
Write-Host "令牌：$(Join-Path $coreHome 'token.txt')"
Write-Host "Seven Station Core 日志：$(Join-Path $coreHome 'logs/center.log')"
Write-Host "客户端日志：$logDir"
