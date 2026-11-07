# FileBridge API（v1）

服务地址：`http://<host>:47890`，端口被占用时自动 +1。  
所有路径使用 URL 编码的相对路径，`/` 分隔。

响应：成功 `{ "ok": true, ... }`；失败 HTTP 4xx/5xx + `{ "ok": false, "error": "..." }`。

## 认证

- 设置访问口令后，除 `GET /api/health`、`GET /api/info`（未认证时精简）、`POST /api/auth`、静态资源外都需要认证。
- 方式：Cookie `fb_code`、请求头 `X-Access-Code`、或 `?code=`。
- WebSocket 握手同样校验。

## 设备 / 服务器

### `GET /api/info`

认证后返回：

```json
{
  "ok": true,
  "app": { "name": "FileBridge", "version": "1.0.0" },
  "device": { "id": "uuid", "name": "mac-demo", "platform": "darwin", "hostname": "demo.local", "isElectron": true },
  "server": {
    "port": 47890,
    "uri": "http://192.168.1.10:47890",
    "url": "http://192.168.1.10:47890/?code=<YOUR_ACCESS_CODE>",
    "addresses": [{ "iface": "en0", "ip": "192.168.1.10", "kind": "lan" }],
    "root": "/path/to/FileBridge",
    "startedAt": 1700000000000,
    "uptime": 12345,
    "version": "1.0.0"
  },
  "auth": { "required": true, "authenticated": true },
  "sync": {
    "enabled": true,
    "peers": [
      { "id": "uuid", "name": "windows-demo", "platform": "win32", "ip": "192.168.1.20",
        "httpPort": 47890, "online": true, "manual": true, "busy": false,
        "status": "idle", "lastError": "", "lastSync": 1700000000000, "received": 3 }
    ]
  },
  "clipboard": { "count": 2 },
  "qr": { "svg": "<svg ...></svg>", "url": "http://192.168.1.10:47890/?code=<YOUR_ACCESS_CODE>" }
}
```

### `GET /api/health`

公开：`{ ok, name, version, port }`。

### `GET /api/settings`

```json
{ "ok": true, "settings": {
  "deviceName": "mac-demo",
  "autoSync": true,
  "accessCode": "******",
  "port": 47890,
  "syncPort": 47891,
  "root": "/path/to/FileBridge",
  "manualPeers": [{ "ip": "192.168.1.20", "port": 47890 }]
} }
```

### `PUT /api/settings`

可改：`deviceName`、`autoSync`、`accessCode`（空串=关闭；`"******"`=不改）、`root`（必须是存在且可写的目录）。  
修改 `root` 会重新创建收件箱、重启目录监听，无需重启 App。

### `GET /api/peers` / `POST /api/peers/add` / `POST /api/peers/remove`

- `add {ip,port}`：添加并持久化，返回 `{ ok, peer }`
- `remove {ip,port}`：移除并删除持久化记录
- `scan`：`POST /api/peers/scan` 扫描本机 `/24` 的 47890，返回 `{ ok, found, scanned, subnets, duration }`
- `announce`：`POST /api/peers/announce {id,name,platform,ip,port}`，接收对端主动上报，注册为手动设备并持久化

### `POST /api/auth`

`{ "code": "<YOUR_ACCESS_CODE>" }`，成功写 Cookie，失败 401。

## 文件

### `GET /api/list?path=<相对目录>`

返回 `{ ok, path, parent, name, entries: [{ name, path, isDir, size, mtime, ext, previewable }] }`。  
根目录 `path=""`。

### `GET /api/tree`

同步用：`{ ok, files: [{ path, size, mtime }], truncated, tombstones: [{ path, deletedAt }] }`。

### `POST /api/mkdir` / `rename` / `move` / `delete`

- `mkdir {path, name}` → `{ ok, entry }`
- `rename {path, name}` → `{ ok, entry }`（写旧路径墓碑）
- `move {paths, dest}` → `{ ok }`（写旧路径墓碑）
- `delete {paths}` → `{ ok, deleted }`（**写墓碑，双向删除**，永久删除）

### 上传 / 下载 / 预览

- `POST /api/upload?path=<dir>&name=<file>`：原始字节流，同名自动 `(1)`；返回 entry
- `POST /api/upload-chunk`：分片上传（大文件/弱网）
- `GET /api/download?path=...`：支持 Range
- `GET /api/preview?path=...`：文本/图片/PDF/音视频 inline；`/api/doc-preview` 处理 Office/ZIP

## 剪贴板

- `GET /api/clipboard`
- `POST /api/clipboard {text}`（≤100KB）
- `DELETE /api/clipboard?id=...`

## WebSocket

`ws(s)://<host>/ws`，消息类型：

```text
hello / fs / clipboard / clients / peers / sync
```

## 同步语义

- 每 8 秒或事件触发拉取 `/api/tree`
- 先应用墓碑，再下载差异
- 同名不同内容保留冲突副本 `原名 (来自 设备名).ext`
- 删除只认应用内操作；外部删除不写墓碑

## 错误码

| 状态 | 说明 |
|---|---|
| 400 | 参数/路径非法 |
| 401 | 口令错误或未认证 |
| 403 | 无写权限 |
| 404 | 文件/目录不存在 |
| 409 | 同名冲突 |
| 415 | 不支持预览 |
| 500 | 服务端错误 |
