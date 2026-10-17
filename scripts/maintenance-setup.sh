#!/bin/bash
# 一念 Ein 维护岗快速设置（Mac）：装好 GitHub CLI、登录、下载源码。
# 用法：在终端运行  bash 维护岗快速设置.sh  [源码目录，默认 ~/Ein-src]
set -e
DEST="${1:-$HOME/Ein-src}"
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if ! command -v git >/dev/null 2>&1; then
  say "需要先装 git：在终端运行 xcode-select --install，装完再运行本脚本。"
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    say "需要 Homebrew 来安装 GitHub CLI。先按 https://brew.sh 页面上的一行命令装好 Homebrew，再运行本脚本。"
    exit 1
  fi
  say "正在安装 GitHub CLI（gh）…"
  brew install gh
fi
if ! gh auth status >/dev/null 2>&1; then
  say "登录 GitHub（请用 kairuioba 账号）…"
  gh auth login --hostname github.com --git-protocol https --web
fi
perm=$(gh api repos/kairuioba/ein --jq .permissions.push 2>/dev/null || echo false)
if [ "$perm" != "true" ]; then
  say "这个 GitHub 账号没有 kairuioba/ein 的推送权限，维护岗不会出现。请换 kairuioba 账号登录：gh auth login"
  exit 1
fi
# git push 也用 gh 的登录
gh auth setup-git >/dev/null 2>&1 || true
if [ -d "$DEST/.git" ]; then
  say "源码已在 $DEST，更新到最新…"
  git -C "$DEST" fetch --all --tags --prune
  git -C "$DEST" switch main >/dev/null 2>&1 || true
  git -C "$DEST" pull --ff-only || true
else
  say "下载源码到 $DEST …"
  gh repo clone kairuioba/ein "$DEST"
fi
say "完成。打开一念 → 设置 → 维护岗，源码路径填：$DEST"
