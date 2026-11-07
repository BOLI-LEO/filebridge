# Changelog

## [1.0.0] - 2026-11-07

首个公开版本。

### Added

- Mac ↔ Windows 共享目录双向同步
- 桌面悬浮窗拖拽投递、单击展开、拖动移动
- iPhone 浏览器访问、二维码、上传/下载/预览
- 跨设备文字剪贴板
- 共享目录可在设置内更改（运行时切换，无需重启）
- 手动添加同步设备、持久化、移除
- 局域网 HTTP 扫描兜底、对端 IP 自动通告
- 删除墓碑同步（应用内删除双向生效）
- Cloudflare Tunnel 管理（token / quick / local）
- 样式化 DMG、PKG 安装器、Windows NSIS 安装器
- 应用图标与菜单栏 template 图标

### Fixed

- Windows NSIS 3.13 stub 在 Windows 11 25H2 启动即 `0xC0000005`：固定 NSIS 3.04
- 配置文件 BOM 导致 root/accessCode 被重置
- 防火墙只放行 Private 导致校园 WLAN 下 UDP 不通报文
- 管理员权限启动导致资源管理器拖拽失效（改用 explorer 普通权限）
- 重装后 `deviceId` 变化导致对端识别为新设备
- 手动设备 15 秒掉线、重启丢失
- 悬浮窗拖动后误触发展开
- 菜单栏图标 44pt 过大（改为 18pt template）
- 悬浮窗销毁后屏幕事件报 `Object has been destroyed`
- 对端 IP 选择 VirtualBox Host-Only 地址（改为 TCP 真实来源 IP）
- 删除文件被对端重新拉回（墓碑）
- 悬浮窗透明窗口拖动跟手问题（改为主进程跟随光标）

### Known limitations

- 校园网/企业网常屏蔽 UDP 广播，需扫描/手动/Tailscale
- 删除永久，无回收站
- 未签名构建，Gatekeeper / SmartScreen 会提示
- 免费 Cloudflare Tunnel 带宽有限

## [Unreleased]

- 计划：文件系统删除事件监听（Finder/资源管理器删除也写墓碑）
- 计划：可配置的删除同步开关
- 计划：代码签名与自动更新
