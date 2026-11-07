# 同步协议

## 发现

### UDP 广播

- 端口 `47891`（`syncPort`）
- 每 3 秒发送一次 JSON：设备 id、名称、平台、HTTP 端口、版本
- 15 秒收不到广播的**自动发现**设备标记离线；手动添加/扫描发现的设备不过期

### HTTP 扫描

`POST /api/peers/scan`：扫描本机所在 `/24` 网段的 `47890` 端口，命中 `/api/health` 后读取 `/api/info` 并注册。

### 手动添加 / 通告

- `POST /api/peers/add {ip,port}`：持久化到 `config.json.manualPeers`
- `POST /api/peers/announce {id,name,platform,ip,port}`：对端主动上报当前地址
- 每 45 秒双方把本机当前 IP 通告给已知对端，用于 IP 变化纠正

## 同步轮次

每 8 秒（或事件触发）：

1. `GET /api/tree`
   ```json
   {
     "ok": true,
     "files": [{ "path": "a/b.txt", "size": 123, "mtime": 1700000000000 }],
     "tombstones": [{ "path": "old.txt", "deletedAt": 1700000000000 }]
   }
   ```
2. 应用 `tombstones`：删除本地 `mtime <= deletedAt` 的副本
3. 遍历 `files`：
   - 本地不存在 → 下载
   - 大小相同 → 跳过
   - 大小不同 → 另存为冲突副本，不覆盖
   - 命中本地墓碑且 `remote.mtime <= deletedAt` → 跳过（已删除，不拉回）
4. 流式下载到临时文件，完成后原子重命名
5. 广播 `peer` 状态与 `sync` 事件

## 冲突

- 同名不同内容：保留双方，冲突副本 `原名 (来自 设备名).ext`
- 不做自动覆盖，避免数据丢失

## 删除

- 仅应用内删除写墓碑
- 墓碑保留 30 天，持久化在 `tombstones.json`
- 删除后对端又修改/新建同名文件（mtime 更新）会保留

## 已知边界

- UDP 广播在校园网/企业网常被屏蔽
- 跨 VLAN 需手动添加/Tailscale
- 两端同时"删 + 写"会出现墓碑竞争，表现为短暂忽隐忽现
