# 给 .msi（ProgID: Msi.Package）的右键菜单加两项：
#   「复制文件」      —— 把文件放进剪贴板，可以直接粘到聊天窗口或别的目录
#   「打开文件所在目录」—— 在资源管理器里选中这个文件打开
# 只写 HKCU，不需要管理员，也不改安装包本身的注册。
# 卸载：删掉 HKCU\Software\Classes\Msi.Package 即可（这个键默认不存在）。

$ErrorActionPreference = 'Stop'

$script = Join-Path $env:LOCALAPPDATA 'SevenStation\tools\copy-file.ps1'
if (-not (Test-Path -LiteralPath $script)) {
    throw "找不到复制脚本：$script"
}

$shell = 'HKCU:\Software\Classes\Msi.Package\shell'

# 复制文件
$copy = Join-Path $shell 'SevenStationCopyFile'
New-Item -Path $copy -Force | Out-Null
Set-ItemProperty -Path $copy -Name '(default)' -Value '复制文件'
Set-ItemProperty -Path $copy -Name 'Position' -Value 'Top'
New-Item -Path (Join-Path $copy 'command') -Force | Out-Null
Set-ItemProperty -Path (Join-Path $copy 'command') -Name '(default)' `
    -Value ('powershell.exe -NoProfile -WindowStyle Hidden -File "' + $script + '" "%1"')

# 打开文件所在目录
$reveal = Join-Path $shell 'SevenStationRevealFile'
New-Item -Path $reveal -Force | Out-Null
Set-ItemProperty -Path $reveal -Name '(default)' -Value '打开文件所在目录'
Set-ItemProperty -Path $reveal -Name 'Position' -Value 'Top'
New-Item -Path (Join-Path $reveal 'command') -Force | Out-Null
Set-ItemProperty -Path (Join-Path $reveal 'command') -Name '(default)' -Value 'explorer.exe /select,"%1"'

Write-Output '已注册：'
Get-ChildItem $shell | ForEach-Object {
    $name = (Get-ItemProperty $_.PSPath).'(default)'
    $cmd = (Get-ItemProperty (Join-Path $_.PSPath 'command') -ErrorAction SilentlyContinue).'(default)'
    '{0}  ->  {1}  ::  {2}' -f $_.PSChildName, $name, $cmd
}
