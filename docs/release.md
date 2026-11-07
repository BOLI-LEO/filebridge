# 发布流程

## 版本号

- `package.json` 的 `version` 与 tag 一致（例如 `1.0.0` → `v1.0.0`）
- Windows 安装器名：`FileBridge-Setup-<version>.exe`
- macOS：`FileBridge-<version>.pkg`、`FileBridge-mac-arm64.dmg`

## 构建 macOS

```bash
npm ci
npm run pack:mac
```

产物在 `dist/`：

- `FileBridge.app`
- `FileBridge-mac-arm64.zip`
- `FileBridge-1.0.0.pkg`
- `FileBridge-mac-arm64.dmg`（样式化）

## 构建 Windows

要求 NSIS **3.04**（electron-builder 的 `nsis-3.0.4.1` bundle）。不要升级到 3.13。

```bash
npx electron-builder --win nsis --x64
```

产物：

- `dist/FileBridge-Setup-1.0.0.exe`
- `dist/win-unpacked/`（用于打免安装 zip）

打 zip：

```bash
cd dist/win-unpacked
zip -r ../FileBridge-win-x64.zip .
```

或在 Windows 上用：

```powershell
Compress-Archive -Path .\* -DestinationPath ..\FileBridge-win-x64.zip
```

## 校验

```bash
file dist/FileBridge-Setup-1.0.0.exe
shasum -a 256 dist/FileBridge-Setup-1.0.0.exe dist/FileBridge-win-x64.zip
```

Windows 侧可检查 PE TimeDateStamp 应为 `0x5C157F86`（2018-12-15，NSIS 3.04），不是 2026 的值。

## GitHub Release

1. push tag：
   ```bash
   git tag v1.0.0
   git push origin main --tags
   ```
2. Releases → Draft a new release → 选择 tag → 上传：
   - `FileBridge-Setup-1.0.0.exe`
   - `FileBridge-win-x64.zip`
   - `FileBridge-1.0.0.pkg`
   - `FileBridge-mac-arm64.dmg`
3. Release Notes 引用 `CHANGELOG.md` 的对应版本。

> 构建产物不进 git；只作为 Release 附件。

## 签名（可选）

- macOS：Developer ID Application + Installer 证书，`codesign` / `productsign`，然后 notarize。
- Windows：Authenticode 证书（EV 可减少 SmartScreen 提示）。
- 未签名时在 README/Release Notes 里说明 Gatekeeper / SmartScreen 处理方式。
