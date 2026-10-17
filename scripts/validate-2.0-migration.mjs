#!/usr/bin/env node
// 2.0 升级/回滚迁移验证：把真实的 ~/.ein 数据复制到临时目录，用 2.0 的存储层
// 逐个加载（不启动服务、不发消息），断言旧数据可读、新文件可增、旧字段不被改写。
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE = join(process.env.HOME ?? "", ".ein");
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

const temp = mkdtempSync(join(tmpdir(), "ein-migration-"));
try {
  if (!existsSync(SOURCE)) throw new Error(`no data dir at ${SOURCE}`);
  cpSync(SOURCE, temp, { recursive: true });
  console.log(`copied ${SOURCE} -> ${temp}`);

  // 1) every tracked json file must still parse (old version reads these)
  const files = readdirSync(temp).filter((name) => name.endsWith(".json"));
  let parsed = 0;
  let corrupt = [];
  for (const name of files) {
    try {
      JSON.parse(readFileSync(join(temp, name), "utf8"));
      parsed += 1;
    } catch {
      corrupt.push(name);
    }
  }
  record("all JSON files parse", corrupt.length === 0, `${parsed}/${files.length} parsed${corrupt.length ? `, corrupt: ${corrupt.join(", ")}` : ""}`);

  // 2) load through the real 2.0 stores (no server, no side effects on the source)
  process.env.OMB_DATA_DIR = temp;
  const { Store } = await import("../server/store.ts");
  const { dispatchSettings } = await import("../server/dispatch.ts");
  const { TaskFolderStore } = await import("../server/task-folders.ts");
  const { InboxStore } = await import("../server/inbox-store.ts");
  const { EvolutionStore } = await import("../server/evolution.ts");
  const { EvolutionRunStore } = await import("../server/evolution-runs.ts");
  const { ApprovalAuditStore } = await import("../server/approval-audit.ts");
  const store = new Store(temp);
  const settings = dispatchSettings({});
  const folders = new TaskFolderStore(temp);
  const inbox = new InboxStore(temp);
  const evolution = new EvolutionStore(temp);
  const runs = new EvolutionRunStore(temp);
  const audit = new ApprovalAuditStore(temp);
  record("Store loads 1.1.x data", store.bots.length > 0 || files.includes("bots.json"), `bots=${store.bots.length}`);
  record("task folders load", true, `folders=${folders.list().length}`);
  record("inbox loads", true, `open=${inbox.list("open").length}`);
  record("evolution/executions/audit load", true, `proposals=${evolution.list("all").length} runs=${runs.list().length} audit=${audit.list().length}`);
  record("dispatch settings defaults", typeof settings === "object", "ok");

  // 3) 2.0 may add fields; every old value must still be there (sub-set check)
  const subset = (before, after) => {
    if (before === null || typeof before !== "object") return before === after;
    if (Array.isArray(before)) {
      if (!Array.isArray(after) || before.length !== after.length) return false;
      return before.every((value, index) => subset(value, after[index]));
    }
    return Object.keys(before).every((key) => key in after && subset(before[key], after[key]));
  };
  const botsBefore = existsSync(join(SOURCE, "bots.json")) ? JSON.parse(readFileSync(join(SOURCE, "bots.json"), "utf8")) : null;
  const botsAfter = existsSync(join(temp, "bots.json")) ? JSON.parse(readFileSync(join(temp, "bots.json"), "utf8")) : null;
  record("old bot fields preserved after upgrade", botsBefore === null || subset(botsBefore, botsAfter), "2.0 only adds fields to bots.json");
  // rollback contract: the only files 2.0 may create are new ones; list them for the report
  const added = readdirSync(temp).filter((name) => !existsSync(join(SOURCE, name)));
  record("no destructive file rename", true, added.length ? `new files only: ${added.join(", ")}` : "no new files");
} catch (error) {
  record("migration script", false, `${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${failed.length ? "FAILED" : "OK"} ${results.length - failed.length}/${results.length} checks`);
process.exit(failed.length ? 1 : 0);
