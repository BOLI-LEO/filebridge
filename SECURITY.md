# 安全说明

## 支持的版本

| 版本 | 支持 |
|---|---|
| 1.0.x | ✅ |
| < 1.0 | ❌ |

## 报告问题

请通过仓库 Issues（或作者公开邮箱）报告安全问题，不要公开验证细节、访问口令、Tunnel token 或内网地址。

## 使用建议

- 只在可信局域网内默认开放服务；公网访问请使用 Cloudflare Tunnel + 访问口令，建议叠加 Cloudflare Access。
- 访问口令至少 6 位，不要使用示例值。
- 不要把 47890 端口直接映射到公网。
- Tunnel token、`config.json`、`tunnel.json`、`tombstones.json` 不提交到 git。
- 局域网/Tailscale 内的同步是明文 HTTP；对公网传输请走 HTTPS Tunnel。

## 已知取舍

- 删除为永久删除，不进入回收站。
- 冲突时保留双方副本，可能产生重复文件。
- 未签名构建可能触发系统安全提示。
