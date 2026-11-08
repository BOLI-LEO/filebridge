# 连通性验证（校园网 / 跨子网）

先用 **TCP + HTTP** 验证，不要只用 `ping`。

## 三条命令

在客户端电脑执行（Windows）：

```powershell
$TARGET = "<SERVER_IP>"
$PORT   = 47890
$CODE   = "<ACCESS_CODE>"

ping $TARGET
Test-NetConnection $TARGET -Port $PORT
curl.exe "http://${TARGET}:${PORT}/api/health"
```

macOS / Linux：

```bash
TARGET="<SERVER_IP>"
ping -c 2 "$TARGET"
nc -vz "$TARGET" 47890
curl "http://$TARGET:47890/api/health"
```

## 结果解读

| ping | TCP 47890 | /api/health | 说明 |
|---|---|---|---|
| 通 | 通 | ok | 完全可用 |
| 不通 | 通 | ok | **ICMP Echo 未获响应，但 FileBridge 服务可用** |
| 通 | 不通 | — | 路由可达，但服务未启动或端口被防火墙拦截 |
| 不通 | 不通 | — | 可能是网络隔离、主机策略、服务未启动或端口配置错误；需要进一步排查 |

Windows 防火墙或中间网络策略可能拒绝 ICMP Echo，因此 `ping` 失败**不能**说明 Web 服务不可用。

## 为什么 Ping 不通但 HTTP 能通

ICMP 与 TCP 是不同协议，防火墙可以分别放行：

- 放行 TCP 47890（FileBridge Web/同步）
- 可能阻止 ICMP Echo（也可能由中间网络策略过滤）

只要 TCP 三次握手成功、HTTP 返回 `{"ok":true,...}`，应用层就是可用的。

## 跨子网 / 校园网

- 两台设备在不同 `/24` 甚至不同 VLAN，仍可能通过三层网关访问 TCP 47890
- UDP 广播（47891）通常不跨子网，因此**自动发现失败但手动添加可用**
- 可在获准使用时考虑 Tailscale 等覆盖网络；它仍依赖底层网络允许必要的连接，不能保证绕过校园网策略

## 验证 FileBridge 而不是只验证端口

```powershell
Invoke-RestMethod "http://<SERVER_IP>:47890/api/health"
Invoke-RestMethod "http://<SERVER_IP>:47890/api/info" -Headers @{ "x-access-code" = "<ACCESS_CODE>" }
```

- `/api/health` 公开，验证服务
- `/api/info` 带口令，验证认证与设备信息

## 安全边界

- 只测试**你拥有或获得书面授权**的设备
- 不要对教师机、办公机、他人设备做端口扫描或未授权访问
- 网络可达 ≠ 授权访问；校园网策略问题应反馈给网络管理部门
- 本项目的诊断脚本只用于自有设备的部署验收

## 一键脚本

Windows 客户端：

```powershell
.\scripts\check-connectivity.ps1 -TargetIP <SERVER_IP> -AccessCode <ACCESS_CODE>
```

脚本会依次测试 ping、TCP 47890、`/api/health`，并在 ping 失败但 TCP 成功时明确提示“ICMP 被拦，不代表不可用”。

## 校园网实测案例

[五张网络系列图及证据边界](campus-network/README.md) 记录了学生网跨接入点、跨不同合法校园网账号的 FileBridge 成功测试，以及学生网与教学设备网之间的已测连接失败。有关 ACL 位置、UDP 跨区状态和设备角色均未最终确认。
