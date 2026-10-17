// The developer edition: the owner's maintenance desk (维护岗).
//
// One codebase serves two kinds of install. Everyone gets the stable channel.
// On the owner's machines — where the signed-in GitHub CLI may push to the
// source repository — Ein also offers the maintenance desk: a bot that works
// in the owner's clone of the source, the dev update channel, and the buttons
// that build a dev version (only the owner's dev-channel clients get it) or
// publish the stable one. Nothing secret ships in the app: without push
// rights on the repository none of this is shown, and none of it would work.
//
// Backups: every build is tagged in the source repository (backup/v<version>)
// and every dev build stays downloadable as a prerelease, so any version can
// be found and reinstalled again; fixes live on their own branches and main
// only moves when the owner publishes.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

import { augmentedPath } from "./env-path.ts";

export const SOURCE_REPO = "kairuioba/ein";
export const RELEASES_REPO = "kairuioba/ein-releases";
export const RELEASE_WORKFLOW = "release-ein.yml";
export const MAINTENANCE_BOT_NAME = "Ein 维护";
export const MAINTENANCE_SECTION = "研发部";

export type UpdateChannel = "stable" | "dev";

export interface ToolResult {
  ok: boolean;
  /** stdout, plus stderr when the command failed */
  out: string;
  /** the program is not installed (or not on PATH) */
  missing?: boolean;
}

export type ToolRunner = (file: string, args: string[], cwd?: string) => Promise<ToolResult>;

/** Run git or gh with the same PATH the CLIs get (Homebrew included), never
 * prompting: a question nobody can answer would hang the request. */
export const runTool: ToolRunner = (file, args, cwd) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PATH: augmentedPath(), GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        const missing = (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
        resolve({ ok: !error, out: `${stdout ?? ""}${error ? `\n${stderr ?? ""}` : ""}`.trim(), ...(missing ? { missing } : {}) });
      },
    );
  });

export interface DeveloperStatus {
  /** this machine may maintain Ein: the GitHub CLI's account can push to the source repository */
  available: boolean;
  account?: string;
  /** why not: gh is not installed, not signed in, or the account has no push rights */
  reason?: "no-gh" | "signed-out" | "no-access";
  checkedAt: number;
}

let cachedStatus: DeveloperStatus | null = null;

/** Whether this machine is the owner's (see the header). Cached ten minutes. */
export async function developerStatus(run: ToolRunner = runTool, fresh = false): Promise<DeveloperStatus> {
  if (!fresh && cachedStatus && Date.now() - cachedStatus.checkedAt < 10 * 60_000) return cachedStatus;
  const checkedAt = Date.now();
  const push = await run("gh", ["api", `repos/${SOURCE_REPO}`, "--jq", ".permissions.push"]);
  let status: DeveloperStatus;
  if (push.missing) status = { available: false, reason: "no-gh", checkedAt };
  else if (!push.ok && /auth login|not logged in|authentication/i.test(push.out)) status = { available: false, reason: "signed-out", checkedAt };
  else if (!push.ok || push.out.trim() !== "true") status = { available: false, reason: "no-access", checkedAt };
  else {
    const user = await run("gh", ["api", "user", "--jq", ".login"]);
    status = { available: true, ...(user.ok && user.out.trim() ? { account: user.out.trim() } : {}), checkedAt };
  }
  cachedStatus = status;
  return status;
}

/** Tests: forget the cached answer. */
export function resetDeveloperStatus(): void {
  cachedStatus = null;
}

export interface RepoState {
  ok: boolean;
  reason?: "missing" | "not-git" | "other-repo";
  branch?: string;
  commit?: string;
  subject?: string;
  /** uncommitted changes in the working tree */
  dirty?: boolean;
}

/** The owner's clone: it must be a git checkout whose origin is the source repository. */
export async function repoState(path: string | undefined, run: ToolRunner = runTool): Promise<RepoState> {
  if (!path || !existsSync(path)) return { ok: false, reason: "missing" };
  const origin = await run("git", ["-C", path, "remote", "get-url", "origin"]);
  if (!origin.ok) return { ok: false, reason: "not-git" };
  if (!new RegExp(`[/:]${SOURCE_REPO.replace("/", "\\/")}(\\.git)?/?$`, "i").test(origin.out.trim())) {
    return { ok: false, reason: "other-repo" };
  }
  const [branch, head, status] = await Promise.all([
    run("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]),
    run("git", ["-C", path, "log", "-1", "--format=%h%x09%s"]),
    run("git", ["-C", path, "status", "--porcelain"]),
  ]);
  const [commit, ...subject] = head.out.split("\t");
  return {
    ok: true,
    ...(branch.ok ? { branch: branch.out.trim() } : {}),
    ...(head.ok && commit ? { commit: commit.trim(), subject: subject.join("\t").trim() } : {}),
    dirty: status.ok && status.out.trim().length > 0,
  };
}

export interface ReleaseRun {
  id: number;
  status: string;
  conclusion: string;
  title: string;
  branch: string;
  createdAt: string;
  url: string;
}

/** The latest runs of the release workflow (dev builds and stable releases). */
export async function recentReleases(run: ToolRunner = runTool): Promise<ReleaseRun[]> {
  const listed = await run("gh", [
    "run", "list", "-R", SOURCE_REPO, "-w", RELEASE_WORKFLOW, "-L", "6",
    "--json", "databaseId,status,conclusion,displayTitle,headBranch,createdAt,url",
  ]);
  if (!listed.ok) return [];
  try {
    const rows = JSON.parse(listed.out) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.databaseId) || 0,
      status: String(row.status ?? ""),
      conclusion: String(row.conclusion ?? ""),
      title: String(row.displayTitle ?? ""),
      branch: String(row.headBranch ?? ""),
      createdAt: String(row.createdAt ?? ""),
      url: String(row.url ?? ""),
    }));
  } catch {
    return [];
  }
}

/** A git ref the release workflow may build: a branch, tag or commit name,
 * never an option or anything a shell could read twice. */
export function validRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) && !ref.includes("..");
}

/** The gh arguments that start a build. The workflow definition always comes
 * from main (it carries the channel switch); `ref` is the code that is built. */
export function releaseArgs(channel: UpdateChannel, ref: string): string[] {
  return ["workflow", "run", RELEASE_WORKFLOW, "-R", SOURCE_REPO, "--ref", "main", "-f", `ref=${ref}`, "-f", `channel=${channel}`, "-f", "windows=true"];
}

/** Start a dev build of `ref` (only dev-channel installs get it) or the
 * stable release of main. */
export async function dispatchRelease(channel: UpdateChannel, ref: string, run: ToolRunner = runTool): Promise<ToolResult> {
  if (!validRef(ref)) return { ok: false, out: "invalid ref" };
  return run("gh", releaseArgs(channel, ref));
}

/** The maintenance bot's standing instructions (its persona, ≤ 4000 chars). */
export function maintenanceHandbook(repoPath: string): string {
  return [
    `你是「${MAINTENANCE_BOT_NAME}」，负责维护一念 Ein 本身。源码仓库在 ${repoPath}（origin = github.com/${SOURCE_REPO}）。`,
    "",
    "每次接到 bug 或改进：",
    "1. 先复现，说清楚现象和根因（文件:行号）。",
    "2. 从最新的 main 开一个分支：git switch -c fix/<简短英文主题>。一个问题一个分支，不要在 main 上直接改。",
    "3. 修改后跑相关测试和检查：受影响的 *.test.ts（pnpm vitest run <文件>），类型检查（pnpm typecheck 或 tsc -p tsconfig.json / tsconfig.server.json --noEmit），界面文字要有中文：node scripts/i18n-merge.mjs && node scripts/i18n-check.mjs。测试不过就继续改，不要往下走。",
    "4. 小步提交，提交信息写清楚改了什么、为什么。干活时在聊天里用中文说清楚进度：先一句复现/根因，再说改哪些文件，最后说测试结果——不要让聊天里只剩命令；命令失败先用一句人话说清原因再继续，别反复重试。",
    "5. 推送前先问老板（推送算对外发布，要批准）：git push -u origin <分支>。",
    `6. 老板同意后发开发版：gh workflow run ${RELEASE_WORKFLOW} -R ${SOURCE_REPO} --ref main -f ref=<分支> -f channel=dev。开发版只推给开发渠道，老板在自己的客户端里核实。`,
    `7. 老板核实无误、并明确说「发布正式版」后：把分支合进 main（git switch main && git pull && git merge --no-ff <分支>），把 package.json 的 version 加一个补丁号，提交并推送 main，再运行 gh workflow run ${RELEASE_WORKFLOW} -R ${SOURCE_REPO} --ref main -f ref=main -f channel=stable。`,
    "",
    "备份与回退：",
    "- 每次构建都会在源码仓库打标签 backup/v<版本>，要找回任何一版：git switch -c restore/<版本> backup/v<版本>。",
    "- 分支用完不要删；main 出问题就用 git revert 撤回那次合并，不要改写历史。",
    "",
    "绝对不要：",
    "- 推到上游 CuriosityOS/OpenMausBot（remote upstream），或 force-push main。",
    "- 删掉功能（暂不可用的模块显示「暂未开放」）、去掉 LICENSE / NOTICE。",
    "- 在界面里放 Claude / Anthropic 的商标。",
    "",
    "汇报时用中文，说清楚：改了什么、测试结果、分支名、开发版版本号和 GitHub 运行链接。",
  ].join("\n");
}
