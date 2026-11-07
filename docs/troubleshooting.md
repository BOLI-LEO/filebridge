# 故障排查

## Windows 安装器双击无反应 / 0xC0000005

**原因**：NSIS 3.13 stub 在 Windows 11 25H2 上启动即崩（`ntdll.dll +0x7FF05`）。  
**修复**：使用 v1.0.0 安装器（NSIS 3.04 stub，PE TimeDateStamp `0x5C157F86`）。  
**临时方案**：直接用免安装 zip。

## 安装后配置不生效（root/口令被重置）

**原因**：PowerShell `Set-Content -Encoding UTF8` 写 BOM，程序 `JSON.parse` 失败后回落默认值。  
**修复**：部署脚本用无 BOM 写入：

```powershell
[System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
```

## Windows 设备列表为空 / 15 秒掉线

**原因**：UDP 47891 广播被防火墙/校园网拦截，自动发现依赖 15 秒心跳。  
**修复**：

- 防火墙放行 TCP 47890、UDP 47891（Private/Public，LocalSubnet）
- 设置 → 同步设备 → 手动添加或扫描
- 新版手动设备持久化且不会因无广播过期

## 校园网设备互相发现不了

- 先在 Windows 放行防火墙
- 扫描局域网（仅同 `/24`）
- 跨 VLAN/异地：手动添加 IP，或两端 Tailscale

## 改了 IP 后同步断

- 新版会每 45 秒通告当前 IP，通常自动恢复
- 不恢复时在设置里更新对端 IP，或改用 Tailscale 的 `100.x`

## macOS 上手动添加设备失败

检查 **系统设置 → 隐私与安全性 → 本地网络** 是否允许 FileBridge；未授权时只能被连、不能主动连局域网。

## 删除文件又出现

- 同步只认应用内删除（写墓碑）
- Finder/资源管理器直接删除不会同步，会被对端拉回
- 在 App 内删除，等一轮同步

## macOS 菜单栏图标过大

v1.0.0 已改为 18pt template（`trayTemplate.png` + `@2x`）；旧版可重启 App 应用更新。

## 手机访问地址显示成虚拟网卡地址

某些虚拟化软件（VirtualBox / VMware）会创建 Host-Only 网卡，地址形如 `192.168.56.x`。手机访问请选 Wi-Fi 地址；v1.0.0 的通告逻辑会优先使用 TCP 真实来源 IP。

## 托盘/悬浮窗报 `Object has been destroyed`

v1.0.0 已加 `floatAlive()` 存活判断；升级到最新构建。

## Windows 拖拽失效

不要从管理员 PowerShell 直接 `Start-Process`；用 `explorer.exe "D:\FileBridge\FileBridge.exe"` 以普通权限启动，避免 UIPI 限制。
