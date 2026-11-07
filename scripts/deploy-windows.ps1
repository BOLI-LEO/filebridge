# ============================================================
# FileBridge Windows 一键部署脚本
# 用法（管理员 PowerShell）：
#   .\deploy-windows.ps1
#   .\deploy-windows.ps1 -MacIP <MAC_LAN_IP>
# ============================================================
param(
  [string]$InstallDir = "D:\FileBridge",
  [string]$ShareDir   = "D:\FileBridgeData",
  [string]$AccessCode = "",
  [string]$MacIP      = "",
  [string]$SetupFile  = "$PSScriptRoot\FileBridge-Setup-1.0.0.exe"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($AccessCode)) {
  $AccessCode = Read-Host "请输入访问口令（应与另一台设备一致）"
}
if ([string]::IsNullOrWhiteSpace($MacIP)) {
  Write-Warning "未提供 -MacIP，将跳过自动添加对端设备；可在 App 设置里手动添加。"
}
$ExpectedHash = "EE3E7DB5B673537B3BD01979D41A328648F55819351A8F2B99E36769022DD8A3"

function Write-Step($text) { Write-Host "`n[FileBridge] $text" -ForegroundColor Cyan }

# 1. 校验安装包
Write-Step "校验安装包"
if (-not (Test-Path $SetupFile)) { throw "找不到安装包：$SetupFile" }
$size = (Get-Item $SetupFile).Length
if ($size -ne 127158800) { throw "安装包大小不符（$size），可能传输不完整，请重新拷贝" }
$hash = (Get-FileHash $SetupFile -Algorithm SHA256).Hash
if ($hash -ne $ExpectedHash) { throw "安装包 SHA256 不匹配，请重新拷贝" }
Unblock-File $SetupFile
Write-Host "校验通过：$hash"

# 2. 静默安装
Write-Step "静默安装到 $InstallDir"
$p = Start-Process -FilePath $SetupFile -ArgumentList "/S", "/D=$InstallDir" -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "安装失败，退出码 $($p.ExitCode)（0xC0000005 说明仍是旧安装器）" }
if (-not (Test-Path (Join-Path $InstallDir "FileBridge.exe"))) { throw "安装后找不到 FileBridge.exe" }
Write-Host "安装完成：$(Join-Path $InstallDir 'FileBridge.exe')"

# 3. 准备共享目录
Write-Step "准备共享目录 $ShareDir"
New-Item -ItemType Directory -Force -Path $ShareDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ShareDir "临时收件箱") | Out-Null

# 4. 停止可能自动启动的实例，写入配置
Write-Step "写入配置（共享目录 / 访问口令）"
Get-Process FileBridge -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
$configDir = Join-Path $env:APPDATA "FileBridge"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$configFile = Join-Path $configDir "config.json"
$oldDeviceId = $null
if (Test-Path $configFile) {
  try { $oldDeviceId = (Get-Content -Raw -Path $configFile | ConvertFrom-Json).deviceId } catch { }
}
$config = @{
  deviceName = $env:COMPUTERNAME
  port       = 47890
  syncPort   = 47891
  root       = $ShareDir
  accessCode = $AccessCode
  autoSync   = $true
}
if ($oldDeviceId) { $config.deviceId = $oldDeviceId }
$config = $config | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $configDir "config.json"), $config, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "配置已写入：$(Join-Path $configDir 'config.json')"

# 5. 防火墙放行（需要管理员权限）
Write-Step "配置 Windows 防火墙"
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  Get-NetFirewallRule | Where-Object { $_.DisplayName -like "FileBridge*" } | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName "FileBridge" -Direction Inbound -Action Allow -Profile Private,Public -RemoteAddress LocalSubnet -Program (Join-Path $InstallDir "FileBridge.exe") | Out-Null
  New-NetFirewallRule -DisplayName "FileBridge TCP 47890" -Direction Inbound -Action Allow -Profile Private,Public -RemoteAddress LocalSubnet -Protocol TCP -LocalPort 47890 | Out-Null
  New-NetFirewallRule -DisplayName "FileBridge UDP 47891" -Direction Inbound -Action Allow -Profile Private,Public -RemoteAddress LocalSubnet -Protocol UDP -LocalPort 47891 | Out-Null
  New-NetFirewallRule -DisplayName "FileBridge UDP Broadcast 47891" -Direction Inbound -Action Allow -Profile Private,Public -Protocol UDP -LocalPort 47891 | Out-Null
  Write-Host "防火墙规则已添加"
} else {
  Write-Warning "当前不是管理员 PowerShell，已跳过防火墙配置；请以管理员身份重跑本脚本"
}

# 6. 启动并等待服务
Write-Step "启动 FileBridge"
Start-Process explorer.exe -ArgumentList "`"$(Join-Path $InstallDir "FileBridge.exe")`""
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:47890/api/health" -TimeoutSec 2
    if ($health.ok) { $ok = $true; break }
  } catch { }
}
if (-not $ok) { throw "FileBridge 服务未启动，请检查安装或查看事件查看器" }
Write-Host "服务已启动：http://127.0.0.1:47890"

# 7. 手动添加 Mac 为同步设备
if (-not [string]::IsNullOrWhiteSpace($MacIP)) {
  Write-Step "添加 $MacIP 为同步设备"
  try {
    $body = @{ ip = $MacIP; port = 47890 } | ConvertTo-Json
    $peer = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:47890/api/peers/add" `
      -ContentType "application/json" -Headers @{ "x-access-code" = $AccessCode } -Body $body
    Write-Host "已添加设备：$($peer.peer.name) ($($peer.peer.ip))"
  } catch {
    Write-Warning "添加对端失败：$($_.Exception.Message)。请确认对端已开启、IP 正确、访问口令一致。"
  }
} else {
  Write-Step "跳过添加对端（之后可在 App 设置里手动添加）"
}

Write-Step "完成"
Write-Host "程序：$InstallDir\FileBridge.exe"
Write-Host "共享目录：$ShareDir"
Write-Host "访问口令：$AccessCode"
Write-Host "手机/局域网：http://<本机IP>:47890/?code=$AccessCode"
Write-Host "卸载：Get-ChildItem '$InstallDir' -Filter 'Uninstall*.exe' | ForEach-Object { & $_.FullName /S }"
