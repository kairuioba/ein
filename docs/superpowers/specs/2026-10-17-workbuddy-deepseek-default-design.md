# WorkBuddy 默认选择 DeepSeek V4.1

用户要求把 Ein 中 WorkBuddy 的默认后端模型设为 DeepSeek V4.1。本机 CodeBuddy 2.168.2 的 `--help` 已确认其模型 ID 为 `deepseek-v4.1-flash`。

当前 `server/drivers/acp/workbuddy.ts` 的静态目录与动态目录均以 `default` 为默认值；未指定模型时不传 `--model`，实际模型由 CLI 决定。

按用户截图要求，从目录移除“WorkBuddy 默认模型”占位项。默认目录与尚未指定模型的调用改为 DeepSeek V4.1 Flash，同时通过 CLI 参数和支持该模型的 ACP 会话指定它。已有明确模型选择继续生效；历史 `default` 输入解析为真实目录默认值。启动时将已有 WorkBuddy Bot 的占位选择持久化为实例默认模型，保留自定义实例 ID 和推理等级。

用户 `models.json` 的白名单排除 DeepSeek 时，使用白名单首个真实模型；只有旧占位项的白名单回退到 DeepSeek。保留其他真实模型和自定义模型。

不新增界面文字；模型名称使用 `DeepSeek V4.1 Flash`，默认标记沿用中文翻译。用模型目录、白名单、fake CLI 完整回合与迁移持久化测试验证行为，再执行类型、i18n 与受影响代码静态检查。

首启引导与普通新建 Bot 均通过真实服务接口验证，兼容旧界面提交的 `default`，将其正规化为目录真实默认值后再验证并保存。交付采用老板确认的本机优先流程：本地构建、备份并安装客户端服务，老板使用一批修复后才批准远端开发版。
