# 一念 Ein：开发版（维护版）设计与剩余工作

更新于 2026-10-17，对应 main `fe45a94`（版本 1.1.2）。这份文档写给下一次接手的人（或下一轮会话）：照着做就能把没做完的部分补上。

## 一、本轮已完成并上传

| 问题 | 根因 | 改法 | 主要文件 |
|---|---|---|---|
| Claude 没有 Opus 5.5 | 模型清单写死在代码里，从不问已安装的 Claude Code | 用 Claude Code 的 `initialize` 控制请求读取它 `/model` 菜单的实时清单（不耗 token、不留会话），磁盘缓存，6 小时刷新、CLI 升级后立即刷新；兜底清单更新到最新，旧 ID 保留 | `server/drivers/claude-models.ts`、`claude.ts` |
| Grok 没有 4.7 | 同上，写死 4.6 / 4.5 | Grok Build 每开一个会话都会通告可用模型（ACP `models.availableModels`），把它记下来存盘；兜底从 4.7 起；Grok API 引擎改读 xAI `/models` | `server/drivers/acp/grok.ts`、`grok.ts` |
| 其他引擎同类问题 | 各自写死或阻塞式读取 | Cursor、Droid、Kimi、Qwen、Hermes、OpenCode、pi、Gemini、WorkBuddy、Antigravity、MiniMax 统一走后台缓存的实时清单 | `server/drivers/live-catalog.ts` 等 |
| 推荐总挑旧模型 | 同分时按名字字母排序，「Fable 5」排在「Fable 5.1」前面 | 同分时按引擎清单顺序（新的在前） | `shared/model-recommender.ts` |
| 反复弹「回合已中断——服务商设置已更改」 | 任何设置保存（派单策略、语言、某个 Key）都会重建全部引擎，掐断所有正在跑的回合 | 注册表按条目比对，只重建配置真正变了的引擎，只结算跑在它上面的回合 | `server/harness/registry.ts`、`bus.ts`、`index.ts` |
| Claude 用 API 计费却显示已登录 | 只看 `loggedIn`，不看登录方式 | 只认 claude.ai 订阅登录和 `setup-token` 的订阅 token；API Key、Console 账号、中转 Token、apiKeyHelper、Bedrock/Vertex 都算未登录，且拒绝跑云端回合；登录命令改为官方 `claude auth login --claudeai`。Codex 同理，只认 ChatGPT 登录 | `claude.ts`、`codex.ts`、`EngineSetup.tsx` |
| 回复时对话「顿」、最后一句被输入框挡住 | 绘制后才滚动、每个 token 整页重渲染；回复从列表移到输入行再移回时滚动没跟上 | 绘制前跟随到底部；流式更新只重绘当前气泡；群聊会议对象不再每次重建 | `src/hooks/use-bottom-follow.ts`、`ChatView.tsx` 等 |
| 新对话没出现在左下列表 | 新机器人和群聊排在最底，选中行不会滚到可见处 | 选中的对话自动滚进可见区域 | `Sidebar.tsx` |
| 插话显示「已排队」 | 只有 Claude 支持插话 | Codex 用原生 `turn/steer`；ACP 引擎（Grok、WorkBuddy、Kimi 等 9 个）在引擎声明支持时用 `_session/steering`，否则在安全点（不在工具执行或权限确认中）续接同一回合 | `codex.ts`、`acp/core.ts`、`index.ts` |
| 派单与部门协作 | 11 个逻辑漏洞（运行上限丢进行中的单、重试后卡死、旧报告提前收尾、主管绕过招人规则、重启后小队不解散、加人越过部门主管、预算只算本单等） | 逐个修复，每个都有先失败后通过的测试 | `server/dispatch.ts`、`server/org/*` |

## 二、没做完的事和怎么改

| # | 事项 | 现状 | 怎么改 |
|---|---|---|---|
| 1 | 开发版 / 维护岗 | 方案已定（见第三节），代码未开始 | 按第三节实现 |
| 2 | 插话：pi、Antigravity、API 类引擎（Grok API、OpenAI 兼容、MiniMax）、群聊输入框 | 仍会排队到本回合结束 | pi 的 RPC 模式有 `steer` 命令，接到 `pi.ts` 的 `steer`；API 类引擎在当前回复结束后、同一回合内立刻续一次带新消息的请求（`openai-chat.ts`）；群聊：服务端已能插话，把 `Composer.tsx` 里 `busy && group` 的本地排队分支改成：忙碌的机器人引擎 `capabilities.queueing` 为真时直接发服务端 |
| 3 | OpenAI 兼容引擎的模型清单 | 每次打开选择器都请求一次 `/models` | 改用 `live-catalog.ts` 的后台缓存 |
| 4 | 全部交互逐步走查 | 为省额度中途停了 | 按清单在真实客户端里走：首次启动、引擎登录卡、选模型、单聊/群聊/总控、插话、新对话与切任务、侧栏、⌘K、各设置页（尤其运行中改设置）、资料库、日历、应用、错误态；每一步截图记录 |
| 5 | 用便宜模型扮演员工的真实派单模拟 | 跑到一半停了。已观察到一处要核实：总控说「各项数字和上架资料都已按你的选择更新」，但它自己只写了三处 | 复跑模拟，核对总控的汇报是否只陈述员工实际交付的内容；必要时在汇总提示里要求逐项引用交付物 |
| 6 | 派单审计留下的 8 个设计缺口 | 未改 | `create_bot` 不受「新增专员」规则约束；部门编制从不校验；部门隔离只到资料库；工作台「加人」进不了部门计划；会议室决议不关联计划；重启时收尾的单没有「已完成」事件；无人值守状态可能残留；兜底计数与简报口径不同 |
| 7 | Claude API 单独做一个引擎 | 未做（你提的方向） | 新增实例：同一个 Claude 驱动，配置 `auth: "apiKey"`，Key 由用户在设置里填写（像 xAI Key 一样加密保存），计费标为按量；不自动检测本机任何 Key |
| 8 | 在你的 Mac 上实测 | 沙盒里无法验证 | 装 1.1.2 后看：Claude 选择器有 Opus 5.5；用 API Key 登录的 Claude Code 显示需要登录并说明原因；跑一次 Grok 后选择器出现 4.7；回复不卡、最后一句不被挡；Codex/Grok 插话立即生效 |

## 三、开发版设计（已确认的方案）

目标：同一套代码，你的版本和用户的版本不一样。你的电脑能直接让 AI 修 bug、先在自己客户端里核实，确认后才推给用户。

### 1. 两个更新渠道

- **正式版（stable）**：所有用户。只收 `kairuioba/ein-releases` 里标为 Latest 的正式发布，行为和现在完全一样。
- **开发版（dev）**：只有你的电脑。版本号形如 `1.1.3-dev.N`（N 为 CI 运行号），界面显示「开发版」角标。
- 版本顺序：`1.1.3 > 1.1.3-dev.2 > 1.1.2`（`electron/bundle-updater.mjs` 的 `compareVersions` 已经这样比较），所以开发版转正后，开发版客户端会自动升到正式版。
- 喂法：
  - Mac：`bundle-updater.mjs` 的 `feedUrl` 按渠道切换。正式版用 `…/releases/latest/download`；开发版用一个滚动标签 `dev` 的发布：`…/releases/download/dev`，每次开发版构建覆盖它的 `latest-mac.yml` 和 zip。
  - Windows/Linux：electron-updater 设 `allowPrerelease = true`、`channel = "dev"`，或同样指向滚动标签 `dev`。
  - 开发版发布一律标 prerelease，**永远不标 Latest**，正式渠道看不到。

### 2. 开发者模式只在你的电脑出现

- 判定：本机 `gh` 已登录，且 `gh api repos/kairuioba/ein --jq .permissions.push` 为 `true`。结果缓存一天，可手动重查。
- 满足才显示：「维护岗」设置页、渠道切换、「发布正式版」按钮。
- 用户的版本看不到这些，安装包里不放任何密钥；就算有人打开，没有推送权限也什么都做不了。

### 3. 维护岗（设置里单独一页）

- 选本机 Ein 源码目录。校验 `git remote get-url origin` 是 `kairuioba/ein`。
- 选引擎和模型（Codex、Claude……任何已就绪的引擎）。
- 自动在「研发部」建（或复用）一个「Ein 维护」机器人：工作目录就是源码仓库，自带维护手册：
  - 仓库结构，以及测试、类型检查、`node scripts/i18n-merge.mjs && node scripts/i18n-check.mjs` 的跑法。
  - 每个修复开一个分支 `fix/<主题>`。
  - 只推 origin，永不推上游 `CuriosityOS/OpenMausBot`，永不强推 main。
  - 推送和发版都要走 Ein 现有的「对外发布需批准」规则。
- 页面上显示当前修复的状态：分支、最新提交、测试结果、开发版版本号和 CI 运行链接、发布状态。

### 4. 流程

1. 你在任何对话里报 bug（文字加截图），总控派给「Ein 维护」，或者直接发给它。
2. 它复现、在分支上修改、跑测试；测试不过不往下走。
3. **你批准**后，它推分支，并运行 `gh workflow run release-ein.yml -f ref=<分支> -f channel=dev`。
4. CI 构建 `X.Y.Z-dev.N`，发布成 prerelease，并覆盖滚动标签 `dev` 的资源。
5. 你的开发版客户端收到更新，装上核实；其他几台电脑也能一起测。
6. 不满意：继续让它改；或者把渠道切回正式版，客户端回到最新正式版（这就是一键回退）。
7. 满意：点「发布正式版」，**再确认一次**。它把分支合进 main、升版本号，运行 `gh workflow run release-ein.yml -f ref=main`（channel 默认 stable），用户随后自动更新。

### 5. 工作流改动

- `release-ein.yml` 增加输入 `channel: stable | dev`（默认 stable，现有行为一字不变）。
- dev 时：
  - 用 `npm version --no-git-tag-version X.Y.Z-dev.${{ github.run_number }}` 改版本号；
  - electron-builder 发布为 prerelease；
  - 再用 `gh release upload dev <latest*.yml 和安装包> --clobber` 更新滚动标签。
- 先发一个开发版走一遍流程，确认三个平台都只在开发渠道收到。

### 6. 安全栏

- 正式渠道只在「发布正式版」时变化。
- 推送、发版各需一次批准。
- 测试是硬门槛。
- 只动你自己的仓库。
