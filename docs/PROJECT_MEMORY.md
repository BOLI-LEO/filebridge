# FileBridge 项目记忆

快照：2026-11-08  
仓库：https://github.com/BOLI-LEO/filebridge  
Release：https://github.com/BOLI-LEO/filebridge/releases/tag/v1.0.0  
维护者：Leo

## 产品定位

Mac ↔ Windows 的局域网文件互通工具：

- 共享目录双向同步
- 桌面悬浮窗拖拽投递
- iPhone 浏览器扫码访问（后续做原生 App）
- 跨设备文字剪贴板
- 局域网直连；异地可配合 Tailscale 或 Cloudflare Tunnel
- 不租服务器，不依赖云中转

## 设计偏好（历史决策）

- UI 以浅色/白色为主，移动端卡片列表
- 应用图标用猫猫图标；菜单栏图标用 18pt template，不要过大
- 悬浮窗：单击展开、拖动移动，松手不应误展开
- 文件必须保持原样，不做压缩
- 二维码优先局域网地址；Tailscale/公网作为异地备选
- 启动页简洁，不要"AI 味"过重

## 版本与技术栈

- 版本 1.0.0
- Electron 45.x，Node 内置 HTTP + ws
- 前端原生 HTML/CSS/JS（无框架）
- 同步：UDP 47891 发现 + HTTP 拉取/墓碑删除
- 端口：TCP 47890（HTTP/WS），UDP 47891（发现）
- 打包：macOS `.app`/`.zip`/`.pkg`/样式化 `.dmg`；Windows NSIS `.exe` + 免安装 `.zip`

## 关键坑位（不要再踩）

1. **Windows NSIS 3.13 stub 在 Win11 25H2 启动即 0xC0000005**
   - 必须使用 NSIS 3.04（electron-builder nsis-bundle 3.0.4.1）
   - 安装包 PE TimeDateStamp 应为 `0x5C157F86`
2. **配置 BOM**
   - PowerShell 5.1 `Set-Content -Encoding UTF8` 会写 BOM，导致 `JSON.parse` 失败并重置配置
   - 必须用 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`
3. **Windows 防火墙**
   - 校园 WLAN 常为 Public；规则要包含 Public
   - 跨网段时 `RemoteAddress` 不能用 `LocalSubnet`，测试可用 `10.0.0.0/8`
4. **管理员令牌导致 UIPI 拖拽失效**
   - 用 `explorer.exe "FileBridge.exe"` 以普通权限启动
5. **重装 deviceId 变化**
   - 会变成新设备；部署脚本应沿用旧 `config.json` 的 deviceId
6. **手动设备不过期**
   - `manualPeers` 持久化；不再依赖 15 秒 UDP heartbeat
7. **删除只认应用内操作**
   - 应用内删除写墓碑并双向删除
   - Finder/资源管理器直接删除不写墓碑，会被对端拉回
8. **对端 IP 通告**
   - 每 45 秒 announce；接收端优先使用 TCP 真实来源 IP，避免选中 VirtualBox Host-Only 地址
9. **macOS 本地网络权限**
   - 未授权时只能被连、不能主动连局域网；需要 `NSLocalNetworkUsageDescription` + 用户允许
10. **悬浮窗生命周期**
    - 屏幕事件/拖动回调前要判断 `floatWindow.isDestroyed()`
11. **菜单栏图标**
    - `trayTemplate.png` 18×18 + `@2x` 36×36，template image
12. **DMG**
    - 需要 Applications 快捷方式、背景、卷图标；打包用 `scripts/make-dmg.js`

## 网络实验结论（2026-11 校园网）

- 学生网：`10.252.0.0/15`，网关 `10.252.0.1`
- 教学网：`10.191.254.0/23`，网关 `10.191.255.254`
- 观测核心跳点：`10.246.248.58`
- 学生网内部：跨 AP、跨区域、**不同学生账号**均可 TCP/HTTP/文件同步
- 学生网 ↔ 教学网：ping、TCP 50000/47890 双向失败；两端监听与防火墙均正常
- 结论：校园网按**区域/VLAN**做 ACL 隔离，不是账号级隔离
- 对产品：学生网内可直连同步；跨教学网直连不可行，需 Tailscale/同一 VLAN/学校审批
- 不要对教师机等非自有设备做端口扫描或未授权访问

## 当前状态

- Mac 版已安装最新构建；Windows 版已用 NSIS 3.04 安装并验收
- 源码已开源，Release 含 4 个构建资产
- 后续重点：iPhone 原生 App（见 `docs/iphone-native-plan.md`）

## iPhone 原生 App 的记忆锚点

- 不重写同步引擎，直接复用现有 HTTP/WS API
- iPhone 端定位：远程浏览/上传/下载/预览/剪贴板，不做后台文件夹同步
- 认证：访问口令 + Keychain
- 连接：扫码（URL + code）/手动填地址；局域网、Tailscale、Tunnel 都能用
- 大文件用 `/api/upload-chunk`；下载用 Range
- 预览用 QuickLook；文本/图片/PDF/Office 可先走现有 `/api/preview`、`/api/doc-preview`
- 需要 `NSLocalNetworkUsageDescription`；HTTP 局域网需要 ATS 例外，公网走 HTTPS

## 下一步

1. iPhone 原生 App（SwiftUI）M0：连接 + 文件列表 + 下载
2. 上传/分片 + QuickLook
3. 剪贴板 + WebSocket 实时刷新
4. TestFlight / App Store 评估
5. Windows/macOS 可选：代码签名、自动更新、删除事件监听
