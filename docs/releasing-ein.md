# 一念 Ein 发版与自动更新

源码在私有仓库 `kairuioba/ein`，安装包和更新文件放在**公开**仓库 `kairuioba/ein-releases`。装好的一念从后者检查更新，所以源码可以一直保持私有。

## 发一个新版本

1. 改 `package.json` 里的 `version`（比如 `1.0.0` → `1.0.1`），提交并推到 `main`。
2. 打同名标签并推送：

   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```

   也可以在 GitHub 的 Actions → **Release 一念 Ein** → Run workflow 手动触发。
3. 工作流 `.github/workflows/release-ein.yml` 会：
   - 在 macOS 上打 Apple 芯片（arm64）和 Intel（x64）两个包：DMG（给新用户下载安装）和 ZIP（给自动更新用），并生成 `latest-mac.yml`；
   - 在 Windows 上打安装包，生成 `latest.yml`；
   - 把这些文件全部上传到 `kairuioba/ein-releases` 里名为 `v1.0.1` 的 Release。

   标签必须和 `package.json` 的版本一致，否则工作流会直接报错退出。

## 需要的 secret

| 名字 | 放在哪 | 是什么 |
|---|---|---|
| `EIN_RELEASES_TOKEN` | `ein` → Settings → Secrets and variables → Actions | Fine-grained token，只授权 `ein-releases`，Contents 读写 |

令牌过期后，发版会在上传这一步失败（工作流会提示 secret 缺失或过期）。重新生成一个令牌，替换同名 secret 即可。已经装好的软件不受影响：检查和下载更新不需要令牌。

可选：如果以后有 Apple 开发者账号，加上 `MAC_CERT_P12_BASE64` / `MAC_CERT_PASSWORD`（签名）和 `APPLE_API_KEY_P8_BASE64` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER_ID`（公证），工作流会自动改用正式签名，打开时就不再需要“仍要打开”。

## 软件里的更新怎么工作

- **启动后约 15 秒**检查一次，之后每小时检查一次。发现新版就在后台下载；下载完成后侧边栏提示「新版本已就绪」，点一下重启即可。不点的话，下次退出一念时自动换上新版，再打开就是新版本。
- **设置 → 更新 → 检查更新**：发现新版后自动下载，下载完自动重启进入新版。
- **Mac（未签名）**：系统自带的更新机制（Squirrel.Mac）只认正式签名，所以一念自己完成替换（`electron/bundle-updater.mjs`）：
  1. 读 `latest-mac.yml`，选这台 Mac 架构对应的 ZIP；
  2. 下载，按 `latest-mac.yml` 里的 sha512 校验，不一致就丢弃；
  3. 用 `ditto` 解压，确认 Bundle ID 和当前应用一致（不是别的应用）；
  4. 一念退出后，后台小脚本先把新版复制到旧版旁边，再用两次改名换上新版，失败就换回旧版；然后清除隔离标记，需要时重新打开。
- **必须装在「应用程序」文件夹里**：直接从 DMG 或「下载」文件夹里打开的一念，macOS 会把它放在只读的临时位置，无法替换。这种情况软件会提示先拖进「应用程序」文件夹。
- **Windows**：沿用 electron-updater 的 NSIS 更新，不签名也能自动更新；首次安装时 Windows 会提示“未知发布者”。

## 首次安装（未签名的 Mac 版）

1. 打开 DMG，把一念拖进「应用程序」；
2. 第一次打开时 macOS 会提示无法验证开发者：到「系统设置 → 隐私与安全性」，点「仍要打开」。只需要这一次：自动更新下载的新版没有隔离标记，打开时不会再问。

**未签名版本的一个限制**：macOS 按签名识别应用，没有正式签名时，每个新版本在系统眼里都是“另一个应用”。所以更新以后，「辅助功能」「屏幕录制」「麦克风」这类权限可能要在「系统设置 → 隐私与安全性」里重新勾选一次（用到电脑操作、录制技能、语音时才需要）。有了 Apple 开发者签名就没有这个问题。

## 应用身份（不要再改）

从 1.1.0 起，一念的身份固定为：

| 项 | 值 |
|---|---|
| 应用名 | `Ein.app`（访达和程序坞显示“一念”） |
| Bundle ID / Windows AppUserModelId | `com.kairuioba.ein` |
| 数据目录 | `~/.ein`（手机配对服务在 `~/.ein-companion`） |
| 网址协议 | `ein://` |

自动更新会核对新版的 Bundle ID 必须和正在运行的一致，所以这些值改了就等于换了一个软件：已经装好的版本收不到更新，只能卸载重装。1.0.0 还沿用旧身份，就是因为这个原因没法自动升级到 1.1.0。
