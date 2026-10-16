import { describe, expect, it } from "vitest";

import { computerSteps, splitToolName, stepLabel, stepsSpan } from "./computer-steps";
import type { Message } from "@/state/store";

let clock = 0;
const user = (text: string): Message => ({ id: `u${++clock}`, role: "user", kind: "text", text, at: clock * 1000 });
const tool = (name: string, ok?: boolean, spoken?: string): Message => ({ id: `t${++clock}`, role: "bot", kind: "activity", tool: { name, ok, spoken }, at: clock * 1000 });
const screen = (png = "px"): Message => ({ id: `s${++clock}`, role: "bot", kind: "screen", png, mime: "image/png", at: clock * 1000 });

describe("computer step log", () => {
  it("splits tool chips into a name and what they acted on", () => {
    expect(splitToolName("Bash: pnpm test")).toEqual({ name: "Bash", detail: "pnpm test" });
    expect(splitToolName("mcp__computer__click")).toEqual({ name: "click" });
  });

  it("gives known tools a short name, then uses the server's narration, then the tool name", () => {
    expect(stepLabel({ name: "Edit", spoken: "editing a file" })).toBe("Edit a file");
    expect(stepLabel({ name: "mcp__computer__click" })).toBe("Click");
    expect(stepLabel({ name: "Bash: npm test" })).toBe("Run a command");
    expect(stepLabel({ name: "lookup_price", spoken: "checking the price list" })).toBe("Checking the price list");
    expect(stepLabel({ name: "custom_tool" })).toBe("custom tool");
  });

  it("builds the latest stretch of work with the frame that followed each step", () => {
    clock = 0;
    const messages = [
      user("old request"),
      tool("Read"),
      user("is the landing page API timing out again?"),
      tool("Bash: npm test", false),
      screen("term"),
      tool("Edit", true),
      tool("open_url", true),
      screen("browser"),
      tool("mcp__computer__click"),
    ];
    const steps = computerSteps(messages, { busy: true });
    expect(steps.map((step) => step.label)).toEqual(["Run a command", "Edit a file", "Open a page", "Click"]);
    expect(steps[0]).toMatchObject({ failed: 1, detail: "npm test", frame: { png: "term" } });
    expect(steps[2]?.frame?.png).toBe("browser");
    expect(steps.at(-1)?.live).toBe(true);
  });

  it("folds retries of the same action into one step and counts failures", () => {
    clock = 0;
    const steps = computerSteps([user("go"), tool("Bash: npm test", false), tool("Bash: npm test", false), tool("Bash: npm test", true)]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ failed: 2, live: false });
  });

  it("falls back to the previous stretch when nothing happened since the last message", () => {
    clock = 0;
    const steps = computerSteps([user("first"), tool("Read", true), screen(), user("thanks")]);
    expect(steps.map((step) => step.label)).toEqual(["Read a file"]);
    expect(steps[0]?.frame).toBeDefined();
  });

  it("shows only the newest steps and is never live while the bot is idle", () => {
    clock = 0;
    const many = [user("go"), ...Array.from({ length: 9 }, (_, index) => tool(`step_${index}`))];
    const steps = computerSteps(many, { max: 6 });
    expect(steps).toHaveLength(6);
    expect(steps.every((step) => !step.live)).toBe(true);
    expect(stepsSpan(steps)).toBe("0:05");
  });
});
