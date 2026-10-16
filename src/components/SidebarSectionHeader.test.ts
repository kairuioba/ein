import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarSectionHeader } from "./SidebarSectionHeader";

describe("SidebarSectionHeader", () => {
  it("exposes collapse and keyboard reorder semantics without a fake grip button", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarSectionHeader, {
        name: "Work",
        collapsed: false,
        onToggle: () => {},
        reorderable: true,
        dragging: false,
      }),
    );

    expect(html).toContain("<button");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="button"');
  });

  it("shows the department colour, its note and the count next to the name", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarSectionHeader, {
        name: "Design",
        color: "#EC4899",
        note: createElement("span", null, "Delivered"),
        count: 3,
        collapsed: false,
        onToggle: () => {},
        reorderable: true,
        dragging: false,
      }),
    );

    expect(html).toContain("background:#EC4899");
    expect(html).toContain("Delivered");
    expect(html).toContain(">3</span>");
    expect(html).toContain('aria-label="Design"');
    // the grip sits over the count instead of taking width of its own
    expect(html).toContain("group-hover/section:opacity-0");
  });

  it("renders collapsed attention signals in the heading", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarSectionHeader, {
        name: "Bot Chats",
        collapsed: true,
        attention: { waiting: 1, unread: 2, working: 1 },
        onToggle: () => {},
        reorderable: false,
        dragging: false,
      }),
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("1 waiting for you");
    expect(html).toContain("2 unread");
    expect(html).toContain("1 working");
  });
});
