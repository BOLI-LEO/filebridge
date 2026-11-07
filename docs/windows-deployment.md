# Windows 部署

## 产物

| 文件 | 字节数 | SHA-256 |
|---|---|---|
| `FileBridge-Setup-1.0.0.exe` | 127,158,800 | `ee3e7db5b673537b3bd01979d41a328648f55819351a8f2b99e36769022dd8a3` |
| `FileBridge-win-x64.zip` | 167,559,777 | `9767c6ea137b6d8117838d429dde1464b0ba6125cec7ce78011614ba167793b0` |

> 安装器必须使用 **NSIS 3.04 stub**（PE TimeDateStamp `0x5C157F86`）。NSIS 3.13 在 Windows 11 25H2 会启动即 `0xC0000005`。
> 如果安装器仍然异常，直接解压 zip 使用，功能完全一致。

## 一键部署

把 `FileBridge-Setup-1.0.0.exe` 和 `scripts/deploy-windows.ps1` 放在同一目录，管理员 PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\deploy-windows.ps1 -AccessCode "<YOUR_ACCESS_CODE>" -MacIP "<MAC_LAN_IP>"
```

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `-InstallDir` | `D:\FileBridge` | 安装目录 |
| `-ShareDir` | `D:\FileBridgeData` | 共享目录 |
| `-AccessCode` | 空（会提示输入） | 两台设备必须一致 |
| `-MacIP` | 空 | 对端 Mac 局域网 IP；为空则跳过手动添加 |
| `-SetupFile` | 同目录 Setup | 安装器路径 |

脚本流程：

1. 校验大小 + SHA-256
2. `Unblock-File` 解除网络锁定
3. `/S /D=<InstallDir>` 静默安装
4. 创建共享目录 + 临时收件箱
5. 写 `%APPDATA%\FileBridge\config.json`（UTF-8 **无 BOM**，保留旧 `deviceId`）
6. 防火墙：程序 / TCP 47890 / UDP 47891 / UDP 广播
7. 用 `explorer.exe` 以普通权限启动（避免管理员令牌导致 UIPI 拖拽失效）
8. 添加 Mac 设备并等待 `/api/health`

## 手动安装

```powershell
Unblock-File .\FileBridge-Setup-1.0.0.exe
Start-Process .\FileBridge-Setup-1.0.0.exe -ArgumentList "/S","/D=D:\FileBridge" -Wait

Get-NetFirewallRule | Where-Object { $_.DisplayName -like "FileBridge*" } | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "FileBridge TCP 47890" -Direction Inbound -Action Allow -Profile Private,Public -RemoteAddress LocalSubnet -Protocol TCP -LocalPort 47890
New-NetFirewallRule -DisplayName "FileBridge UDP 47891" -Direction Inbound -Action Allow -Profile Private,Public -RemoteAddress LocalSubnet -Protocol UDP -LocalPort 47891
New-NetFirewallRule -DisplayName "FileBridge UDP Broadcast 47891" -Direction Inbound -Action Allow -Profile Private,Public -Protocol UDP -LocalPort 47891
```

启动：

```powershell
Start-Process explorer.exe -ArgumentList '"D:\FileBridge\FileBridge.exe"'
```

添加对端：

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:47890/api/peers/add" `
  -ContentType "application/json" -Headers @{ "x-access-code" = "<YOUR_ACCESS_CODE>" } `
  -Body '{"ip":"<MAC_LAN_IP>","port":47890}'
```

## 配置

`%APPDATA%\FileBridge\config.json`：

```json
{
  "deviceName": "DORM-PC",
  "port": 47890,
  "syncPort": 47891,
  "root": "D:\\FileBridgeData",
  "accessCode": "<YOUR_ACCESS_CODE>",
  "autoSync": true,
  "manualPeers": [{ "ip": "<MAC_LAN_IP>", "port": 47890 }]
}
```

- 无 BOM；保留 `deviceId`
- 改完重启 App
- 也可在「设置 → 共享目录 → 更改」里改路径

## 卸载

```powershell
Get-ChildItem "D:\FileBridge" -Filter "Uninstall*.exe" | ForEach-Object { & $_.FullName /S }
```

或设置 → 应用 → FileBridge → 卸载。  
用户数据在 `%APPDATA%\FileBridge`，按需删除。

## 常见坑

1. **NSIS 3.13 崩溃** → 用 3.04 安装器或 zip
2. **配置 BOM** → 脚本已用无 BOM 写入
3. **防火墙只放行 Private** → 校园 WLAN 常是 Public，需 `Private,Public`
4. **管理员令牌导致拖拽失效** → 用 explorer 普通权限启动
5. **重装 deviceId 变化** → 脚本沿用旧值
6. **手动设备 15 秒掉线** → 新版持久化 + 扫描 + announce，不需要 keepalive
7. **删除又出现** → 只有应用内删除写墓碑；资源管理器删除不会同步
