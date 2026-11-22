// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCS_BASE_URL } from "@superhive/protocol";
import { setLocalePreference } from "./i18n";
import { RoomSidebar } from "./room-sidebar";

afterEach(cleanup);

type Props = ComponentProps<typeof RoomSidebar>;

function props(patch: Partial<Props> = {}): Props {
  return {
    activeRoomCount: 0,
    attention: { items: [], open: vi.fn() } as unknown as Props["attention"],
    attentionGroup: true,
    closeMobilePanel: vi.fn(),
    connectionState: "online",
    freezeRoomList: vi.fn(),
    incidentAttention: [],
    incidentEntry: undefined,
    isOwner: true,
    mobilePanel: undefined,
    modifierKeyLabel: "Cmd",
    openActivity: vi.fn(),
    openRoomDialog: vi.fn(),
    panelWidths: { rooms: 240, members: 240, preview: 480 },
    renderRoomItem: () => null,
    resizePanel: vi.fn(),
    roomNameOf: (id) => id,
    roomReorder: {
      dragging: false,
      scrollRef: createRef(),
      listRef: createRef(),
    } as unknown as Props["roomReorder"],
    roomsCloseRef: createRef(),
    setImDialogOpen: vi.fn(),
    setMobilePanel: vi.fn(),
    setSettingsOpen: vi.fn(),
    setShowArchivedRooms: vi.fn(),
    setThemePreference: vi.fn(),
    setUserMenuOpen: vi.fn(),
    setUsername: vi.fn(),
    settingsTriggerRef: createRef(),
    showArchivedRooms: false,
    sidebarRooms: { pinned: [], others: [] },
    taskCounts: { attention: 0, inFlight: 0 },
    thawRoomList: vi.fn(),
    themePreference: "system",
    unreadMentionCount: 0,
    userMenuHoverTimer: { current: undefined },
    userMenuOpen: false,
    userMenuRef: createRef(),
    username: "rd",
    ...patch,
  };
}

describe("sidebar incident entry", () => {
  it("isn't there unless the page is the owner's on this computer", () => {
    render(<RoomSidebar {...props()} />);
    expect(screen.getByRole("button", { name: "Agent 任务" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^故障/ })).toBeNull();
  });

  it("sits with the quick actions, with a count only when something needs handling", () => {
    const open = vi.fn();
    const { rerender } = render(<RoomSidebar {...props({ incidentEntry: { count: 0, open } })} />);
    const quick = screen.getByRole("navigation", { name: "快捷操作" });
    const entry = screen.getByRole("button", { name: "故障" });
    expect(quick.contains(entry)).toBe(true);
    expect(entry.querySelector(".sidebar-badge")).toBeNull();
    fireEvent.click(entry);
    expect(open).toHaveBeenCalledWith(entry);

    rerender(<RoomSidebar {...props({ incidentEntry: { count: 3, open } })} />);
    const counted = screen.getByRole("button", { name: "故障，3 条待处理" });
    expect(counted.querySelector(".sidebar-badge")?.textContent).toBe("3");
  });

  it("opens the escalated incident from 「需要你处理」", () => {
    const open = vi.fn();
    render(
      <RoomSidebar
        {...props({
          incidentEntry: { count: 1, open },
          incidentAttention: [{ id: "i1", kind: "incident", title: "TypeError: escalated" }],
        })}
      />,
    );
    fireEvent.click(screen.getByTitle("TypeError: escalated"));
    expect(open).toHaveBeenCalledWith(undefined, "i1");
  });
});

describe("sidebar user menu", () => {
  it("offers 「在其他设备登录」 only when the page can manage owner devices", () => {
    const openOwnerDevices = vi.fn();
    const setUserMenuOpen = vi.fn();
    const { rerender } = render(<RoomSidebar {...props({ userMenuOpen: true })} />);
    expect(screen.getByRole("menuitem", { name: "设置" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "在其他设备登录" })).toBeNull();

    rerender(<RoomSidebar {...props({ userMenuOpen: true, openOwnerDevices, setUserMenuOpen })} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "在其他设备登录" }));
    expect(openOwnerDevices).toHaveBeenCalled();
    expect(setUserMenuOpen).toHaveBeenCalledWith(false);
  });

  it("links 「帮助与文档」 to the docs site in a new tab, in the interface language", () => {
    const setUserMenuOpen = vi.fn();
    const { rerender } = render(
      <RoomSidebar {...props({ userMenuOpen: true, setUserMenuOpen })} />,
    );
    const docs = screen.getByRole("menuitem", { name: /帮助与文档/ });
    expect(docs.getAttribute("href")).toBe(DOCS_BASE_URL);
    expect(docs.getAttribute("target")).toBe("_blank");
    fireEvent.click(docs);
    expect(setUserMenuOpen).toHaveBeenCalledWith(false);

    setLocalePreference("en");
    try {
      rerender(<RoomSidebar {...props({ userMenuOpen: true })} />);
      expect(screen.getByRole("menuitem", { name: /Help & docs/ }).getAttribute("href")).toBe(
        `${DOCS_BASE_URL}en/`,
      );
    } finally {
      setLocalePreference("zh-CN");
    }
  });
});
