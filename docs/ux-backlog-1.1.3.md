# 一念 Ein UX 待办清单（1.1.3 准备轮起）

> 规则：所有用户体验反馈先记到这里，再排期实现；实现后把状态改成 ✅ 并写清分支/commit。
> 最后更新：2026-10-17（1.1.3 准备轮）。

## 一、已反馈 & 已修（本地分支，待新构建验证）

| # | 反馈 | 处理 | 分支 / commit |
|---|---|---|---|
| 1 | macOS 每次打开都弹「一念想控制此 Mac 并访问你的数据」 | 启动时只读检查 TCC，不再主动申请权限；只在设置页「重试」时提示。**根治需 Apple Developer 签名** | `fix/cua-startup-permissions` `555c390` |
| 2 | 侧栏最右侧小图标（归档）和时间/未读点叠在一起 | 悬停时右列时间与未读点淡出，归档按钮干净覆盖 | `fix/sidebar-row-hover-overlap` `bd8381a` |
| 3 | 维护岗模型选择太少，要列出全部 WorkBuddy 模型并分组 | 选择器改为 `Cloud`（OpenAI/GPT 系）/ `WorkBuddy`（全部模型）/ 其它引擎（各一项默认）三组，选中的模型会保存给维护机器人 | `fix/maintenance-model-groups` `a6cb0ae` |
| 4 | 维护岗配置（源码路径/bot/渠道）重启后丢失 | `saveConfig()` 补 `maintenance` 白名单 + 回归测试 | `fix/maintenance-config-persist` `635d3f5` |
| 5 | 维护机器人聊天里一堆红色命令，看不懂是什么 | 工具步骤显示「运行命令」等短标签，原命令放 tooltip，失败只加红色小标记；维护手册要求用中文叙述「在修什么/怎么修/测试结果」；本机补 node/pnpm 软链让命令不再因缺工具而失败 | `fix/tool-activity-narration` `b8213d8` |
| 6 | 新建 Bot 默认落到还没填 Key 的引擎，第一条消息就失败 | 默认引擎只跳过明确报告「credential 未配置」的引擎 | `fix/default-selection-authenticated` `c5fb561`+`602920a` |
| 7 | WorkBuddy 列表里「WorkBuddy 默认模型」占位项；要求 DeepSeek V4.1 排第一并默认 | 老板的「Ein 维护」机器人已在 `fix/workbuddy-deepseek-default` 完成（去掉占位模型、DeepSeek V4.1 Flash 置顶并默认、旧 Bot 自动迁移、ACP 回合固定真实 model id）；Lead 已复核并合并进 `review/1.1.3`，未覆盖 | `fix/workbuddy-deepseek-default` `589965b` |

## 二、待办（按优先级）

| # | 事项 | 说明 | 建议做法 |
|---|---|---|---|
| A | 未签名 Mac 包的系统成本 | 首次「仍要打开」、每次更新后辅助功能/屏幕录制权限可能重问；权限弹窗反复出现的根因 | 购买 Apple Developer（$99/年），Developer ID 签名 + 公证；或接受并用文档解释 |
| B | 把本轮的修复发成新 dev 构建 | 现在装的 `1.1.3-dev.7` 不含上述修复 | 老板批准 push → 合并到 `fix/1.1.3-prep` → 维护岗「发开发版」→ 开发渠道自动更新 |
| C | 维护机器人进度展示再优化 | 现在靠模型中文叙述 + 短标签；可进一步把连续命令折叠为「正在复现/正在跑测试」摘要卡 | 在活动行按工具类型折叠、成功命令默认收进「步骤」抽屉 |
| D | WorkBuddy 环境切换后的模型刷新提示 | `international/internal/ioa` 切换后清单要重新探测（现在 6 小时/失败 2 分钟） | 切换环境时立即触发一次后台探测，并在选择器显示「正在刷新」 |
| E | 完整交互走查 | 首次启动、引擎登录卡、选模型、单聊/群聊/总控、插话、侧栏、⌘K、各设置页、资料库、日历、应用、错误态 | 按清单逐步截图记录（无额度阻塞） |
| F | 真实派单模拟 | 用便宜模型扮演员工，核对总控汇报是否只陈述实际交付 | 需要可用的便宜引擎 + 额度 |
| G | 开发版构建首次三平台核对 | 确认 macOS/Windows/Linux 只在开发渠道收到 | 修完 Windows flag 后跑一次三平台 dev 构建 |
| H | 文档同步 | 使用手册未含 Claude API 引擎、维护岗模型分组、权限弹窗新行为 | 发版前一并更新 `docs/使用手册-*.md` |
