# 架构说明

## 组件

| 组件 | 说明 |
|---|---|
| `main.js` | Electron 主进程：主窗口、悬浮窗、托盘、IPC、单实例、启动页 |
| `preload.js` | 受控 IPC 桥（`window.filebridge`） |
| `server/index.js` | 内置 HTTP/WS 服务：文件、上传下载、预览、剪贴板、项目、隧道、设备 |
| `server/sync.js` | 局域网发现、HTTP 扫描、手动设备、同步引擎、墓碑删除 |
| `server/tunnel.js` | Cloudflare Tunnel（token / quick / local 三种模式） |
| `server/doc-preview.js` | docx/xlsx/pptx/zip 预览 |
| `renderer/` | 主界面、悬浮窗、启动页（原生 HTML/CSS/JS） |
| `scripts/pack.js` | macOS `.app` / zip / pkg 打包 |
| `scripts/make-dmg.js` | 样式化 DMG（背景、Applications 快捷方式、卷图标） |

## 端口

| 端口 | 协议 | 用途 |
|---|---|---|
| 47890 | TCP | HTTP / WebSocket |
| 47891 | UDP | 局域网设备广播发现 |

端口被占用时 HTTP 自动 +1，实际端口显示在设置中。

## 数据目录

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/FileBridge/` |
| Windows | `%APPDATA%\FileBridge\` |

`config.json` 保存设备名、共享目录、访问口令、端口、`manualPeers`；`tombstones.json` 保存删除墓碑；`tunnel.json` 保存隧道配置（token 不回传）。

## 同步流程

1. **发现**：UDP 广播（同网段）；被屏蔽时用 HTTP 扫描 `/24`、手动添加、或对端 `announce`。
2. **拉取清单**：`GET /api/tree` 返回文件列表 + 墓碑数组。
3. **应用墓碑**：先删除对端已删除且本地未修改的文件。
4. **下载差异**：只拉取缺失或大小不同的文件，流式写盘。
5. **冲突**：同名不同内容保留双方副本 `原名 (来自 设备名).ext`。
6. **通告**：每 45 秒把本机当前 IP POST 给已知对端，纠正 IP 变化。

## 删除墓碑

- 应用内删除 → `POST /api/delete` → 写入 `tombstones.json`（path + deletedAt）
- 墓碑随 `/api/tree` 传给对端；对端只删除 `mtime <= deletedAt` 的副本
- 保留 30 天，防止已删除文件被旧副本拉回

## Cloudflare Tunnel

`server/tunnel.js` 支持：

- **token**：粘贴 Cloudflare Zero Trust 创建的 tunnel token
- **quick**：临时 `trycloudflare.com` 地址（仅调试）
- **local**：使用 `~/.cloudflared/<id>.json` 凭据 + 自动生成 ingress 配置

公网入口必须设置访问口令；建议再加 Cloudflare Access。

## Tailscale

两端安装 Tailscale 并登录同一账号，使用 `100.x.x.x:47890` 互连。  
Tailscale 地址稳定，底层网络切换不影响；校园网内仍优先局域网直连。

## 安全边界

- 服务默认监听 `0.0.0.0`，同一网络内可访问
- 访问口令通过 Cookie / `X-Access-Code` / `?code=` 校验
- 公网暴露必须使用 Tunnel + 口令；不要直接把端口映射到公网
- 上传/下载流式处理；临时文件启动时清理
