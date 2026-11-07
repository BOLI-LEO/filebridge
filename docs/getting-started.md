# 快速开始

## 1. 环境

- macOS 13+ / Windows 10 11（x64）
- 从源码运行需要 Node.js 20+ 与 npm
- 两台设备需要在同一局域网，或同时登录同一个 Tailscale 网络

## 2. 安装

### macOS

- 推荐 `FileBridge-1.0.0.pkg`：双击 → 安装到 `/Applications`
- 或 `FileBridge-mac-arm64.dmg`：打开后把 FileBridge 拖进 Applications

首次打开被 Gatekeeper 拦截时：右键 App → 打开 → 仍要打开；或到系统设置 → 隐私与安全性 → 仍要打开。

### Windows

- 推荐 `FileBridge-Setup-1.0.0.exe`：支持 `/S` 静默安装，`/D=<目录>` 指定安装目录
- 或 `FileBridge-win-x64.zip`：解压后双击 `FileBridge.exe`

安装包未签名，SmartScreen 提示时点「更多信息 → 仍要运行」。  
如果安装器启动即崩（0xC0000005），说明拿到了旧的 NSIS 3.13 包，请换用 v1.0.0 的 3.04 安装器或直接使用 zip。

## 3. 首次配置

1. 打开 App → 设置：
   - **访问口令**：两台设备必须一致，例如 `<YOUR_ACCESS_CODE>`
   - **共享目录**：默认 `~/FileBridge` / `%USERPROFILE%\FileBridge`，可点「更改」选择任意可写目录
2. 主窗口左下角显示本机地址，例如 `http://192.168.1.10:47890/?code=<YOUR_ACCESS_CODE>`

## 4. 两台电脑同步

### 同一局域网

- 两端都启动 FileBridge，默认会自动发现并同步
- 若设备列表为空：
  - 设置 → 同步设备 → **扫描局域网**
  - 或手动填写对方 IP + 端口 `47890`

### 校园网 / 跨网段

校园网常屏蔽 UDP 广播，自动发现会失败；可以：

1. 手动添加对方局域网 IP；或
2. 两端安装 [Tailscale](https://tailscale.com/download)，登录同一账号，填对方的 `100.x.x.x:47890`

> 手动添加的设备会持久化到 `config.json`，重启不丢；不会因为收不到广播而掉线。

### 修改 IP 后

- 新版会每 45 秒把自己的当前局域网 IP 通告给已知对端，IP 变化通常能自动纠正
- 若两端同时换 IP 且互相都连不上，需要手动更新一次，或使用 Tailscale

## 5. 手机访问

1. 手机与电脑连同一 Wi-Fi
2. 主窗口「手机访问」→ 扫码，或 Safari 打开显示的地址
3. 手机可浏览/下载/上传/剪贴板
4. 异地：手机与电脑都开 Tailscale，访问 `http://100.x.x.x:47890/?code=<YOUR_ACCESS_CODE>`

## 6. 删除文件

- 在 App 内右键删除：写墓碑，双向删除，不会被拉回
- 在 Finder / 资源管理器直接删除：不写墓碑，可能被对端重新拉回
- 删除是永久的，没有回收站

## 7. 升级 / 卸载

- 升级：退出 App → 覆盖安装/解压；保留 `%APPDATA%\FileBridge` 或 `~/Library/Application Support/FileBridge` 中的 `deviceId`
- macOS 卸载：删除 `/Applications/FileBridge.app`，按需删除数据目录
- Windows 卸载：`"D:\FileBridge\Uninstall FileBridge.exe" /currentuser`，或设置 → 应用 → FileBridge

## 8. 远程访问（可选）

见 [Cloudflare Tunnel 配置](architecture.md#cloudflare-tunnel) 与 [Tailscale](architecture.md#tailscale)。

## 下一步

- [Windows 部署](windows-deployment.md)
- [故障排查](troubleshooting.md)
- [API 摘要](API.md)
