#!/usr/bin/env node
// Claude 协作通道（受控）：我们（一念开发方）提问，Claude 只读评审、回答问题。
//
// 安全护栏（老板要求 + 防封号）：
//   - 只使用 Claude Code 官方 headless 模式（-p），不驱动桌面 UI、不碰登录态
//   - plan 权限模式 + 只读工具（Read/Grep/Glob）+ 自动拒绝一切需要授权的操作
//   - 单次调用预算上限；整个窗口 5 小时；调用次数、间隔都有上限
//   - 任何限额/认证/异常信号立即停止并记录
//   - 全部问答存 docs/collab/，可审计
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REPO = process.cwd();
const STATE_DIR = join(homedir(), ".ein", "claude-collab");
const STATE_FILE = join(STATE_DIR, "state.json");
const LOCK_FILE = join(STATE_DIR, "run.lock");
const OUT_DIR = join(REPO, "docs", "collab");
const TRANSCRIPT = join(OUT_DIR, "transcript.jsonl");
const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 小时窗口（老板只对时间有要求）
// No call-count or total-cost cap: the owner asked for unlimited Q&A within
// the time window. The per-call --max-budget-usd stays as a runaway guard, and
// the single-instance lock + interval keep the account out of abuse territory.
const MAX_CALLS = Number.POSITIVE_INFINITY;
const TOTAL_BUDGET_USD = Number.POSITIVE_INFINITY;
const MIN_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 300_000;

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const MODEL = arg("--model", "sonnet");
const EFFORT = arg("--effort", "medium");
const BUDGET = Number(arg("--budget", "1.5"));
const SLUG = arg("--slug", "review");
const askFile = arg("--ask", "");

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const loadState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { windowStartedAt: 0, calls: 0, totalCostUsd: 0, lastCallAt: 0, stoppedReason: null };
  }
};
const saveState = (state) => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const fail = (message, code = 1) => {
  console.error(`\n[claude-collab] ${message}`);
  process.exit(code);
};

const state = loadState();

if (args.includes("--status")) {
  const elapsed = state.windowStartedAt ? Date.now() - state.windowStartedAt : 0;
  console.log(JSON.stringify({ ...state, windowRemainingMs: state.windowStartedAt ? Math.max(0, WINDOW_MS - elapsed) : WINDOW_MS }, null, 2));
  process.exit(0);
}
if (args.includes("--reset-window")) {
  saveState({ windowStartedAt: Date.now(), calls: 0, totalCostUsd: 0, lastCallAt: 0, stoppedReason: null });
  console.log("collab window restarted");
  process.exit(0);
}

const append = (entry) => {
  try {
    writeFileSync(TRANSCRIPT, JSON.stringify({ ts: Date.now(), ...entry }) + "\n", { flag: "a" });
  } catch (error) {
    console.error("transcript append failed", error);
  }
};
for (const kind of ["note", "conclusion"]) {
  const i = args.indexOf(`--${kind}`);
  if (i < 0) continue;
  const note = args.slice(i + 1).join(" ").trim();
  if (!note) fail(`--${kind} 需要内容`);
  append({ kind, text: note, slug: SLUG });
  console.log(`${kind} appended`);
  process.exit(0);
}

// ── guards ────────────────────────────────────────────────────────────
if (state.stoppedReason) fail(`stopped: ${state.stoppedReason}（用 --status 查看；确认后可 --reset-window）`, 3);
if (!state.windowStartedAt) {
  saveState({ ...state, windowStartedAt: Date.now() });
  state.windowStartedAt = Date.now();
}
if (Date.now() - state.windowStartedAt > WINDOW_MS) fail("5 小时窗口已用完，停止协作。", 3);
// no call-count / total-cost caps (owner: only the time window matters)
if (Date.now() - (state.lastCallAt || 0) < MIN_INTERVAL_MS) {
  fail(`两次调用间隔不足 ${MIN_INTERVAL_MS / 1000}s，稍后再试（避免高频触发风控）。`, 2);
}
if (existsSync(LOCK_FILE)) {
  const lockAge = Date.now() - Number(readFileSync(LOCK_FILE, "utf8") || 0);
  if (lockAge < TIMEOUT_MS + 60_000) fail("另一次 Claude 调用正在进行，等待它结束。", 2);
}
writeFileSync(LOCK_FILE, String(Date.now()));

let prompt;
if (askFile === "-") prompt = readFileSync(0, "utf8");
else if (askFile) prompt = readFileSync(resolve(askFile), "utf8");
else fail("用法: node scripts/claude-collab.mjs --ask <prompt.md|-> [--slug name] [--budget 1.5] [--model sonnet] [--effort medium]");
prompt = prompt.trim();
if (!prompt) fail("问题为空");
if (prompt.length > 12_000) prompt = prompt.slice(0, 12_000) + "\n\n[已截断]";

const system = [
  "你是「一念 Ein」项目的架构评审顾问，与另一位工程 Agent 协作。",
  "只读评审：不要修改任何文件，不要执行命令，不要尝试安装或联网。",
  "给可执行的实现路径、取舍、风险与优先级；可以反问对方；用中文回答，简洁、直接、有观点。",
  "不要重复对方已经知道的内容；不要泛泛而谈；针对给出的具体问题回答。",
].join("");

const cliArgs = [
  "-p",
  "--permission-mode", "plan",
  "--permission-prompts", "none",
  "--allowedTools", "Read", "Grep", "Glob",
  "--output-format", "json",
  "--no-session-persistence",
  "--max-budget-usd", String(Math.min(BUDGET, TOTAL_BUDGET_USD - state.totalCostUsd)),
  "--model", MODEL,
  "--effort", EFFORT,
  "--append-system-prompt", system,
];

append({ kind: "ask", slug: SLUG, model: MODEL, effort: EFFORT, text: prompt, budgetUsd: BUDGET });
const started = Date.now();
const child = spawn("claude", cliArgs, { cwd: REPO, env: { ...process.env, CLAUDE_COLLAB: "1" } });
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));
child.stdin.write(prompt);
child.stdin.end();
const timer = setTimeout(() => {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 3_000);
}, TIMEOUT_MS);

child.on("close", (code) => {
  clearTimeout(timer);
  const durationMs = Date.now() - started;
  const combined = `${stdout}\n${stderr}`;
  const quota = /usage limit|rate.?limit|hit your limit|credit balance|quota|429|too many requests/i.test(combined);
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // keep raw
  }
  const answer = String(parsed?.result ?? parsed?.message ?? stdout ?? "").trim();
  const cost = Number(parsed?.total_cost_usd ?? parsed?.usage?.total_cost_usd ?? 0) || 0;
  const next = {
    ...loadState(),
    calls: (loadState().calls || 0) + 1,
    lastCallAt: Date.now(),
    totalCostUsd: (loadState().totalCostUsd || 0) + cost,
    ...(quota ? { stoppedReason: "额度/限流信号：Claude 报告用量限制，按约定停止。" } : {}),
    ...(code !== 0 && !quota ? { stoppedReason: `claude 异常退出 code=${code}` } : {}),
  };
  saveState(next);
  try {
    writeFileSync(LOCK_FILE, "");
  } catch {}

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const file = join(OUT_DIR, `${stamp}-${SLUG}.md`);
  const meta = [
    `# Claude 协作记录 · ${SLUG}`,
    "",
    `- 时间：${new Date().toISOString()}`,
    `- 模型：${MODEL}（effort ${EFFORT}）`,
    `- 耗时：${(durationMs / 1000).toFixed(1)}s`,
    `- 本次花费：$${cost.toFixed(4)}（累计 $${next.totalCostUsd.toFixed(4)} / 上限 $${TOTAL_BUDGET_USD}）`,
    `- 调用：第 ${next.calls} 次（窗口剩余 ${Math.max(0, Math.round((WINDOW_MS - (Date.now() - next.windowStartedAt)) / 60000))} 分钟）`,
    ...(quota ? ["- ⚠️ 检测到额度/限流信号，已按约定停止"] : []),
    "",
    "## 我们的问题",
    "",
    prompt,
    "",
    "## Claude 的回答",
    "",
    answer || "（无回答）",
    "",
    ...(answer ? [] : ["## 原始输出", "```", combined.slice(0, 8_000), "```"]),
  ].join("\n");
  writeFileSync(file, meta);
  append({
    kind: "answer",
    slug: SLUG,
    model: MODEL,
    effort: EFFORT,
    text: answer || "（无回答）",
    costUsd: cost,
    durationMs,
    call: next.calls,
    totalCostUsd: next.totalCostUsd,
    quota,
    file,
  });

  console.log(`\n=== Claude 回答（已存 ${file}）===\n`);
  console.log(answer || combined.slice(0, 4_000));
  console.error(`\n[claude-collab] 花费 $${cost.toFixed(4)}，累计 $${next.totalCostUsd.toFixed(4)}，调用 ${next.calls}/${MAX_CALLS}，耗时 ${(durationMs / 1000).toFixed(1)}s`);
  process.exit(quota ? 3 : code === 0 ? 0 : 2);
});
