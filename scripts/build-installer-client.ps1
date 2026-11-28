# 打客户端的安装程序：一个 MSI，装到 Program Files，装时填 Seven Station Core 地址与令牌。
#
# 用法：
# powershell -File scripts/build-installer-client.ps1 # 编译 + 打包
# powershell -File scripts/build-installer-client.ps1 -SkipBuild # 用已有 release 产物
#
# 产物：dist/SevenStation-win-x64-<版本>.msi 与同名 .sha256
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$project = Join-Path $root "src/SevenStation.Desktop"
$installer = Join-Path $root "installer/client/SevenStation.wxs"
$buildDir = Join-Path $project "target/release"

$wix = Join-Path $env:USERPROFILE ".dotnet/tools/wix.exe"
if (-not (Test-Path $wix)) {
    throw "没找到 wix。装一下：dotnet tool install -g wix --version 5.0.2"
}

# 客户端是 Rust 项目，版本号在 Cargo.toml。
$cargo = Get-Content -Raw (Join-Path $project "Cargo.toml")
$match = [regex]::Match($cargo, '(?m)^version\s*=\s*"([^"]+)"')
if (-not $match.Success) { throw "找不到版本号：$project/Cargo.toml" }
$version = $match.Groups[1].Value.Trim()
Write-Host "版本 $version"

if (-not $SkipBuild) {
    # cargo 在 rustup 的 bin 下，别假设 PATH 里有。
    $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
    Push-Location $project
    try {
        cargo build --release
        if ($LASTEXITCODE -ne 0) { throw "客户端编译失败" }
    } finally {
        Pop-Location
    }
}

$exe = Join-Path $buildDir "SevenStation.exe"
if (-not (Test-Path $exe)) { throw "没有编译产物：$exe" }

New-Item -ItemType Directory -Force -Path $dist | Out-Null
# 与 Core 那边同理：MSI 只作 exe 的 payload，发布出去的是 setup.exe（图标可控）。
$msiDir = Join-Path $root "work/msi"
New-Item -ItemType Directory -Force -Path $msiDir | Out-Null
$license = Join-Path $root "installer/license.rtf"
$name = "SevenStation-win-x64-$version"
$msi = Join-Path $msiDir "$name.msi"
Remove-Item $msi -Force -ErrorAction SilentlyContinue
Remove-Item "$msi.wixpdb" -Force -ErrorAction SilentlyContinue

$setup = "SevenStation-Setup-$version"
$setupExe = Join-Path $dist "$setup.exe"
Remove-Item $setupExe -Force -ErrorAction SilentlyContinue
Remove-Item "$setupExe.sha256" -Force -ErrorAction SilentlyContinue

# dist 里只留当前版本的安装程序。
Get-ChildItem $dist -File | Where-Object {
    $_.Name -match '^SevenStation.*\.(msi|wixpdb|exe|sha256)$' -and $_.Name -notlike "*$version*"
} | Remove-Item -Force -ErrorAction SilentlyContinue

Push-Location (Split-Path -Parent $installer)
try {
    & $wix build (Split-Path -Leaf $installer) -arch x64 -o $msi `
        -ext WixToolset.UI.wixext `
        -ext WixToolset.Util.wixext `
        -d "Version=$version" -d "AssetsDir=$root/installer/assets" -d "IconFile=$root/src/SevenStation.Desktop/icons/icon.ico" -d "BuildDir=$buildDir" -d "LicenseRtf=$license"
    if ($LASTEXITCODE -ne 0) { throw "打包失败" }
} finally {
    Pop-Location
}

Push-Location (Split-Path -Parent $installer)
try {
    & $wix build Bundle.wxs -arch x64 -o $setupExe `
        -ext WixToolset.BootstrapperApplications.wixext `
        -d "Version=$version" -d "IconFile=$root/src/SevenStation.Desktop/icons/icon.ico" -d "MsiPath=$msi"
    if ($LASTEXITCODE -ne 0) { throw "打 exe 失败" }
} finally {
    Pop-Location
}
# wix 会在 exe 旁边留一份 .wixpdb 调试符号，发布面不要它。
Remove-Item ([System.IO.Path]::ChangeExtension($setupExe, '.wixpdb')) -Force -ErrorAction SilentlyContinue

$sha = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($setupExe)
try {
    $hash = ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
} finally {
    $stream.Dispose()
    $sha.Dispose()
}
[System.IO.File]::WriteAllText("$setupExe.sha256", "$hash $setup.exe`n")

$sizeMb = [math]::Round((Get-Item $setupExe).Length / 1MB, 1)
Write-Host "$setup.exe $sizeMb MB $($hash.Substring(0, 16))…"
Write-Host "产物在 $dist（MSI 在 $msiDir，只作中间产物）"
