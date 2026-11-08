# iPhone 原生 App 规划

## 定位

iPhone 端是 FileBridge 的**远程客户端**，不是同步端：

- 浏览 Mac/Windows 的共享目录
- 上传照片/文件到指定目录
- 下载、预览、分享
- 跨设备剪贴板
- 通过局域网、Tailscale 或 Cloudflare Tunnel 连接

iOS 后台限制决定了它不适合做持续的双向文件夹同步；同步仍由 Mac/Windows 端负责。

## 复用现有 API

Base：`http://<host>:47890` 或 `https://<domain>`  
认证：`X-Access-Code` 头，或先 `POST /api/auth` 拿 Cookie。

| 功能 | 接口 |
|---|---|
| 健康检查 | `GET /api/health` |
| 设备/服务器信息 | `GET /api/info` |
| 目录列表 | `GET /api/list?path=` |
| 新建目录 | `POST /api/mkdir` |
| 重命名/移动 | `POST /api/rename`、`POST /api/move` |
| 删除 | `POST /api/delete`（墓碑，双向删除） |
| 上传 | `POST /api/upload?path=&name=`（原始字节） |
| 分片上传 | `POST /api/upload-chunk?path=&name=&uploadId=&index=&total=` |
| 下载 | `GET /api/download?path=`（支持 Range） |
| 预览 | `GET /api/preview?path=`、`GET /api/doc-preview?path=` |
| 剪贴板 | `GET/POST/DELETE /api/clipboard` |
| 实时事件 | `WS /ws` |

分片上传约定：

- 分片 ≤ 8MB
- `uploadId` 6–64 位 `[A-Za-z0-9_-]`
- 按 `index` 从 0 到 `total-1` 顺序追加
- 最后一片返回 `{ done:true, entry }`
- 失败重试同一片即可（服务端追加写）

## 技术选型

- SwiftUI + async/await
- URLSession（上传/下载/分片、Range）
- URLSessionWebSocketTask（文件变化、剪贴板）
- Keychain 存访问口令与最近服务器
- QuickLook（PDF/Office/图片/视频）
- PhotosPicker / FileImporter（上传）
- 可选：Bonjour/mDNS 发现 `_filebridge._tcp`
- 可选：Share Extension（从其他 App 直接上传）

## 页面

1. **连接**
   - 扫码（二维码内容：`http://ip:47890/?code=...`）
   - 手动输入地址 + 口令
   - 最近设备列表（Keychain + UserDefaults）
2. **文件浏览**
   - 面包屑、搜索、排序
   - 目录/文件图标、大小、修改时间
   - 下拉刷新；WebSocket 推送后局部刷新
3. **文件详情/预览**
   - QuickLook
   - 下载、分享、删除、重命名
4. **上传**
   - 从相册/文件选择
   - 上传队列、进度、重试、分片
5. **剪贴板**
   - 文本列表、复制、发送、删除
6. **设置**
   - 服务器地址、口令、断开、关于

## 网络与权限

- Info.plist：
  - `NSLocalNetworkUsageDescription`（访问局域网设备）
  - 如需 HTTP 局域网：ATS 例外（`NSAllowsLocalNetworking` 或按域）
  - 相册/文件权限描述
- 公网：优先 HTTPS（Cloudflare Tunnel），不要明文 HTTP
- Tailscale：用户自行安装，App 只填 `100.x`
- 二维码深链：`filebridge://connect?url=...&code=...`（可选）

## 工程结构建议

```text
ios/
  FileBridge/
    App/
    Features/
      Connect/
      Browser/
      Preview/
      Upload/
      Clipboard/
      Settings/
    Core/
      API/
      Auth/
      Models/
      Networking/
    Resources/
  FileBridge.xcodeproj
  README.md
```

## 里程碑

### M0 连接与浏览
- 扫码/手动连接
- `/api/health` + `/api/info` 验证
- 文件列表、目录导航
- 错误提示（超时、401、非 FileBridge）

### M1 下载与预览
- 下载到本地沙盒 + QuickLook
- 图片/PDF/文本预览
- 分享/存储到“文件”

### M2 上传
- 单文件上传
- 大文件分片 + 重试
- 相册/文件导入
- 上传进度与取消

### M3 剪贴板与实时刷新
- 剪贴板列表
- WebSocket 文件变化/剪贴板推送
- 后台恢复刷新

### M4 体验与发布
- 最近设备、连接诊断
- 深色模式、动态字体、无障碍
- TestFlight；评估 App Store 审核风险
- 可选 Share Extension

## 安全

- 口令只存 Keychain，不写日志
- 默认只允许 HTTPS 公网；HTTP 仅限局域网/Tailscale
- 不在二维码/URL 之外持久化明文口令
- 删除操作二次确认
- 证书异常时明确提示，不静默忽略

## 待定问题

- 是否支持多服务器同时连接
- 是否做离线文件缓存/收藏
- 是否做后台下载队列（URLSession background）
- 是否上架 App Store，还是 TestFlight/企业分发
- 是否需要 iPad 适配（可共用同一套 UI）
