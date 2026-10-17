# 一念 Ein：GitHub 版本与备份规则

目的只有一个：**任何时候改乱了，都能回到任何一个之前的版本**；没有你的确认，用户那边不会变。

## 1. 两个仓库

| 仓库 | 可见性 | 放什么 |
|---|---|---|
| `kairuioba/ein` | 私有 | 源码。所有修改都在这里 |
| `kairuioba/ein-releases` | 公开 | 只放安装包和更新文件。每台装了一念的电脑都从这里检查更新 |

上游 `CuriosityOS/OpenMausBot`（remote 名 `upstream`）**永远不推**。

## 2. 分支

| 分支 | 规则 |
|---|---|
| `main` | 只放已经发布、或马上要发布为正式版的代码。只有点「发布正式版」之前才合入；**永不 force-push、永不改写历史** |
| `fix/<主题>` | 每个 bug 或改进一个分支，从最新的 main 开出来。开发版就从这里构建 |
| 用完的分支 | **不删**，留作记录和退路 |

main 出了问题，用 `git revert -m 1 <那次合并的提交>` 撤回，不要 reset。

## 3. 版本号

- 正式版：`主.次.补丁`，例如 `1.1.2`。每次发布正式版，`package.json` 的 version 至少加一个补丁号。
- 开发版：`主.次.(补丁+1)-dev.<运行号>`，例如在 1.1.2 之上构建出 `1.1.3-dev.7`。工作流自动生成，不用手改。
- 顺序：`1.1.2 < 1.1.3-dev.7 < 1.1.3-dev.10 < 1.1.3`。所以开发版会高于当前正式版；开发版转正之后，开发渠道的电脑会自动升到那个正式版。

## 4. 两个更新渠道

| 渠道 | 谁 | 读哪里 |
|---|---|---|
| 正式版（stable） | 所有用户（默认） | `ein-releases` 里标为 **Latest** 的正式发布 |
| 开发版（dev） | 只有你在「维护岗」里切过去的电脑 | `ein-releases` 的滚动预发布 `dev`：每次开发版构建都会覆盖它 |

开发版一律以 **prerelease** 发布，永远不标 Latest，正式渠道看不到。

## 5. 每次构建自动留下的备份

| 备份 | 在哪里 | 怎么用 |
|---|---|---|
| 源码标签 `backup/v<版本>` | `kairuioba/ein` | 那一版构建用的精确源码 |
| 正式版安装包 `v<版本>` | `ein-releases`（正式发布） | 装回任何一个旧正式版 |
| 开发版安装包 `v<主.次.补丁>-dev.<N>` | `ein-releases`（预发布） | 装回任何一个旧开发版 |

## 6. 发布流程

**发开发版**（维护岗按钮，或命令行）：

```
gh workflow run release-ein.yml -R kairuioba/ein --ref main -f ref=fix/<主题> -f channel=dev
```

**发布正式版**（必须先在开发版上核实无误）：

1. 把分支合进 main：`git switch main && git pull && git merge --no-ff fix/<主题>`。
2. `package.json` 的 version 加一，提交并 `git push origin main`。
3. 等 CI 全绿，再触发发布：

```
gh workflow run release-ein.yml -R kairuioba/ein --ref main -f ref=main -f channel=stable
```

推送和发布都要你先批准：「Ein 维护」机器人会先问你，维护岗的按钮也要求再确认一次。

## 7. 找回与回退

| 想要 | 做法 |
|---|---|
| 客户端从开发版回到正式版 | 维护岗 → 更新渠道选「正式版」→ 重启一念。会回到最新正式版 |
| 装回某个旧版本 | 在 `ein-releases` 的发布列表里下载那一版的安装包，重新安装 |
| 拿回某一版的源码 | `git fetch --tags && git switch -c restore/<版本> backup/v<版本>` |
| 撤销 main 上的一次合并 | `git revert -m 1 <合并提交>`，提交后再发一个补丁版本 |
| 某个分支改乱了 | 直接放弃它，从 main 重新开一个分支；旧分支保留不删 |

## 8. 绝对不做

- 推到上游 `CuriosityOS/OpenMausBot`；force-push main；删除 `backup/` 标签或旧发布。
- 删掉功能（暂不可用的模块显示「暂未开放」）；去掉 LICENSE / NOTICE（Apache-2.0）。
- 在界面放 Claude / Anthropic 的商标。
- 没有你的确认就发布正式版。
