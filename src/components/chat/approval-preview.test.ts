import { describe, expect, it } from "vitest";

import { approvalPreview, isExternalPublish, parseArgs, previewTitle } from "./approval-preview";

describe("parseArgs", () => {
  it("reads real JSON, keeping strings, scalars and string lists", () => {
    expect(parseArgs('{"to":["a@x.com","b@x.com"],"subject":"Hi","count":2,"nested":{"a":1}}')).toEqual({
      to: "a@x.com, b@x.com",
      subject: "Hi",
      count: "2",
    });
  });

  it("recovers the fields of a summary cut off at 200 characters", () => {
    const cut = '{"recipient_email":"guests@x.com","subject":"Launch \\"invite\\"","body":"Dear guests,\\nPlease join us at 19:30 for the launch. Your talk is at 19';
    expect(parseArgs(cut)).toEqual({
      recipient_email: "guests@x.com",
      subject: 'Launch "invite"',
      body: "Dear guests,\nPlease join us at 19:30 for the launch. Your talk is at 19…",
    });
  });

  it("returns nothing for a plain command", () => {
    expect(parseArgs("rm -rf build")).toEqual({});
  });
});

describe("approvalPreview", () => {
  it("shows an email send as a draft: recipients, subject, body", () => {
    const preview = approvalPreview(
      "mcp__composio__GMAIL_SEND_EMAIL",
      '{"recipient_email":"wang@x.com","subject":"Friday launch","body":"<p>Dear guests,</p><p>See you at 19:30</p>"}',
    );
    expect(preview).toMatchObject({ kind: "email", platform: "Gmail", recipients: "wang@x.com", subject: "Friday launch" });
    expect(preview.body).toBe("Dear guests,\nSee you at 19:30");
    expect(previewTitle(preview)).toBe("Email draft · to wang@x.com");
    expect(isExternalPublish(preview.kind)).toBe(true);
  });

  it("does not treat reading a mailbox as a draft", () => {
    expect(approvalPreview("mcp__composio__GMAIL_FETCH_EMAILS", '{"query":"is:unread"}').kind).toBe("generic");
  });

  it("shows a social post with its account, schedule and hashtags", () => {
    const preview = approvalPreview(
      "XIAOHONGSHU_CREATE_NOTE",
      '{"account":"Launch official","content":"Friday 19:30 launch, 799! #launch #price","scheduled_at":"today 18:00"}',
    );
    expect(preview).toMatchObject({ kind: "social", platform: "Xiaohongshu", account: "Launch official", schedule: "today 18:00" });
    expect(preview.tags).toEqual(["#launch", "#price"]);
    expect(previewTitle(preview)).toBe("Post to Xiaohongshu");
  });

  it("reads a chat message's channel", () => {
    const preview = approvalPreview("SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL", '{"channel":"#launch","text":"We ship at 19:30"}');
    expect(preview).toMatchObject({ kind: "message", platform: "Slack", channel: "#launch", body: "We ship at 19:30" });
  });

  it("matches the service at the start of the name only", () => {
    expect(approvalPreview("GITHUB_LIST_TEAMS", "{}").kind).toBe("generic");
    expect(approvalPreview("send_email", '{"to":"a@x.com","body":"hi"}').kind).toBe("email");
  });

  it("keeps commands, files, pages and the local computer plain", () => {
    expect(approvalPreview("Bash", "git push --force")).toEqual({ kind: "command", target: "git push --force" });
    expect(approvalPreview("shell", "echo hi").kind).toBe("command");
    expect(approvalPreview("Write", '{"file_path":"/tmp/a.txt","content":"x"}')).toEqual({ kind: "file", target: "/tmp/a.txt" });
    expect(approvalPreview("WebFetch", "https://example.com")).toEqual({ kind: "web", target: "https://example.com" });
    expect(approvalPreview("mcp__computer__click", "{}", "local-computer").kind).toBe("computer");
    expect(approvalPreview("CLICKUP_CREATE_TASK", "{}").kind).toBe("generic");
    expect(isExternalPublish("command")).toBe(false);
  });
});
