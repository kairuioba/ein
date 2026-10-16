# OpenMausBot 中文版

在聊天应用里拥有一支自己的 AI 机器人团队。这个中文版在开源项目 [OpenMausBot](https://github.com/CuriosityOS/OpenMausBot)（Apache-2.0）的基础上做了二次开发，主要有四项改动：

1. **完全汉化**：界面、菜单栏、右键菜单、系统权限弹窗、服务端提示和错误、机器人的回复语言，全部默认使用简体中文，也可以在设置里切回英文。
2. **接入腾讯 WorkBuddy**：新增“WorkBuddy”引擎（底层是 CodeBuddy Code CLI），自动读取你的账号能用的模型，支持国际版、国内版和 iOA 版。
3. **总控自动派发和模型推荐**：总控机器人会把复杂需求拆成子任务，派给最合适的成员；团队里没有合适的人时，按任务难度推荐模型并自动新建专员。全部完成后由总控汇总。
4. **工作台**：总控在上，员工在下，用“插头接插座”的方式连线，可以随时改接。操作方式贴近 macOS 习惯（触控板缩放和平移、⌘Z 撤销、⌫ 拔线、右键菜单、检查器面板）。

---

## 下载与安装（Mac）

安装包有两个，按芯片选择：

| 你的 Mac | 安装包 |
|---|---|
| Apple 芯片（M1 及以后） | `OpenMausBot-zh-<版本>-apple-silicon.dmg` |
| Intel 芯片 | `OpenMausBot-zh-<版本>-intel.dmg` |

打开 dmg，把 OpenMausBot 拖进“应用程序”文件夹即可。

**首次打开提示“无法验证开发者”怎么办？** 没有配置 Apple 开发者证书时，构建出来的应用是临时签名（ad-hoc），macOS 会拦下来。处理方法：

1. 先双击打开一次，出现提示后点“完成”。
2. 打开“系统设置 → 隐私与安全性”，在页面下方找到 OpenMausBot，点“仍要打开”，然后输入密码确认。

熟悉终端的话，也可以执行 `xattr -dr com.apple.quarantine /Applications/OpenMausBot.app`。如果在构建时配置了 Developer ID 证书并完成公证（见下文），就不会出现这个提示。

> 临时签名的应用每次更新后签名都会变，macOS 可能会再次请求麦克风、辅助功能等权限，这是正常现象。

**关于自动更新**：中文版默认**不会**自动更新。原因是上游的更新源发布的是英文版，如果沿用，中文版会被覆盖成英文版。新版本请从你们团队的发布页下载安装；如果想开启自动更新，请看文末的“团队自建更新源”。

## 从源码构建 Mac 版

Mac 安装包只能在 macOS 上构建，因为要用到 Swift、codesign 和 hdiutil。有两种方式。

### 方式一：GitHub Actions（推荐，不需要自己的 Mac）

仓库里已经带了工作流 `.github/workflows/package-mac-zh.yml`。

1. 把代码推送到你们自己的 GitHub 仓库。
2. 打开仓库的 **Actions → Package macOS (zh-CN) → Run workflow**。
3. 等构建完成（通常需要半小时以上），在运行结果的 **Artifacts** 里下载 `OpenMausBot-zh-mac-<版本>`，里面就是两个 dmg。
   - 勾选 “release” 会顺便创建一个 GitHub 预发布版本，并把 dmg 挂上去。
   - 推送 `zh-v*` 格式的标签（例如 `zh-v0.1.43`）也会自动触发构建和发布。

工作流里有两个并行的任务：一个在 Linux 上跑类型检查、单元测试和汉化覆盖检查；另一个在 macOS 上分别打 Apple 芯片和 Intel 两个包，并检查签名、启动打包后的服务端、确认中文词典已打进安装包。勾选 “release” 时，只有两个任务都通过才会发布。

**可选：正式签名与公证。** 在仓库的 Settings → Secrets 里加入以下密钥，工作流会自动改用 Developer ID 签名；再配上 App Store Connect API 密钥，就会自动公证。

| Secret | 内容 |
|---|---|
| `MAC_CERT_P12_BASE64` | Developer ID Application 证书（.p12）的 base64 |
| `MAC_CERT_PASSWORD` | .p12 的密码 |
| `APPLE_API_KEY_P8_BASE64` | App Store Connect API 密钥（.p8）的 base64 |
| `APPLE_API_KEY_ID` | API 密钥 ID |
| `APPLE_API_ISSUER_ID` | Issuer ID |

### 方式二：在自己的 Mac 上构建

需要：一台 Mac、Xcode 命令行工具（`xcode-select --install`）、Node.js 24、pnpm。

```sh
pnpm install
# 没有开发者证书：临时签名
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package:mac -c.mac.identity=- -c.dmg.sign=false
# 有 Developer ID 证书（已装进钥匙串）：
pnpm package:mac
```

产物在 `release/` 目录：`OpenMausBot-<版本>-arm64.dmg`（Apple 芯片）和 `OpenMausBot-<版本>-x64.dmg`（Intel）。

### 开发调试

```sh
pnpm dev:server    # 服务端 → 127.0.0.1:8799
pnpm dev           # 界面 → http://127.0.0.1:5199
pnpm dev:desktop   # Electron 外壳；上面两个命令要保持运行
```

---

## 接入 WorkBuddy

[WorkBuddy](https://www.workbuddy.ai) 是腾讯的 AI 工作台，它的命令行引擎是 CodeBuddy Code（命令名 `codebuddy`）。OpenMausBot 通过 ACP 协议驱动它，所以每个机器人都可以选择 WorkBuddy 作为“大脑”。

1. **安装引擎**（二选一）：
   ```sh
   npm install -g @tencent-ai/codebuddy-code        # 需要 Node.js 18.20+
   brew install Tencent-CodeBuddy/tap/codebuddy-code # 不需要 Node.js
   ```
2. **登录**：在“终端”里运行一次 `codebuddy`，用 WorkBuddy 账号登录。也可以不登录，改为在 **设置 → 引擎 → WorkBuddy** 里粘贴 API 密钥。密钥加密保存在本机（由系统钥匙串保护），只交给 WorkBuddy 引擎使用。
3. **选择版本**：同一页面选“国际版 / 国内版 / 腾讯 iOA 版”，要和账号注册时的版本一致。在中国大陆注册的账号选“国内版”。
4. **选模型**：在机器人的模型选择器里选 “WorkBuddy”。可用的模型会从你的账号自动读取（最多每 6 小时刷新一次），“WorkBuddy 默认模型”始终可用。

不知道登录状态时，应用会按“已登录”处理。如果一轮对话因为未登录而失败，会直接提示登录步骤。

### 反过来：在 WorkBuddy 里调度 OpenMausBot 团队

OpenMausBot 自带一个 MCP 服务，可以在 WorkBuddy / CodeBuddy 里查看机器人、派活、等结果。应用运行时执行：

```sh
codebuddy mcp add-json --scope user openmausbot '{"type":"stdio","command":"/Applications/OpenMausBot.app/Contents/MacOS/OpenMausBot","args":["/Applications/OpenMausBot.app/Contents/Resources/server/mcp-server.js"],"env":{"ELECTRON_RUN_AS_NODE":"1"}}'
```

这个 MCP 服务刻意不提供审批、删除、修改凭据等高风险操作，这些仍然只能在应用里由你完成。详见 [docs/mcp-server.md](docs/mcp-server.md)。

---

## 总控自动派发与模型推荐

把某个分组里的一个机器人设为**总控**（在工作台里右键机器人 →“设为总控”，或在该机器人的设置里打开“总控”开关），然后直接把需求交给它。

- **自动拆解**：遇到包含多项工作的需求，总控会调用 `submit_plan` 一次性提交计划：每个子任务都有独立的说明、需要的角色、能力需求（写代码、推理、写作、中文、视觉、操控电脑、长上下文、速度）、难度（1–5），以及依赖关系。
- **自动分派**：每个子任务派给总控团队里最匹配的成员（按职位和描述匹配）。总控团队由工作台上的连线决定：同一分组的成员默认已接线，从其他分组接过来的机器人也算在内，拔掉线的成员不会再被派活。没有合适的人时，自动新建一名专员，按推荐结果配置模型，并接到总控下面。
- **并行与依赖**：没有依赖的子任务并行执行（同时运行的数量可设置），有依赖的会等前置任务完成后，带着前置结果再开始。失败会自动重试；前置任务失败时，依赖它的任务会被跳过。
- **汇总**：全部结束后，总控在自己的对话里写一份汇总报告。

**模型推荐**会综合任务难度、能力需求和每个可用引擎的模型（API 和 CLI 都算），在三种策略之间权衡：

| 策略 | 做法 |
|---|---|
| 质量优先 | 选能胜任的最强模型 |
| 均衡（默认） | 难的任务用强模型，日常任务用又快又省的 |
| 省钱 | 选仍能完成任务的最便宜模型 |

需要用工具（读写文件、执行命令、联网）的任务，只会推荐能挂载工具的引擎；需要操控电脑或看图的任务，也只会推荐具备相应能力的引擎。

相关设置都在 **设置 → 通用 → 自动派发**：开关、是否自动新建专员、计划开始前是否先问你、是否生成汇总报告、模型策略，以及并发数、每个计划的子任务上限、新建机器人上限和重试次数。

## 工作台

点侧边栏的 **工作台**（或按 ⇧⌘B）。每个分组是一块区域，总控在上方，成员在下方；所有派发计划都显示在底部的**任务看板**里，可以开始、取消，也可以重试失败的子任务。

- **连线**：从总控卡片下方的“派发”插头拖出电线，接到任意机器人（包括其他分组的机器人）的插座上，它就加入了这位总控的团队。选中一根线按 ⌫ 可以拔掉，被拔掉的成员不会再收到这位总控的派发；右键连线选“恢复默认”可以撤销手动改动。
- **鼠标和触控板**：双指捏合或 ⌘+滚轮缩放，双指滑动平移，拖动卡片调整位置（位置会被记住）。
- **快捷键**：⌘Z / ⇧⌘Z 撤销和重做（连线和挪位都可以撤销），⌘0 适应窗口，⌘= / ⌘- 缩放，⌥⌘I 显示或隐藏检查器，↩ 打开选中机器人的对话，Esc 取消选择。
- **右键菜单**：在机器人卡片上右键，可以打开对话、设为或取消总控、换成推荐模型、拔掉它的所有连线、复位位置；在连线上右键，可以拔线、恢复默认、打开对话；在空白处右键，可以自动整理、适应窗口、新建机器人、编辑分组的共享上下文。
- **检查器**：选中机器人后，可以看到它适合的模型推荐，一键切换。选中连线后，可以看到这条线是默认连接还是手动接上的。没选中任何东西时，可以直接在这里给总控下达任务。

## 语言

**设置 → 通用 → 语言** 可以在“简体中文”和 “English” 之间切换。切换后会作用于界面、菜单栏，以及机器人回复你时使用的语言；代码、命令和文件名始终保持原样。

## 隐私

- 上游项目默认会把匿名使用统计发送到上游开发者设在美国的 PostHog。中文版**默认关闭**，需要的话可以在 设置 → 通用 → 使用情况分析 里手动开启。
- 首次启动时填写的名字和邮箱都是可选的，只显示在侧边栏，并且只保存在这台电脑上。
- 安装版会把 API 密钥加密保存在本机（由系统钥匙串保护），每个密钥只交给需要它的那个引擎。

---

## 给开发者：汉化是怎么做的

- 源码里的英文就是翻译的键：`t("Team map")` 会在中文词典里查找对应译文，查不到时显示英文原文。复数用 `tn(count, "{count} bot", "{count} bots")`；需要先存储、显示时再翻译的标签用 `msg("…")` 标记，显示处再调用 `t(label)`。
- 唯一的词典是 `shared/i18n/zh-CN.json`。界面、服务端和 Electron 外壳共用这一份词典。
- `pnpm i18n:check` 会检查每个 `t()` 源串是否都有译文、占位符是否一致。CI 会运行这个检查，`--report` 参数会额外列出可能漏包 `t()` 的界面文案。
- 新增文案的流程：在代码里用 `t("English text")` → 把译文写进 `shared/i18n/fragments/<名字>.json` → 运行 `pnpm i18n:merge`。
- 测试统一以英文运行（检测到 `VITEST` / `NODE_TEST_CONTEXT` 时自动切到英文，也可以用 `OMB_LOCALE=en` 强制指定），所以上游的英文断言都保持不变。
- 发给模型的内容（系统提示词、工具描述、协议字符串）保持英文，界面依赖做比较的值也保持英文，翻译只在显示时进行。

## 团队自建更新源（可选）

如果想让团队成员的中文版自动更新，需要两步：

1. 在 `electron-builder.yml` 里把 `publish: null` 改成你们自己的发布仓库：
   ```yaml
   publish:
     - provider: github
       owner: <你的组织>
       repo: <发布仓库>
   ```
2. 每次发版时，把 `release/` 目录里的 `latest-mac.yml`、两个 `.zip` 和两个 `.dmg` 一起上传到该仓库的 Release，并使用比当前更高的版本号。

自动更新要求应用经过 Developer ID 签名，临时签名的应用无法自动更新。

## 许可

本项目基于 Apache License 2.0 发布，详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。WorkBuddy、CodeBuddy 为腾讯公司的产品和商标；本项目与腾讯公司、上游项目均无隶属关系。
