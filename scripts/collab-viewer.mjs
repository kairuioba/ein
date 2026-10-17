#!/usr/bin/env node
// 「一念 × Claude」协作实时看板：本地只读 HTTP 服务，给老板实时看
//   ① 我们怎么问的  ② Claude 怎么回答  ③ 我接下来做了什么  ④ 阶段结论
// 数据来自 docs/collab/transcript.jsonl（每次调用追加）与 ~/.ein/claude-collab/state.json。
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.COLLAB_PORT ?? 8899);
const REPO = process.cwd();
const TRANSCRIPT = join(REPO, "docs", "collab", "transcript.jsonl");
const STATE = join(homedir(), ".ein", "claude-collab", "state.json");

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
};
const readTranscript = () => {
  try {
    return readFileSync(TRANSCRIPT, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>一念 Ein × Claude 实时协作</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "PingFang SC", -apple-system, sans-serif; background: #f4f5f7; color: #14161c; padding: 22px 26px 60px; }
  h1 { font-size: 20px; }
  .meta { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0 20px; }
  .chip { background: #fff; border-radius: 999px; padding: 6px 12px; font-size: 12.5px; color: #3a3f48; box-shadow: inset 0 0 0 1px #e2e5ea; }
  .chip b { color: #14161c; }
  .chip.live { background: #14161c; color: #fff; }
  .chip.live b { color: #fff; }
  .round { background: #fff; border-radius: 16px; box-shadow: inset 0 0 0 1px #e2e5ea; margin-bottom: 16px; overflow: hidden; }
  .round-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #eef0f3; font-size: 13.5px; font-weight: 700; }
  .tag { font-size: 11px; font-weight: 600; border-radius: 999px; padding: 2px 8px; background: #eef1ff; color: #3b5bff; }
  .block { padding: 12px 16px; border-bottom: 1px solid #f1f3f6; }
  .block:last-child { border-bottom: 0; }
  .label { font-size: 11.5px; font-weight: 700; letter-spacing: .02em; margin-bottom: 6px; }
  .ask .label { color: #6b7280; }
  .answer .label { color: #15803d; }
  .note .label { color: #3b5bff; }
  .conclusion .label { color: #b45309; }
  pre { white-space: pre-wrap; word-break: break-word; font-family: "PingFang SC", -apple-system, sans-serif; font-size: 12.8px; line-height: 1.6; color: #2b3038; }
  .note pre { color: #1e3a8a; background: #f5f8ff; border-radius: 10px; padding: 10px 12px; }
  .conclusion pre { color: #7c4a02; background: #fff8ea; border-radius: 10px; padding: 10px 12px; }
  .cost { font-size: 11px; color: #8a8f99; margin-top: 6px; }
  .empty { padding: 30px; text-align: center; color: #8a8f99; font-size: 13px; }
  .refresh { position: fixed; right: 18px; bottom: 16px; background: #14161c; color: #fff; border-radius: 999px; padding: 7px 12px; font-size: 11.5px; opacity: .85; }
</style></head>
<body>
  <h1>一念 Ein × Claude 实时协作</h1>
  <div class="meta" id="meta"></div>
  <div id="feed"><div class="empty">等待第一轮协作…</div></div>
  <div class="refresh" id="refresh">自动刷新中</div>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtCost = (n) => "$" + (Number(n) || 0).toFixed(4);
async function tick() {
  try {
    const res = await fetch("/api/data", { cache: "no-store" });
    const data = await res.json();
    render(data);
    document.getElementById("refresh").textContent = "自动刷新中 · 刚刚更新 " + new Date().toLocaleTimeString("zh-CN");
  } catch (e) {
    document.getElementById("refresh").textContent = "刷新失败，稍后重试";
  }
}
function render({ transcript, state }) {
  const meta = document.getElementById("meta");
  const remaining = state.windowStartedAt ? Math.max(0, Math.round((5 * 3600 * 1000 - (Date.now() - state.windowStartedAt)) / 60000)) : null;
  meta.innerHTML = [
    '<span class="chip live">● 实时</span>',
    '<span class="chip">模型 <b>Sonnet 5.5 · 中等</b></span>',
    '<span class="chip">调用 <b>' + (state.calls || 0) + '/12</b></span>',
    '<span class="chip">累计花费 <b>' + fmtCost(state.totalCostUsd) + '</b></span>',
    remaining !== null ? '<span class="chip">窗口剩余 <b>' + remaining + ' 分钟</b></span>' : "",
    state.stoppedReason ? '<span class="chip">已停止：' + esc(state.stoppedReason) + '</span>' : "",
  ].join("");
  const feed = document.getElementById("feed");
  const rounds = new Map();
  const notes = [];
  for (const e of transcript) {
    if (e.kind === "ask" || e.kind === "answer") {
      const key = e.slug || "round";
      if (!rounds.has(key)) rounds.set(key, { slug: key, ask: null, answer: null, notes: [], conclusions: [], at: e.ts });
      const r = rounds.get(key);
      if (e.kind === "ask") r.ask = e;
      else { r.answer = e; r.at = Math.max(r.at, e.ts); }
    } else if (e.kind === "note" || e.kind === "conclusion") notes.push(e);
  }
  const list = [...rounds.values()].sort((a, b) => a.at - b.at);
  if (!list.length && !notes.length) { feed.innerHTML = '<div class="empty">等待第一轮协作…</div>'; return; }
  let html = "";
  let index = 0;
  for (const r of list) {
    index += 1;
    const after = notes.filter((n) => n.ts >= r.at);
    html += '<div class="round"><div class="round-head"><span class="tag">第 ' + index + ' 轮</span><span>' + esc(r.slug) + '</span></div>';
    if (r.ask) html += '<div class="block ask"><div class="label">① 我们怎么问的</div><pre>' + esc(r.ask.text) + '</pre></div>';
    if (r.answer) html += '<div class="block answer"><div class="label">② Claude 怎么回答的</div><pre>' + esc(r.answer.text) + '</pre>' + (r.answer.costUsd ? '<div class="cost">本次 ' + fmtCost(r.answer.costUsd) + ' · 耗时 ' + Math.round((r.answer.durationMs || 0) / 1000) + 's</div>' : '') + '</div>';
    const roundNotes = after.filter((n) => n.kind === "note");
    const roundConclusions = after.filter((n) => n.kind === "conclusion");
    if (roundNotes.length) html += '<div class="block note"><div class="label">③ 我接下来做了什么</div><pre>' + esc(roundNotes.map((n) => "· " + n.text).join("\n")) + '</pre></div>';
    if (roundConclusions.length) html += '<div class="block conclusion"><div class="label">④ 阶段结论</div><pre>' + esc(roundConclusions.map((n) => "· " + n.text).join("\n")) + '</pre></div>';
    html += '</div>';
  }
  feed.innerHTML = html;
}
tick();
setInterval(tick, 2000);
</script></body></html>`;

createServer((req, res) => {
  if (req.url === "/api/data") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ transcript: readTranscript(), state: readState() }));
    return;
  }
  if (req.url === "/" || req.url?.startsWith("/?")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGE);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`collab viewer: http://127.0.0.1:${PORT}`);
});
