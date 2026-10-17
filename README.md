# 一念 Ein

> 一念起，万 Bot 动

**Your own team of AI bots, in a chat app.** 中文说明见 [README.zh-CN.md](README.zh-CN.md).

Every bot in the sidebar is a real agent — Claude, Codex, Grok, WorkBuddy, Gemini and other engines running on your
own computer, each signed in with your own account or key. A chief of staff splits a request into subtasks, picks the
right teammate for each, recommends a model and a thinking level per task (you can switch to any signed-in model and
any level), runs them in parallel with dependencies, and writes the summary when the team is done.

## Install

Installers are published at [kairuioba/ein-releases](https://github.com/kairuioba/ein-releases/releases/latest):

| Computer | File |
|---|---|
| Mac, Apple silicon | `Ein-<version>-arm64.dmg` |
| Mac, Intel | `Ein-<version>-x64.dmg` |
| Windows, 64-bit | `Ein-<version>-setup.exe` |

On a Mac, drag Ein into Applications and open it from there. The build is not notarized yet, so the first launch needs
**System Settings → Privacy & Security → Open Anyway** once. Ein then checks for updates itself (Settings → Updates) and
installs them in place. Data lives in `~/.ein`.

## Network

Ein talks to the model providers you sign in to, and to [kairuioba/ein-releases](https://github.com/kairuioba/ein-releases)
for updates — no relay or analytics service in between. Features that need Ein's own online service (usage
analytics, hosted connected apps, the team template catalog, phone access from outside your network) are kept in the
app and marked **Not available yet** until that service exists. Pairing a phone on the same Wi-Fi, connecting apps with
your own Composio key, and importing teams from a file or GitHub link work today.

## Develop

```sh
pnpm install
pnpm dev:server    # harness server → 127.0.0.1:8799
pnpm dev           # UI → http://127.0.0.1:5199
pnpm dev:desktop   # Electron shell; keep the two above running
```

Releases: [docs/releasing-ein.md](docs/releasing-ein.md). Team collaboration design: [docs/company-layer.md](docs/company-layer.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Ein includes code from the open-source OpenMausBot
project (Apache-2.0); its notice is kept in NOTICE.
