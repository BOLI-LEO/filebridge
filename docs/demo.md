# 通用演示（全部为占位符）

以下示例不包含真实 IP、域名、口令，复制后替换 `<...>` 即可。

## 场景

| 角色 | 设备名 | 局域网 IP | 访问口令 |
|---|---|---|---|
| Mac | `mac-demo` | `192.168.1.10` | `<YOUR_ACCESS_CODE>` |
| Windows | `windows-demo` | `192.168.1.20` | `<YOUR_ACCESS_CODE>` |

Tailscale 示例：

- Mac `100.64.0.10`
- Windows `100.64.0.20`

公网域名示例：`files.example.com`（替换为你自己的域名）

## Mac

1. 安装并打开 FileBridge
2. 设置 → 访问口令：`<YOUR_ACCESS_CODE>`
3. 设置 → 共享目录：`/Users/<YOU>/FileBridge`
4. 手机访问二维码：`http://192.168.1.10:47890/?code=<YOUR_ACCESS_CODE>`

## Windows

```powershell
# 安装
Start-Process .\FileBridge-Setup-1.0.0.exe -ArgumentList "/S","/D=D:\FileBridge" -Wait

# 防火墙
New-NetFirewallRule -DisplayName "FileBridge TCP 47890" -Direction Inbound -Action Allow -Profile Private,Public -RemoteAddress LocalSubnet -Protocol TCP -LocalPort 47890
New-NetFirewallRule -DisplayName "FileBridge UDP 47891" -Direction Inbound -Action Allow -Profile Private,Public -RemoteAddress LocalSubnet -Protocol UDP -LocalPort 47891

# 启动（普通权限）
Start-Process explorer.exe -ArgumentList '"D:\FileBridge\FileBridge.exe"'
```

在设置 → 同步设备里添加 `192.168.1.10:47890`，或使用「扫描局域网」。

## 删除演示

1. 在 Mac 的共享目录里新建 `demo.txt`
2. 等 Windows 收到
3. 在 Mac App 内右键删除 `demo.txt`
4. 等一轮同步，Windows 上的 `demo.txt` 也会消失，且不会回来

> 在 Finder 里删 `demo.txt` 不会触发墓碑，会被 Windows 拉回。

## 异地演示（Tailscale）

```bash
# Mac 上查地址
tailscale ip -4     # 例如 100.64.0.10
```

Windows 设置 → 同步设备 → 添加 `100.64.0.10:47890`；手机访问 `http://100.64.0.10:47890/?code=<YOUR_ACCESS_CODE>`。

## Cloudflare Tunnel 演示

- 域名：`files.example.com`
- 本地服务：`http://localhost:47890`
- 访问：`https://files.example.com/?code=<YOUR_ACCESS_CODE>`

公网入口必须设置口令，并建议叠加 Cloudflare Access。
