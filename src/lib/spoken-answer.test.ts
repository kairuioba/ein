import { describe, expect, it } from "vitest";

import { spokenNo, spokenYes } from "./spoken-answer";

describe("spoken approval answers", () => {
  it("keeps the English answers", () => {
    expect(spokenYes("Yes, go ahead")).toBe(true);
    expect(spokenYes("okay")).toBe(true);
    expect(spokenNo("No thanks")).toBe(true);
    expect(spokenNo("don't")).toBe(true);
    expect(spokenYes("nothing")).toBe(false);
  });

  it("understands Chinese answers, which come without spaces", () => {
    for (const said of ["可以", "可以，去做吧", "好的。", "同意", "没问题", "确认执行", "好", "是。", "行"]) {
      expect(spokenYes(said), said).toBe(true);
    }
    for (const said of ["不要", "不行", "不用了", "别做", "拒绝", "取消", "算了吧", "停"]) {
      expect(spokenNo(said), said).toBe(true);
    }
  });

  it("does not approve on a question, a hesitation or a look-alike", () => {
    for (const said of ["可以吗", "好不好", "是不是该等等", "嗯……让我想想", "行不行", "好像有问题"]) {
      expect(spokenYes(said), said).toBe(false);
    }
    expect(spokenNo("不错")).toBe(false);
    expect(spokenNo("不好意思再说一遍")).toBe(false);
  });
});
