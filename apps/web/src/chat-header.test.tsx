// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRef, type ComponentProps } from "react";
import type { ChatMessage, Participant } from "@superhive/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatHeader } from "./chat-header";
import type { LocalAgentsState } from "./local-agents";
import type { ShareSelection } from "./share-bar";

afterEach(cleanup);

function props(overrides: Partial<ComponentProps<typeof ChatHeader>> = {}) {
  const noop = vi.fn();
  return {
    roomsCollapsed: false,
    setRoomsCollapsed: noop,
    mobilePanel: undefined,
    openMobilePanel: noop,
    currentRoomName: "build",
    online: [{ id: "u1" }] as unknown as Participant[],
    messages: [{ id: "m1", kind: "chat" }] as unknown as ChatMessage[],
    currentRoomWorkspace: "/Users/rd/Coding/ai-hive",
    currentRoom: { id: "build", name: "build", branch: "main" } as never,
    isOwner: false,
    local: { enabled: false, keepAwake: undefined } as unknown as LocalAgentsState,
    loadRoomWorktrees: noop,
    loadWorkspaceDetail: noop,
    openWorkspaceSource: noop,
    openWorktrees: noop,
    setSettingsTab: noop,
    setSettingsOpen: noop,
    startNewTopic: vi.fn(),
    artifactsButtonRef: createRef<HTMLButtonElement>(),
    artifactsOpen: false,
    setArtifactsOpen: noop,
    artifactCount: 3,
    canViewWorkspace: true,
    workspaceButtonRef: createRef<HTMLButtonElement>(),
    workspaceOpen: false,
    setWorkspaceOpen: noop,
    workspaceChangeCount: 0,
    share: {
      shareMode: false,
      setShareMode: vi.fn(),
      exitShareMode: vi.fn(),
    } as unknown as ShareSelection,
    previewDocked: false,
    membersCollapsed: false,
    setMembersCollapsed: noop,
    setDockedPreview: noop,
    ...overrides,
  } satisfies ComponentProps<typeof ChatHeader>;
}

describe("ChatHeader", () => {
  it("names every button with aria-label and uses no native title", () => {
    const { container } = render(<ChatHeader {...props()} />);
    const header = container.querySelector("header.chat-header")!;
    expect(header.querySelectorAll("[title]")).toHaveLength(0);
    for (const button of header.querySelectorAll("button")) {
      expect(button.getAttribute("aria-label"), button.outerHTML).toBeTruthy();
    }
    // 只剩图标时文字会被藏起来，名字不能靠它
    expect(screen.getByRole("button", { name: "新话题" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "分享对话" })).toBeTruthy();
  });

  it("marks what each width tier hides, so the CSS can collapse it", () => {
    const { container } = render(<ChatHeader {...props()} />);
    expect(container.querySelector(".chat-title-counts")?.textContent).toMatch(/1.*1/);
    expect(container.querySelectorAll(".header-button-label")).toHaveLength(4);
    expect(
      [...container.querySelectorAll("[data-overflow]")].map((el) => el.getAttribute("aria-label")),
    ).toEqual(["新话题", "工作区文件与改动", "分享对话"]);
  });

  it("shows the terminal button only inside the desktop app", () => {
    const { unmount } = render(<ChatHeader {...props()} />);
    expect(screen.queryByRole("button", { name: "终端" })).toBeNull();
    unmount();

    const toggle = vi.fn();
    const { container } = render(<ChatHeader {...props({ terminal: { open: true, toggle } })} />);
    const button = screen.getByRole("button", { name: "终端" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("data-overflow")).toBe("terminal");
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll(".header-button-label")).toHaveLength(5);
  });

  it("offers new topic and share from the More menu", () => {
    const base = props();
    render(<ChatHeader {...base} />);
    const more = screen.getByRole("button", { name: "更多操作" });
    expect(more.getAttribute("aria-haspopup")).toBe("menu");

    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "新话题" }));
    expect(base.startNewTopic).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "分享对话" }));
    expect(base.share.setShareMode).toHaveBeenCalledWith(true);
  });

  it("lists only the buttons the current width tier has hidden", () => {
    const style = document.createElement("style");
    style.textContent = '[data-overflow="new-topic"], [data-overflow="share"] { display: none; }';
    document.head.append(style);
    try {
      render(<ChatHeader {...props({ workspaceChangeCount: 4 })} />);
      fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
        "新话题",
        "分享对话",
      ]);
    } finally {
      style.remove();
    }
  });

  it("closes the More menu when its button is pressed again instead of reopening it", () => {
    render(<ChatHeader {...props()} />);
    const more = screen.getByRole("button", { name: "更多操作" });
    fireEvent.click(more);
    expect(screen.getByRole("menu")).toBeTruthy();
    // 菜单监听捕获阶段的 pointerdown 先关掉自己，紧接着的 click 不能再打开
    fireEvent.pointerDown(more);
    fireEvent.click(more);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("disables new topic in the menu right after a topic break", () => {
    render(
      <ChatHeader
        {...props({ messages: [{ id: "m1", kind: "topic" }] as unknown as ChatMessage[] })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "新话题" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("顶栏响应式样式", () => {
  const css = readFileSync(path.join(import.meta.dirname, "styles/shell.css"), "utf8");
  const block = (query: string) => {
    const start = css.indexOf(`@container chat-header (${query})`);
    expect(start, query).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("\n}\n", start));
  };

  it("collapses by the header's own width, not the window's", () => {
    expect(css).toMatch(/\.chat-header \{[^}]*container: chat-header \/ inline-size/);
    expect(block("max-width: 820px")).toContain(".chat-title-counts");
    expect(block("max-width: 660px")).toContain(".header-button-label");
    const narrow = block("max-width: 500px");
    // 新话题、分享（桌面端还有终端）一起收进「更多」
    for (const name of ["new-topic", "share", "terminal"]) {
      expect(narrow).toContain(`[data-overflow="${name}"]`);
    }
    expect(narrow).toContain(".header-button.header-more");
    expect(block("max-width: 360px")).toContain('[data-overflow="workspace"]');
    // 按钮文字不再跟着窗口宽度的媒体查询藏
    expect(css).not.toMatch(/@media[^{]*\{[^@]*\.(new-topic|share-fab|artifacts-toggle) span/);
  });
});
