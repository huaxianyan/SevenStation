# 打 Seven Station Core 的安装程序：一个 MSI，装文件、注册服务、开机自启。
#
# 用法：
# powershell -File scripts/build-installer-center.ps1 # 发布 + 打包
# powershell -File scripts/build-installer-center.ps1 -SkipPublish # 用已有 publish 输出
#
# 产物：dist/SevenStationCore-win-x64-<版本>.msi 与同名 .sha256
param(
    [switch]$SkipPublish
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$project = Join-Path $root "src/SevenStation.Core/SevenStation.Core.csproj"
$installer = Join-Path $root "installer/center/SevenStation.Core.wxs"
$publish = Join-Path $root "src/SevenStation.Core/bin/Release/net10.0/win-x64/publish"
$controlProject = Join-Path $root "src/SevenStation.Control"
$controlExe = Join-Path $controlProject "target/release/sevenstation-control.exe"
$assets = Join-Path $root "installer/assets"
# Seven Station Core 的 ARP 图标用 Seven Station Control 那枚（浅底），客户端的用深底，两个放一起才分得开
$iconFile = Join-Path $controlProject "icons/icon.ico"

# rustup 装的 cargo 不一定在当前会话的 PATH 里。
$cargoBin = Join-Path $env:USERPROFILE ".cargo/bin"
if (Test-Path $cargoBin) { $env:PATH = "$cargoBin;$env:PATH" }

# wix 是 dotnet 全局工具，别假设它在 PATH 里。
$wix = Join-Path $env:USERPROFILE ".dotnet/tools/wix.exe"
if (-not (Test-Path $wix)) {
    throw "没找到 wix。装一下：dotnet tool install -g wix --version 5.0.2"
}

$text = Get-Content -Raw $project
$match = [regex]::Match($text, '<Version>([^<]+)</Version>')
if (-not $match.Success) { throw "找不到版本号：$project" }
$version = $match.Groups[1].Value.Trim()
Write-Host "版本 $version"

# MSI 判断"要不要替换文件"看的是文件版本号：目标位置已有更高版本时它会直接跳过。
# 所以这个号必须随构建单调递增。以前用「秒数 % 60000」当第三段，会回绕——
# 0.4.0 出过 0.4.39632.0，0.4.1 回绕成 0.4.11411.0，升级时 exe 被判定为"更旧"而没替换，
# 组件却记成已安装，最后父目录里根本没有 SevenStation.Core.exe。
# 现在用「年 + 月日 + 时分」四段，各段都 ≤ 65535，时间越晚值越大，且大于历史上任何一个滚动数。
$now = Get-Date
$fileVersion = '0.{0}.{1}.{2}' -f ($now.Year % 100), $now.ToString('MMdd'), $now.ToString('HHmm')

if (-not $SkipPublish) {
    dotnet publish $project -c Release -r win-x64 --self-contained -o $publish -v q --nologo `
        -p:FileVersion=$fileVersion
    if ($LASTEXITCODE -ne 0) { throw "Seven Station Core 发布失败" }
}

if (-not (Test-Path $publish)) { throw "没有发布输出：$publish" }

# 装进 MSI 的只有 *.dll、*.json、wwwroot/**、Agents/**（见 wxs 的 CorePayload）。
# 以前漏列过 Agents，结果装好的机器上根本没有界面说明，规则一条都没注入，看着像「模型不听话」。
foreach ($needed in @('Agents\pi-guidance.md', 'Agents\sevenstation-guard.js')) {
    if (-not (Test-Path (Join-Path $publish $needed))) { throw "发布输出里缺 $needed（检查 csproj 的 Content 项）" }
}

# Seven Station Control 跟 Seven Station Core 装在一个包里（DECISIONS D9），这里顺手构建它。
Push-Location $controlProject
try {
    cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "Seven Station Control 构建失败" }
} finally {
    Pop-Location
}

if (-not (Test-Path $controlExe)) { throw "没有 Seven Station Control 产物：$controlExe" }
if (-not (Test-Path (Join-Path $assets "banner.bmp"))) {
    throw "没有安装画面位图，先跑 python design/make-installer-art.py"
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null
$license = Join-Path $root "installer/license.rtf"
$name = "SevenStationCore-win-x64-$version"
$msi = Join-Path $dist "$name.msi"
Remove-Item $msi -Force -ErrorAction SilentlyContinue
Remove-Item "$msi.sha256" -Force -ErrorAction SilentlyContinue
Remove-Item "$msi.wixpdb" -Force -ErrorAction SilentlyContinue

# dist 里只留当前版本的包：以前的老版本留着，装的时候很容易点错。
Get-ChildItem $dist -Filter "*-win-x64-*.msi*" | Where-Object { $_.Name -notlike "*$version*" } | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $dist -Filter "*-win-x64-*.wixpdb" | Where-Object { $_.Name -notlike "*$version*" } | Remove-Item -Force -ErrorAction SilentlyContinue

Push-Location (Split-Path -Parent $installer)
try {
    & $wix build (Split-Path -Leaf $installer) -arch x64 -o $msi `
        -ext WixToolset.UI.wixext `
        -ext WixToolset.Util.wixext `
        -d "Version=$version" -d "PublishDir=$publish" -d "LicenseRtf=$license" `
        -d "AssetsDir=$assets" -d "IconFile=$iconFile" -d "ControlExe=$controlExe"
    if ($LASTEXITCODE -ne 0) { throw "打包失败" }
} finally {
    Pop-Location
}

# 跟打包 zip 时同一个思路：自己算哈希，不依赖 Get-FileHash（这台机器的 5.1 里没有）。
$sha = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($msi)
try {
    $hash = ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
} finally {
    $stream.Dispose()
    $sha.Dispose()
}
[System.IO.File]::WriteAllText("$msi.sha256", "$hash $name.msi`n")

$sizeMb = [math]::Round((Get-Item $msi).Length / 1MB, 1)
Write-Host "$name.msi $sizeMb MB $($hash.Substring(0, 16))…"
Write-Host "产物在 $dist"
