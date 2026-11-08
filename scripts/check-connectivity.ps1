<#
.SYNOPSIS
  检查到 FileBridge 服务的连通性（ping / TCP / HTTP）。
.DESCRIPTION
  仅用于自有设备部署验收。ping 失败不代表服务不可用：
  Windows 防火墙默认可能拦截 ICMP，但 TCP 47890 仍然可用。
#>
param(
  [Parameter(Mandatory = $true)][string]$TargetIP,
  [int]$Port = 47890,
  [string]$AccessCode = ""
)

$ErrorActionPreference = "Continue"
Write-Host "== FileBridge 连通性检查 ==" -ForegroundColor Cyan
Write-Host "目标: $TargetIP`:$Port"

$pingOk = Test-Connection -ComputerName $TargetIP -Count 2 -Quiet -ErrorAction SilentlyContinue
if ($pingOk) { Write-Host "[ping] 通" -ForegroundColor Green }
else { Write-Warning "[ping] 不通（ICMP 可能被防火墙拦截，继续测 TCP）" }

$tcpOk = $false
try {
  $tcp = Test-NetConnection -ComputerName $TargetIP -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue
  $tcpOk = [bool]$tcp
} catch { $tcpOk = $false }
if ($tcpOk) { Write-Host "[tcp $Port] 通" -ForegroundColor Green }
else { Write-Host "[tcp $Port] 不通" -ForegroundColor Red }

$health = $null
try {
  $health = Invoke-RestMethod -Uri "http://$TargetIP`:$Port/api/health" -TimeoutSec 5
} catch { $health = $null }
if ($health -and $health.ok) { Write-Host "[http] /api/health ok ($($health.name) $($health.version))" -ForegroundColor Green }
else { Write-Host "[http] /api/health 失败" -ForegroundColor Red }

if ($AccessCode -and $health -and $health.ok) {
  try {
    $info = Invoke-RestMethod -Uri "http://$TargetIP`:$Port/api/info" -Headers @{ "x-access-code" = $AccessCode } -TimeoutSec 5
    Write-Host "[auth] 设备: $($info.device.name) / $($info.device.platform)" -ForegroundColor Green
  } catch {
    Write-Warning "[auth] /api/info 失败：口令错误或认证未通过"
  }
}

Write-Host ""
if ($tcpOk -and $health -and $health.ok) {
  Write-Host "结论：TCP + HTTP 可用。即使 ping 不通也可以使用 FileBridge。" -ForegroundColor Green
  exit 0
}
if ($tcpOk) {
  Write-Host "结论：端口可达但 HTTP 异常，检查 FileBridge 是否运行。" -ForegroundColor Yellow
  exit 2
}
Write-Host "结论：TCP 不可达。检查 IP/服务/防火墙，或改用 Tailscale。" -ForegroundColor Red
exit 1
