# WorkBuddy 默认模型实现计划

**目标：** 默认选择并实际调用 `deepseek-v4.1-flash`。

**结构：** 修改 WorkBuddy 驱动与其测试，复用现有 ACP 会话设置。移除 `default` 占位项并兼容历史输入，遵守本地模型白名单；新增启动时的旧 Bot 默认项迁移及持久化测试。

**技术：** TypeScript、Vitest、ACP、pnpm。

- [x] 从最新 `origin/main` 创建 `fix/workbuddy-deepseek-default`。
- [x] 修正现有模型目录测试的固定英文断言，运行 `pnpm vitest run server/drivers/acp/workbuddy.test.ts`，确认基线 16 项通过。
- [x] 在同一测试文件断言：无模型或历史占位项时 argv 包含 `--model deepseek-v4.1-flash`；目录移除占位项且默认值及首项是 DeepSeek；白名单排除它时选允许的真实模型；默认完整回合通过 argv 与 `session/set_model` 指定 DeepSeek。
- [x] 运行上述测试，确认失败原因是目前默认模型仍为 CLI 自选。
- [x] 在 `server/drivers/acp/workbuddy.ts` 设置默认模型常量，更新静态目录与动态目录，修改历史占位项及未指定模型时的 argv 和会话设置。
- [x] 新增 `server/workbuddy-defaults.test.ts`，验证重启后迁移持久化、明确模型选择与其他引擎保持原值；观察测试失败后实现迁移，并在 `server/index.ts` 启动时调用。
- [x] 新增 `server/workbuddy-onboarding.test.ts`，通过真实隔离服务验证首启引导、新建 Bot、历史默认值输入和旧 Bot 迁移共 5 项；API 收到历史 `default` 时，在忙碌及可用模型校验前解析为实例真实默认。
- [x] 运行 WorkBuddy 驱动、迁移、新建接口、共享 ACP 和设置模型测试，5 个文件共 103 项通过。
- [x] 执行 `pnpm typecheck`、`node scripts/i18n-merge.mjs`、`node scripts/i18n-check.mjs`、定向 oxlint 与独立代码审查；类型通过、缺失中文及占位符错误为 0，静态检查仅有 index.ts 既有无用展开警告。
- [x] `pnpm build:server` 和脱离 node_modules 的服务包启动检查通过。
- [x] 按老板更新后的流程，完整备份 `/Applications/Ein.app` 到忽略目录 `release/local-backups/workbuddy-before-deepseek-20261017/Ein.app`；安装本机服务包并重新签名，`codesign --verify --deep --strict` 通过，安装文件 SHA-256 与构建文件一致。
- [ ] 将修改保存为本地提交，汇报本机验收方式；不推送或发布。

## 本机验收与后续发布

老板于 2026-10-17 明确改为先在本机修复、构建安装并使用，累计一批改动、确认差不多后再批准推送及统一构建开发版。正式版仍需明确「发布正式版」。该偏好已写入 Ein 维护的私人长期记忆。

本机应用原版本标识为 `1.1.3-dev.7`，本次本地修复不增加远端版本号、不生成 GitHub 运行链接。当前维护回合运行在同一个 Ein 客户端，须在回合结束后完全退出并重开，才能加载已安装的新服务代码。
