// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocalAgent,
  ChatMessage,
  Invocation,
  Participant,
  ServerEvent,
  WhiteboardEntry,
} from "@superhive/protocol";
import { App } from "./App";
import { setLocalePreference } from "./i18n";

type RoomSnapshotEvent = Extract<ServerEvent, { type: "room.snapshot" }>;
// 与 zod 输入类型一致：快照里的 invocations / whiteboard / schedules 有默认值，可以省略
type ServerEventInput =
  | Exclude<ServerEvent, RoomSnapshotEvent>
  | (Omit<
      RoomSnapshotEvent,
      "invocations" | "whiteboard" | "schedules" | "approvals" | "features"
    > &
      Partial<
        Pick<
          RoomSnapshotEvent,
          "invocations" | "whiteboard" | "schedules" | "approvals" | "features"
        >
      >);

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", new Event("open"));
  }

  serverEvent(event: ServerEventInput): void {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(event) }));
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeNotification {
  static permission: NotificationPermission = "default";
  static nextPermission: NotificationPermission = "granted";
  static readonly instances: FakeNotification[] = [];

  static async requestPermission(): Promise<NotificationPermission> {
    FakeNotification.permission = FakeNotification.nextPermission;
    return FakeNotification.permission;
  }

  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
}

function participant(id: string, username: string, type: Participant["type"]): Participant {
  return {
    id,
    roomId: "general",
    username,
    type,
    status: "online",
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const roomSummary = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  createdAt: `2026-07-18T00:00:0${id === "general" ? 0 : 1}.000Z`,
  onlineCount: 0,
  latestSeq: 0,
  ...extra,
});

const crossRoom: {
  mentions: ChatMessage[];
  invocations: Invocation[];
  invocationMessages: ChatMessage[];
  searchable: ChatMessage[];
} = { mentions: [], invocations: [], invocationMessages: [], searchable: [] };

const whiteboardApi: {
  entries: WhiteboardEntry[];
  requests: Array<{ action: string; entries: Array<{ id: string; updatedAt: string }> }>;
} = { entries: [], requests: [] };

/** 房主的置顶房间（服务端存的那份）和收到的 PUT /api/room-pins */
const roomPins: { ids: string[]; requests: string[][] } = { ids: [], requests: [] };
const pinnedSummary = (id: string) => {
  const index = roomPins.ids.indexOf(id);
  return roomSummary(id, index < 0 ? {} : { pinned: index });
};

/** 本机 Agent 接口的假实现；enabled 为 false 时 /api/local/session 返回 404（非本机） */
const localApi: {
  enabled: boolean;
  agents: LocalAgent[];
  requests: Array<{ url: string; method: string; owner: string | null; body?: unknown }>;
  cleanupBatch: { id: string; count: number } | null;
  clearFailure?: string;
} = { enabled: false, agents: [], requests: [], cleanupBatch: null };

function localAgent(overrides: Partial<LocalAgent> = {}): LocalAgent {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    provider: "opencode",
    name: "Alice-opencode",
    access: "read-only",
    cwd: null,
    model: null,
    status: "starting",
    pid: 4242,
    startedAt: new Date().toISOString(),
    lastExitCode: null,
    lastError: null,
    restarts: 0,
    createdAt: new Date().toISOString(),
    mcpDisabled: [],
    ...overrides,
  } as LocalAgent;
}

// 这组是长流程的整页交互测试，较慢的机器（如 Windows 办公机）上单个用例可能超过默认 5 秒
vi.setConfig({ testTimeout: 60_000 });

describe("App mention autocomplete", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    FakeNotification.instances.length = 0;
    crossRoom.mentions = [];
    crossRoom.invocations = [];
    crossRoom.invocationMessages = [];
    crossRoom.searchable = [];
    whiteboardApi.entries = [];
    whiteboardApi.requests = [];
    localApi.enabled = false;
    localApi.agents = [];
    localApi.requests = [];
    localApi.clearFailure = undefined;
    localApi.cleanupBatch = null;
    roomPins.ids = [];
    roomPins.requests = [];
    FakeNotification.permission = "default";
    FakeNotification.nextPermission = "granted";
    localStorage.clear();
    window.history.replaceState(null, "", window.location.pathname);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/meta")) {
          return jsonResponse({
            name: "SuperHive",
            roomId: "general",
            httpUrl: "http://10.0.0.8:8787",
            wsUrl: "ws://10.0.0.8:8787/ws",
            mcpUrl: "http://10.0.0.8:8787/mcp",
            joinToken: "test-token",
            agentCommand:
              "npx --yes superhive@latest join --server http://10.0.0.8:8787 --name my-agent --token test-token",
          });
        }
        if (url.includes("/invites")) {
          if (init?.method === "POST") {
            return jsonResponse({
              token: "hvi_test",
              invite: {
                id: "00000000-0000-4000-8000-000000000999",
                roomId: "general",
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
                allowAgents: false,
                uses: 0,
              },
            });
          }
          return jsonResponse({ invites: [] });
        }
        if (url.includes("/api/local/")) {
          if (!localApi.enabled) return jsonResponse({ error: "not found" }, 404);
          const method = init?.method ?? "GET";
          const owner = new Headers(init?.headers).get("X-Hive-Owner");
          localApi.requests.push({
            url,
            method,
            owner,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          });
          if (url.endsWith("/api/local/session")) {
            return jsonResponse({
              enabled: true,
              mode: "local",
              ownerToken: "owner-secret",
              hostLabel: "alice-mac",
            });
          }
          if (owner !== "owner-secret") return jsonResponse({ error: "unauthorized" }, 401);
          if (/\/api\/local\/rooms\/[^/]+\/clear$/.test(url))
            return localApi.clearFailure
              ? jsonResponse({ code: "WHITEBOARD_PROTECTED", error: localApi.clearFailure }, 409)
              : jsonResponse({ removed: { messages: 0, invocations: 0, whiteboard: 0 } });
          if (url.includes("/api/local/directories")) {
            const target = new URL(url).searchParams.get("path");
            const launch = "/Users/alice/hive";
            const current = target ?? launch;
            return jsonResponse({
              path: current,
              parent: current === "/" ? null : current.replace(/\/[^/]+$/, "") || "/",
              entries: [
                { name: "apps", path: `${current}/apps` },
                { name: "packages", path: `${current}/packages` },
              ],
              truncated: false,
              defaults: { launch, home: "/Users/alice" },
            });
          }
          if (url.endsWith("/api/local/providers")) {
            return jsonResponse({
              providers: [
                { provider: "codex", command: "codex", installed: false, version: null },
                { provider: "opencode", command: "opencode", installed: true, version: "1.19.4" },
              ],
            });
          }
          if (url.endsWith("/api/local/agents") && method === "POST") {
            const body = JSON.parse(String(init!.body)) as { name: string };
            const agent = localAgent({ name: body.name });
            localApi.agents.push(agent);
            return jsonResponse({ agent }, 201);
          }
          if (url.endsWith("/api/local/agents")) return jsonResponse({ agents: localApi.agents });
          if (url.includes("/api/local/worktrees/"))
            return jsonResponse({
              worktrees: [],
              autoCleanup: false,
              cleanupBatch: localApi.cleanupBatch,
            });
        }
        if (url.includes("/api/mentions")) {
          return jsonResponse({ messages: crossRoom.mentions });
        }
        if (url.includes("/api/invocations")) {
          return jsonResponse({
            invocations: crossRoom.invocations,
            messages: crossRoom.invocationMessages,
          });
        }
        if (url.includes("/api/search")) {
          const query = new URL(url).searchParams.get("q") ?? "";
          return jsonResponse({
            messages: crossRoom.searchable.filter((message) => message.content.includes(query)),
          });
        }
        if (/\/api\/rooms\/[^/]+\/messages/.test(url)) {
          return jsonResponse({ messages: [], latestSeq: 0 });
        }
        if (url.includes("/whiteboard")) {
          if (init?.method === "POST") {
            const action = url.endsWith("/archive") ? "archive" : "restore";
            const body = JSON.parse(String(init.body)) as {
              entries: Array<{ id: string; updatedAt: string }>;
            };
            whiteboardApi.requests.push({ action, entries: body.entries });
            const changed = body.entries.map(({ id }) => {
              const previous = whiteboardApi.entries.find((entry) => entry.id === id)!;
              const updatedAt = new Date(Date.parse(previous.updatedAt) + 1).toISOString();
              const entry = { ...previous };
              delete entry.archivedAt;
              return {
                ...entry,
                updatedAt,
                ...(action === "archive" ? { archivedAt: updatedAt } : {}),
              };
            });
            whiteboardApi.entries = whiteboardApi.entries.map(
              (entry) => changed.find((updated) => updated.id === entry.id) ?? entry,
            );
            return jsonResponse({ entries: changed });
          }
          const view = new URL(url).searchParams.get("view") ?? "current";
          return jsonResponse({
            entries: whiteboardApi.entries.filter((entry) =>
              view === "all" ? true : view === "archived" ? entry.archivedAt : !entry.archivedAt,
            ),
          });
        }
        if (url.includes("/api/rooms") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { id: string; name?: string };
          return jsonResponse({ room: roomSummary(body.id, { name: body.name ?? body.id }) }, 201);
        }
        if (url.includes("/api/room-pins")) {
          const body = JSON.parse(String(init!.body)) as { roomIds: string[] };
          roomPins.ids = body.roomIds;
          roomPins.requests.push(body.roomIds);
          return jsonResponse({ roomIds: body.roomIds });
        }
        if (url.includes("/api/rooms")) {
          return jsonResponse({ rooms: [pinnedSummary("general"), pinnedSummary("frontend")] });
        }
        return jsonResponse({ error: "not found" }, 404);
      }),
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("connects through the reachable dev server instead of an advertised stale LAN address", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    // /api/meta advertises 10.0.0.8, but the page reaches the server through localhost.
    expect(socket.url).toBe("ws://localhost:8787/ws");
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
      }),
    );
    expect(document.querySelector(".connection")?.classList.contains("online")).toBe(true);
  });

  it("focuses the composer once when the page opens", async () => {
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(document.activeElement?.tagName).toBe("TEXTAREA"));
  });

  it("removes expired worktree notices without dismissing a newer batch", async () => {
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    localApi.enabled = true;
    const firstId = "00000000-0000-4000-8000-000000000091";
    const secondId = "00000000-0000-4000-8000-000000000092";
    localApi.cleanupBatch = { id: firstId, count: 1 };
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
      }),
    );
    await screen.findByText("1 个 worktree 已合入，可清理。");
    localApi.cleanupBatch = null;
    act(() =>
      socket.serverEvent({
        type: "worktree.cleanup",
        roomId: "general",
        batchId: firstId,
        count: 0,
        state: "expired",
        automatic: false,
      }),
    );
    await waitFor(() => expect(screen.queryByText("清理这批目录")).toBeNull());
    localApi.cleanupBatch = { id: secondId, count: 2 };
    act(() =>
      socket.serverEvent({
        type: "worktree.cleanup",
        roomId: "general",
        batchId: secondId,
        count: 2,
        state: "available",
        automatic: false,
      }),
    );
    await screen.findByText("2 个 worktree 已合入，可清理。");
    act(() =>
      socket.serverEvent({
        type: "worktree.cleanup",
        roomId: "general",
        batchId: firstId,
        count: 1,
        state: "completed",
        automatic: false,
      }),
    );
    expect(screen.getByText("2 个 worktree 已合入，可清理。")).toBeTruthy();
    localApi.cleanupBatch = null;
    act(() =>
      socket.serverEvent({
        type: "worktree.cleanup",
        roomId: "general",
        batchId: secondId,
        count: 0,
        state: "expired",
        automatic: false,
      }),
    );
    await waitFor(() => expect(screen.queryByText("清理这批目录")).toBeNull());
  });

  it("previews the draft as Markdown, colors its syntax while editing, and expands the composer", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const { container } = render(<App />);
    const composer = screen.getByLabelText<HTMLTextAreaElement>("消息");
    fireEvent.change(composer, { target: { value: "# 计划\n- **先**跑测试" } });
    // 编辑时：高亮层给标题、加粗上色
    const highlight = container.querySelector(".composer-highlight")!;
    expect(highlight.querySelector(".md-heading")?.textContent).toBe("计划");
    expect(highlight.querySelector(".md-strong")?.textContent).toBe("先");
    // 预览：按消息里同样的 Markdown 渲染，点一下回到编辑
    await user.click(screen.getByRole("button", { name: "预览" }));
    const preview = await screen.findByRole("region", { name: "Markdown 预览" });
    await waitFor(() => expect(preview.querySelector("h1")?.textContent).toBe("计划"));
    expect(preview.querySelector("strong")?.textContent).toBe("先");
    await user.click(preview);
    expect(screen.queryByRole("region", { name: "Markdown 预览" })).toBeNull();
    // 展开：内容不多也立刻变高（约半屏），上限也变大
    const before = Number.parseInt(composer.style.maxHeight, 10);
    const heightBefore = Number.parseInt(composer.style.height, 10);
    await user.click(screen.getByRole("button", { name: "展开输入框" }));
    await waitFor(() =>
      expect(Number.parseInt(composer.style.maxHeight, 10)).toBeGreaterThan(before),
    );
    expect(Number.parseInt(composer.style.height, 10)).toBeGreaterThan(heightBefore);
    expect(Number.parseInt(composer.style.height, 10)).toBeGreaterThanOrEqual(176);
    expect(screen.getByRole("button", { name: "收起输入框" }).textContent).toContain("收起");
  });

  it("keeps the mention option chosen with the keyboard in view", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const others = ["Bob", "Carol", "Dave"].map((name, index) =>
      participant(`00000000-0000-4000-8000-00000000001${index}`, name, "human"),
    );
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, ...others],
        messages: [],
        latestSeq: 0,
      }),
    );
    const composer = screen.getByLabelText<HTMLTextAreaElement>("消息");
    fireEvent.change(composer, { target: { value: "@", selectionStart: 1 } });
    // 输入框已自动聚焦：先让 React 记下当前光标位置，否则按方向键时它会以为光标变了、把选中项重置
    fireEvent.keyUp(composer, { key: "@" });
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();

    fireEvent.keyDown(composer, { key: "ArrowUp" });
    const last = screen.getAllByRole("option").at(-1)!;
    expect(last.getAttribute("aria-selected")).toBe("true");
    expect(scrolled.mock.contexts.at(-1)).toBe(last);
    expect(scrolled.mock.calls.at(-1)).toEqual([{ block: "nearest" }]);

    // 列表滚动后浏览器补发的鼠标事件（鼠标没动）不改变选中项
    const first = screen.getAllByRole("option")[0]!;
    fireEvent.mouseEnter(first);
    fireEvent.mouseMove(first);
    expect(last.getAttribute("aria-selected")).toBe("true");
  });

  it("recalls own sent messages with the arrow keys without touching a draft in progress", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const sent = (seq: number, senderName: string, content: string): ChatMessage => ({
      id: `00000000-0000-4000-8000-0000000001${String(seq).padStart(2, "0")}`,
      roomId: "general",
      seq,
      senderId: self.id,
      senderName,
      senderType: "human",
      content,
      mentions: [],
      traceId: "00000000-0000-4000-8000-000000000200",
      hopCount: 0,
      createdAt: "2026-10-31T00:00:00.000Z",
    });
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [
          sent(1, "Alice", "第一条"),
          sent(2, "Bob", "别人的"),
          sent(3, "Alice", "第二条 @Bob"),
        ],
        latestSeq: 3,
      }),
    );
    const composer = screen.getByLabelText<HTMLTextAreaElement>("消息");

    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(composer.value).toBe("第二条 @Bob");
    fireEvent.select(composer);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(localStorage.getItem("superhive.draft.alice.general")).toBeNull();
    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(composer.value).toBe("第一条");
    fireEvent.keyDown(composer, { key: "ArrowDown" });
    fireEvent.keyDown(composer, { key: "ArrowDown" });
    expect(composer.value).toBe("");

    fireEvent.change(composer, { target: { value: "写到一半" } });
    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(composer.value).toBe("写到一半");
  });

  it("opens on @, excludes self, filters members, and supports arrows, Enter, and Tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText("你的用户名"), "Alice");
    await user.click(screen.getByRole("button", { name: /进入聊天室/ }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    // 默认开启 @ 通知，进入聊天室的点击手势里顺带请求浏览器授权
    await waitFor(() => expect(FakeNotification.permission).toBe("granted"));
    expect(screen.queryByRole("status", { name: "开启浏览器通知" })).toBeNull();
    // 第一次用的房主会看到上手引导，这里先跳过
    await user.click(await screen.findByRole("button", { name: "跳过，以后再说" }));
    expect(localStorage.getItem("superhive.onboarding")).toBe("done");

    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "participant.join",
      username: "Alice",
    });

    // 快照到达前还在加载：不能先闪出"空房间"欢迎页
    const messageShadow = () =>
      document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement;
    expect(within(messageShadow()).queryByText(/协作什么？/)).toBeNull();

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [
          self,
          participant("00000000-0000-4000-8000-000000000002", "backend-agent", "agent"),
          participant("00000000-0000-4000-8000-000000000003", "frontend-agent", "agent"),
        ],
        messages: [],
        latestSeq: 0,
      }),
    );
    // 快照确认房间是空的，才显示欢迎页
    expect(within(messageShadow()).getByText(/协作什么？/)).toBeTruthy();

    // 主题切换收在头像菜单里
    expect(screen.queryByRole("radiogroup", { name: "颜色主题" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "用户菜单" }));
    const themeSwitcher = within(screen.getByRole("menu", { name: "用户菜单" })).getByRole(
      "radiogroup",
      { name: "颜色主题" },
    );
    await user.click(within(themeSwitcher).getByRole("radio", { name: "浅色" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("superhive.theme")).toBe("light");
    await user.keyboard("{Escape}");

    const membersPanel = screen.getByLabelText("成员列表");
    // 添加成员的入口（邀请人类、接入 Agent）位于成员列表下方
    expect(within(membersPanel).getByRole("button", { name: "接入 Agent" })).toBeTruthy();
    // 邀请成员：选有效期后生成限时链接并复制
    await user.click(within(membersPanel).getByRole("button", { name: /邀请成员/ }));
    const inviteDialog = await screen.findByRole("dialog", { name: /邀请成员/ });
    expect(within(inviteDialog).getByRole("radio", { name: "24 小时" })).toHaveProperty(
      "ariaChecked",
      "true",
    );
    await user.click(within(inviteDialog).getByRole("button", { name: "生成并复制链接" }));
    expect(await within(inviteDialog).findByText("已复制邀请链接")).toBeTruthy();
    // 页面开在 localhost 上时，邀请链接换成 Server 公布的局域网地址，别人才打得开
    expect(await navigator.clipboard.readText()).toBe(
      `http://10.0.0.8:${window.location.port}/#general?invite=hvi_test`,
    );
    await user.click(within(inviteDialog).getByRole("button", { name: "关闭" }));
    const membersTrigger = screen.getByRole("button", { name: "打开成员列表" });
    await user.click(membersTrigger);
    expect(membersPanel.classList.contains("mobile-open")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭成员列表" }));
    await user.keyboard("{Escape}");
    expect(membersPanel.classList.contains("mobile-open")).toBe(false);
    expect(document.activeElement).toBe(membersTrigger);

    const composer = screen.getByPlaceholderText("发送消息，输入 @ 选择成员…");
    expect((composer as HTMLTextAreaElement).style.height).toBe("54px");

    const sentBeforeComposition = socket.sent.length;
    fireEvent.compositionStart(composer);
    fireEvent.change(composer, { target: { value: "nihao" } });
    fireEvent.keyDown(composer, {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      isComposing: true,
    });
    expect(socket.sent).toHaveLength(sentBeforeComposition);
    expect((composer as HTMLTextAreaElement).value).toBe("nihao");
    fireEvent.compositionEnd(composer);
    await user.clear(composer);

    const sentBeforePlainEnter = socket.sent.length;
    fireEvent.change(composer, { target: { value: "默认快捷键" } });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
    expect(socket.sent).toHaveLength(sentBeforePlainEnter);
    expect((composer as HTMLTextAreaElement).value).toBe("默认快捷键");
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "message.send",
      content: "默认快捷键",
    });

    const settingsTrigger = screen.getByRole("button", { name: "用户菜单" });
    await user.click(settingsTrigger);
    const userMenu = screen.getByRole("menu", { name: "用户菜单" });
    await user.click(within(userMenu).getByRole("menuitem", { name: /设置/ }));
    const settingsDialog = screen.getByRole("dialog", { name: "偏好设置" });
    expect(
      within(settingsDialog)
        .getByRole("radio", { name: /^组合键发送/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(settingsDialog)
        .getByRole("switch", { name: /^自动保存草稿/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.change(composer, { target: { value: "保留这份草稿" } });
    await waitFor(() =>
      expect(localStorage.getItem("superhive.draft.alice.general")).toBe("保留这份草稿"),
    );
    await user.click(within(settingsDialog).getByRole("radio", { name: /^Enter 发送/ }));
    expect(localStorage.getItem("superhive.send-shortcut")).toBe("enter");
    await user.click(within(settingsDialog).getByRole("radio", { name: "24 小时" }));
    expect(localStorage.getItem("superhive.time-format")).toBe("24h");

    await user.click(within(settingsDialog).getByRole("tab", { name: /^通知/ }));
    expect(
      within(settingsDialog)
        .getByRole("radio", { name: /^@ 我时通知/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(settingsDialog).queryByRole("button", { name: "立即授权" })).toBeNull();
    await user.click(within(settingsDialog).getByRole("radio", { name: /^关闭通知/ }));
    expect(localStorage.getItem("superhive.notify-messages")).toBe("off");
    await user.click(within(settingsDialog).getByRole("radio", { name: /^@ 我时通知/ }));
    await waitFor(() => expect(localStorage.getItem("superhive.notify-messages")).toBe("mentions"));
    await user.click(within(settingsDialog).getByRole("switch", { name: /^新消息提示音/ }));
    expect(localStorage.getItem("superhive.notification-sound")).toBe("true");
    await user.click(within(settingsDialog).getByRole("switch", { name: /^Agent 上下线/ }));
    expect(localStorage.getItem("superhive.notify-agent-presence")).toBe("true");

    await user.click(within(settingsDialog).getByRole("tab", { name: /^外观/ }));
    await user.click(within(settingsDialog).getByRole("radio", { name: "深色" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(within(settingsDialog).getByRole("radio", { name: "紧凑" }));
    expect(document.documentElement.dataset.density).toBe("compact");
    // 消息区宽度：默认「加宽」，切换后存在本机
    expect(document.documentElement.dataset.threadWidth).toBe("wide");
    await user.click(within(settingsDialog).getByRole("radio", { name: "铺满" }));
    expect(document.documentElement.dataset.threadWidth).toBe("full");
    expect(localStorage.getItem("superhive.thread-width")).toBe("full");
    await user.click(within(settingsDialog).getByRole("radio", { name: "大" }));
    expect(document.documentElement.dataset.messageSize).toBe("large");
    await user.click(within(settingsDialog).getByRole("switch", { name: /^减少动态效果/ }));
    expect(document.documentElement.dataset.reduceMotion).toBe("true");

    await user.click(within(settingsDialog).getByRole("button", { name: "关闭设置" }));
    expect(screen.queryByRole("dialog", { name: "偏好设置" })).toBeNull();
    expect(document.activeElement).toBe(settingsTrigger);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const roomMessage = (seq: number, content: string, mentions: string[]) => ({
      id: `00000000-0000-4000-8000-0000000000${String(seq).padStart(2, "0")}`,
      roomId: "general",
      seq,
      senderId: "00000000-0000-4000-8000-000000000002",
      senderName: "backend-agent",
      senderType: "agent" as const,
      content,
      mentions,
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 1,
      createdAt: new Date().toISOString(),
    });
    act(() =>
      socket.serverEvent({
        type: "message.created",
        message: roomMessage(1, "@Alice 请查看这个结果", ["Alice"]),
      }),
    );
    expect(FakeNotification.instances.at(-1)?.title).toContain("提到了你");

    const notificationsBeforePlainMessage = FakeNotification.instances.length;
    act(() =>
      socket.serverEvent({
        type: "message.created",
        message: roomMessage(2, "没有提到任何人的普通消息", []),
      }),
    );
    expect(FakeNotification.instances).toHaveLength(notificationsBeforePlainMessage);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await user.click(settingsTrigger);
    await user.click(
      within(screen.getByRole("menu", { name: "用户菜单" })).getByRole("menuitem", {
        name: /设置/,
      }),
    );
    const reopenedSettings = screen.getByRole("dialog", { name: "偏好设置" });
    await user.click(within(reopenedSettings).getByRole("tab", { name: /^通知/ }));
    await user.click(within(reopenedSettings).getByRole("radio", { name: /^当前房间任意消息/ }));
    await waitFor(() => expect(localStorage.getItem("superhive.notify-messages")).toBe("all"));
    await user.keyboard("{Escape}");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() =>
      socket.serverEvent({
        type: "message.created",
        message: roomMessage(3, "任意消息也会通知", []),
      }),
    );
    expect(FakeNotification.instances.at(-1)?.title).toBe("backend-agent · # general");
    expect(FakeNotification.instances.at(-1)?.options?.body).toBe("任意消息也会通知");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });

    fireEvent.change(composer, { target: { value: "Enter 发送" } });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "message.send",
      content: "Enter 发送",
    });

    const agentDialogTrigger = screen.getByRole("button", { name: "接入 Agent" });
    await user.click(agentDialogTrigger);
    const agentDialog = screen.getByRole("dialog", { name: "把 Agent 接入 Hive" });
    expect(agentDialog).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));
    // 不替人默认选一个：选之前「下一步」不能点
    expect(screen.getByRole("radio", { name: /Codex/ }).getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("button", { name: "下一步" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("radio", { name: /^只读/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制命令" })).toBeNull();

    const commandText = () =>
      screen.getByText((_, element) => Boolean(element?.matches(".command code"))).textContent;
    const nextStep = () => user.click(screen.getByRole("button", { name: "下一步" }));
    const previousStep = () => user.click(screen.getByRole("button", { name: "上一步" }));

    // 点一下 Agent 就到第 2 步，默认工作区档
    await user.click(screen.getByRole("radio", { name: /Claude Code/ }));
    expect(screen.getByRole("heading", { name: /允许 Claude Code 在本机做什么/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^工作区/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await nextStep();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "复制命令，到终端运行" }),
    );
    expect(commandText()).toContain("--provider claude");
    // 还没启动、也没复制命令：不出现「完成」，免得点了什么也没发生
    expect(screen.queryByRole("button", { name: "完成" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(screen.getByRole("button", { name: "完成" })).toBeTruthy();
    expect(await navigator.clipboard.readText()).toContain("npx --yes superhive@latest join");
    expect(await navigator.clipboard.readText()).toContain("--name Alice-claude");
    expect(await navigator.clipboard.readText()).toContain("--access workspace --cwd .");
    expect(screen.getByRole("button", { name: "已复制到剪贴板" })).toBeTruthy();

    // 点一下权限也直接到第 3 步
    await previousStep();
    await user.click(screen.getByRole("radio", { name: /^只读/ }));
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("--access read-only");

    await previousStep();
    await user.click(screen.getByRole("radio", { name: /^完全访问/ }));
    // 和 worktree 自动清理同款就地确认气泡：选项旁边弹出，确认前权限不变
    const fullAccessPopover = screen.getByRole("dialog", { name: "确认开启完全访问" });
    expect(fullAccessPopover.textContent).toContain("确认移除本机安全边界");
    expect(screen.getByRole("radio", { name: /^只读/ }).getAttribute("aria-checked")).toBe("true");
    // Esc 收起气泡并把焦点还给「完全访问」选项，没有勾上
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "确认开启完全访问" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /^完全访问/ }));
    expect(screen.getByRole("radio", { name: /^只读/ }).getAttribute("aria-checked")).toBe("true");
    // 重新点开，这次确认，才切到完全访问
    await user.click(screen.getByRole("radio", { name: /^完全访问/ }));
    await user.click(screen.getByRole("button", { name: "我了解风险，开启完全访问" }));
    expect(commandText()).toContain("--access full --cwd .");

    await user.click(screen.getByRole("button", { name: "返回第 1 步：选择 Agent" }));
    await user.click(screen.getByRole("radio", { name: /GitHub Copilot/ }));
    await nextStep();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain(
      "--provider copilot --server http://10.0.0.8:8787",
    );
    expect(await navigator.clipboard.readText()).toContain("--name Alice-copilot");

    await user.click(screen.getByRole("button", { name: "返回第 1 步：选择 Agent" }));
    const copilotRadio = screen.getByRole("radio", { name: /GitHub Copilot/ });
    copilotRadio.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /OpenCode/ }));
    expect(screen.getByRole("radio", { name: /OpenCode/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    // 方向键只是选中，不跳步
    expect(screen.getByRole("heading", { name: "选择要接入的 Agent" })).toBeTruthy();
    await nextStep();
    await nextStep();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("--provider opencode ");
    expect(await navigator.clipboard.readText()).toContain("--name Alice-opencode");

    // omp 的工作区档无法把写入限制在当前目录，需要明确提示
    await user.click(screen.getByRole("button", { name: "返回第 1 步：选择 Agent" }));
    await user.click(screen.getByRole("radio", { name: /omp/ }));
    await user.click(screen.getByRole("radio", { name: /^工作区/ }));
    await previousStep();
    expect(screen.getByText(/omp 不会把文件写入限制在当前目录内/)).toBeTruthy();
    await nextStep();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("--provider omp ");
    expect(await navigator.clipboard.readText()).toContain("--access workspace --cwd .");

    await user.click(screen.getByRole("button", { name: "返回第 1 步：选择 Agent" }));
    await user.click(screen.getByRole("radio", { name: /OpenClaw/ }));
    await nextStep();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toContain("--name Alice-openclaw");
    expect(await navigator.clipboard.readText()).toContain("--openclaw-configure-mcp");

    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(agentDialogTrigger);

    // 再打开时重新选 Agent
    await user.click(agentDialogTrigger);
    expect(screen.getByRole("radio", { name: /OpenClaw/ }).getAttribute("aria-checked")).toBe(
      "false",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(agentDialogTrigger);

    await user.type(composer, "@");
    const mentionListbox = await screen.findByRole("listbox");
    expect(within(mentionListbox).getByText("@backend-agent")).toBeTruthy();
    expect(within(mentionListbox).getByText("@frontend-agent")).toBeTruthy();
    expect(within(mentionListbox).queryByText("@Alice")).toBeNull();

    await user.keyboard("{ArrowDown}{Enter}");
    expect((composer as HTMLTextAreaElement).value).toBe("@frontend-agent ");
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.clear(composer);
    await user.type(composer, "ask @back");
    expect(screen.getByText("@backend-agent")).toBeTruthy();
    expect(screen.queryByText("@frontend-agent")).toBeNull();
    await user.keyboard("{Tab}");
    expect((composer as HTMLTextAreaElement).value).toBe("ask @backend-agent ");

    await user.clear(composer);
    await user.type(composer, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "message.send",
      content: "你好",
      clientMessageId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
  });

  it("restores the saved username after refresh and only clears it on explicit logout", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "SavedUser");
    render(<App />);

    expect(screen.queryByText("进入 SuperHive")).toBeNull();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "participant.join",
      username: "SavedUser",
    });

    act(() =>
      socket.serverEvent({
        type: "error",
        code: "USERNAME_TAKEN",
        message: "This username is already online in the room.",
      }),
    );
    expect(localStorage.getItem("superhive.username")).toBe("SavedUser");
    expect(screen.getByText(/已被同名 Agent 或其他身份占用/)).toBeTruthy();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "用户菜单" }));
    await user.click(screen.getByRole("menuitem", { name: /退出/ }));
    expect(localStorage.getItem("superhive.username")).toBeNull();
    expect(screen.getByText("进入 SuperHive")).toBeTruthy();
  });

  it("shows the workspace's git branch under the room name and keeps it updated", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
      }),
    );
    const roomsPanel = screen.getByLabelText("房间列表");
    await waitFor(() => expect(within(roomsPanel).getByText("# frontend")).toBeTruthy());
    act(() =>
      socket.serverEvent({
        type: "rooms.changed",
        room: { ...roomSummary("frontend"), workspace: "/repo/web", branch: "feat/sidebar" },
      }),
    );
    expect(within(roomsPanel).getByText("feat/sidebar")).toBeTruthy();
    act(() =>
      socket.serverEvent({
        type: "rooms.changed",
        room: { ...roomSummary("frontend"), workspace: "/repo/web", branch: "main" },
      }),
    );
    expect(within(roomsPanel).queryByText("feat/sidebar")).toBeNull();
    expect(within(roomsPanel).getByText("main")).toBeTruthy();
  });

  it("marks the room's lead agent and says plain messages go to it", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const helper = participant("00000000-0000-4000-8000-000000000002", "helper", "agent");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, helper],
        messages: [],
        latestSeq: 0,
      }),
    );
    const roomsPanel = screen.getByLabelText("房间列表");
    await waitFor(() => expect(within(roomsPanel).getByText("# frontend")).toBeTruthy());
    expect(screen.queryByText("主")).toBeNull();
    expect(screen.getByPlaceholderText("发送消息，输入 @ 选择成员…")).toBeTruthy();
    act(() =>
      socket.serverEvent({
        type: "rooms.changed",
        room: { ...roomSummary("general"), leadAgent: "helper" },
      }),
    );
    await waitFor(() => expect(screen.getByText("主")).toBeTruthy());
    expect(screen.getByPlaceholderText("发送消息，不 @ 时交给主 Agent helper…")).toBeTruthy();
  });

  it("opens right-click menus on rooms and members with common actions", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const helper = participant("00000000-0000-4000-8000-000000000002", "helper", "agent");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, helper],
        messages: [],
        latestSeq: 0,
      }),
    );
    const roomsPanel = screen.getByLabelText("房间列表");
    const general = await within(roomsPanel).findByText("# general");
    const names = () =>
      [...roomsPanel.querySelectorAll(".room-item-name")].map((item) => item.textContent);
    // 都没有消息：按创建时间，后建的 frontend 在上
    await waitFor(() => expect(names()).toEqual(["# frontend", "# general"]));

    fireEvent.contextMenu(general, { clientX: 40, clientY: 80 });
    let roomMenu = screen.getByRole("menu", { name: "# general" });
    expect(within(roomMenu).getByRole("menuitem", { name: "复制房间链接" })).toBeTruthy();
    // 没置顶的不能手动排
    expect(within(roomMenu).queryByRole("menuitem", { name: /上移/ })).toBeNull();
    fireEvent.click(within(roomMenu).getByRole("menuitem", { name: "置顶" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(names()).toEqual(["# general", "# frontend"]);
    const pinnedGroup = within(roomsPanel).getByRole("group", { name: "已置顶" });
    expect(within(pinnedGroup).getByText("# general")).toBeTruthy();
    expect(pinnedGroup.querySelector(".room-item-pin")).toBeTruthy();
    await waitFor(() => expect(roomPins.requests).toEqual([["general"]]));

    fireEvent.contextMenu(within(roomsPanel).getByText("# general"), { clientX: 40, clientY: 80 });
    roomMenu = screen.getByRole("menu", { name: "# general" });
    expect(within(roomMenu).getByRole("menuitem", { name: /上移/ })).toBeTruthy();
    fireEvent.click(within(roomMenu).getByRole("menuitem", { name: "取消置顶" }));
    expect(names()).toEqual(["# frontend", "# general"]);
    expect(within(roomsPanel).queryByRole("group", { name: "已置顶" })).toBeNull();
    await waitFor(() => expect(roomPins.requests).toEqual([["general"], []]));

    const memberRow = screen
      .getAllByText("helper")
      .map((node) => node.closest(".member-row"))
      .find(Boolean)!;
    fireEvent.contextMenu(memberRow, { clientX: 300, clientY: 200 });
    const memberMenu = screen.getByRole("menu", { name: "helper" });
    expect(within(memberMenu).getByRole("menuitem", { name: "查看 Agent 任务" })).toBeTruthy();
    fireEvent.keyDown(memberMenu, { key: "Enter" });
    expect((screen.getByLabelText("消息") as HTMLTextAreaElement).value).toContain("@helper");
  });

  it("opens the same member menu from a sender's avatar or name in the conversation", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const helper = participant("00000000-0000-4000-8000-000000000002", "helper", "agent");
    const message = (id: string, seq: number, sender: Participant, content: string) =>
      ({
        id,
        roomId: "general",
        seq,
        senderId: sender.id,
        senderName: sender.username,
        senderType: sender.type,
        content,
        mentions: [],
        traceId: "00000000-0000-4000-8000-0000000000f0",
        hopCount: 0,
        createdAt: new Date().toISOString(),
      }) as ChatMessage;
    const gone = participant("00000000-0000-4000-8000-000000000003", "old-bot", "agent");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, helper],
        messages: [
          message("00000000-0000-4000-8000-0000000000f1", 1, helper, "你好"),
          message("00000000-0000-4000-8000-0000000000f2", 2, gone, "我已经离开了"),
        ],
        latestSeq: 2,
      }),
    );
    const list = () =>
      within(document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement);
    const labels = (menu: HTMLElement) =>
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent);

    // 成员列表里的菜单作为基准
    const memberRow = screen
      .getAllByText("helper")
      .map((node) => node.closest(".member-row"))
      .find(Boolean)!;
    fireEvent.contextMenu(memberRow, { clientX: 300, clientY: 200 });
    const fromList = labels(screen.getByRole("menu", { name: "helper" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(fromList).toContain("查看 Agent 任务");

    // 对话流里右击头像、右击名字，菜单和成员列表一致
    const sender = await waitFor(() => list().getByText("helper", { selector: ".message-sender" }));
    const avatar = sender.closest(".message")!.querySelector(".avatar") as HTMLElement;
    fireEvent.contextMenu(avatar, { clientX: 100, clientY: 100 });
    expect(labels(screen.getByRole("menu", { name: "helper" }))).toEqual(fromList);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    // 键盘：聚焦名字后按菜单键（坐标为 0）也能打开
    sender.focus();
    fireEvent.contextMenu(sender, { clientX: 0, clientY: 0 });
    expect(labels(screen.getByRole("menu", { name: "helper" }))).toEqual(fromList);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    // 已经不在房间的成员：只剩 @ 它和复制名字
    fireEvent.contextMenu(list().getByText("old-bot", { selector: ".message-sender" }), {
      clientX: 100,
      clientY: 100,
    });
    expect(labels(screen.getByRole("menu", { name: "old-bot" }))).toEqual([
      "@ old-bot",
      "复制名字",
    ]);
  });

  it("switches rooms, shows unread dots, and creates rooms from the sidebar", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "general",
    });

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
      }),
    );

    const roomsPanel = screen.getByLabelText("房间列表");
    await waitFor(() => expect(within(roomsPanel).getByText("# frontend")).toBeTruthy());

    act(() =>
      socket.serverEvent({
        type: "room.activity",
        roomId: "frontend",
        latestSeq: 5,
        onlineCount: 1,
      }),
    );
    expect(screen.getByLabelText("# frontend 有未读消息")).toBeTruthy();

    await user.click(within(roomsPanel).getByRole("button", { name: /# frontend/ }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const frontendSocket = FakeWebSocket.instances[1]!;
    act(() => frontendSocket.open());
    expect(JSON.parse(frontendSocket.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "frontend",
    });
    expect(localStorage.getItem("superhive.room")).toBe("frontend");
    expect(window.location.hash).toBe("#frontend");

    const frontendSelf = { ...self, roomId: "frontend" };
    act(() =>
      frontendSocket.serverEvent({
        type: "room.snapshot",
        self: frontendSelf,
        participants: [frontendSelf],
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000020",
            roomId: "frontend",
            seq: 5,
            senderId: "00000000-0000-4000-8000-000000000001",
            senderName: "Alice",
            senderType: "human",
            content: "frontend 房间的第一条消息",
            mentions: [],
            traceId: "00000000-0000-4000-8000-000000000021",
            hopCount: 0,
            createdAt: new Date().toISOString(),
          },
        ],
        latestSeq: 5,
      }),
    );
    await waitFor(() => expect(localStorage.getItem("superhive.read-seq.frontend")).toBe("5"));
    expect(screen.queryByLabelText("# frontend 有未读消息")).toBeNull();

    await user.click(screen.getByRole("button", { name: "接入 Agent" }));
    await user.click(screen.getByRole("radio", { name: /Codex/ }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(
      screen.getByText((_, element) =>
        Boolean(
          element?.matches(".command code") &&
          element.textContent?.includes("--name Alice-codex") &&
          !element.textContent.includes("--room"),
        ),
      ),
    ).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "新建房间" }));
    const roomDialog = screen.getByRole("dialog", { name: "新建房间" });
    await user.type(within(roomDialog).getByLabelText(/房间 ID/), "design");
    await user.click(within(roomDialog).getByRole("button", { name: "创建房间" }));

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      expect(JSON.parse(String((postCall![1] as RequestInit).body))).toMatchObject({
        id: "design",
        name: "design",
        createdBy: "Alice",
      });
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));
    const designSocket = FakeWebSocket.instances[2]!;
    act(() => designSocket.open());
    expect(JSON.parse(designSocket.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "design",
    });
    expect(localStorage.getItem("superhive.room")).toBe("design");
    expect(window.location.hash).toBe("#design");
  });

  it("lets a user recall their own message and renders tombstones for everyone", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const agent = participant("00000000-0000-4000-8000-000000000002", "backend-agent", "agent");
    const base = {
      roomId: "general",
      mentions: [] as string[],
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: new Date().toISOString(),
    };
    const mine = {
      ...base,
      id: "00000000-0000-4000-8000-000000000010",
      seq: 1,
      senderId: self.id,
      senderName: "Alice",
      senderType: "human" as const,
      content: "发错群了，密钥是 sk-secret",
    };
    const theirs = {
      ...base,
      id: "00000000-0000-4000-8000-000000000020",
      seq: 2,
      senderId: agent.id,
      senderName: "backend-agent",
      senderType: "agent" as const,
      content: "收到",
    };
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent],
        messages: [mine, theirs],
        latestSeq: 2,
      }),
    );
    // 消息列表渲染在 shadow root 内，screen 查询不到
    const list = () =>
      within(document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement);
    await waitFor(() => expect(list().getByText("发错群了，密钥是 sk-secret")).toBeTruthy());

    // 只有自己的消息有撤回入口
    const recallButtons = list().getAllByRole("button", { name: "撤回这条消息" });
    expect(recallButtons).toHaveLength(1);
    const mentionButton = list().getByRole("button", { name: "在输入框中提及 backend-agent" });
    // 重复点击同一个人只 @ 一次
    await user.click(mentionButton);
    await user.click(mentionButton);
    expect((screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement).value).toBe(
      "@backend-agent ",
    );

    // 还有 Agent 在做这条消息派的活：确认里默认「撤回并停止」，也可以只撤回
    const now = new Date().toISOString();
    // 只是在排队：撤回后本来就不会执行，没有「只撤回」可选；说明直接显示出来（触屏看不到悬停提示）
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          id: "00000000-0000-4000-8000-0000000000b1",
          roomId: "general",
          messageId: mine.id,
          agentId: agent.id,
          agentName: "backend-agent",
          requesterName: "Alice",
          requesterType: "human",
          status: "queued",
          attempts: 1,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    await user.click(recallButtons[0]!);
    const queuedConfirm = list().getByRole("group", { name: "确认撤回" });
    expect(within(queuedConfirm).queryByRole("button", { name: "只撤回" })).toBeNull();
    expect(queuedConfirm.textContent).toContain("已经改的文件、跑过的命令不会撤销");
    await user.click(within(queuedConfirm).getByRole("button", { name: "取消" }));
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          id: "00000000-0000-4000-8000-0000000000b1",
          roomId: "general",
          messageId: mine.id,
          agentId: agent.id,
          agentName: "backend-agent",
          requesterName: "Alice",
          requesterType: "human",
          status: "running",
          attempts: 1,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
        },
      }),
    );
    await user.click(list().getByRole("button", { name: "撤回这条消息" }));
    const stopConfirm = list().getByRole("group", { name: "确认撤回" });
    expect(stopConfirm.textContent).toContain("撤回并停止 @backend-agent 的任务？");
    expect(within(stopConfirm).getByRole("button", { name: "只撤回" })).toBeTruthy();
    const sentBeforeStop = socket.sent.length;
    await user.click(within(stopConfirm).getByRole("button", { name: "撤回并停止" }));
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "message.delete",
      messageId: mine.id,
      stop: true,
    });
    expect(socket.sent).toHaveLength(sentBeforeStop + 1);
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          id: "00000000-0000-4000-8000-0000000000b1",
          roomId: "general",
          messageId: mine.id,
          agentId: agent.id,
          agentName: "backend-agent",
          requesterName: "Alice",
          requesterType: "human",
          status: "completed",
          attempts: 1,
          createdAt: now,
          updatedAt: now,
          finishedAt: now,
        },
      }),
    );

    // 二次确认：先取消，再确认
    await user.click(list().getByRole("button", { name: "撤回这条消息" }));
    const confirm = list().getByRole("group", { name: "确认撤回" });
    await user.click(within(confirm).getByRole("button", { name: "取消" }));
    expect(list().queryByRole("group", { name: "确认撤回" })).toBeNull();
    const sentBefore = socket.sent.length;
    await user.click(list().getByRole("button", { name: "撤回这条消息" }));
    await user.click(
      within(list().getByRole("group", { name: "确认撤回" })).getByRole("button", { name: "撤回" }),
    );
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "message.delete", messageId: mine.id });
    expect(socket.sent).toHaveLength(sentBefore + 1);

    // 服务端广播墓碑：正文消失、操作按钮消失、显示占位
    act(() =>
      socket.serverEvent({
        type: "message.deleted",
        message: { ...mine, content: "", mentions: [], deletedAt: new Date().toISOString() },
      }),
    );
    expect(list().queryByText("发错群了，密钥是 sk-secret")).toBeNull();
    expect(list().getByText("你撤回了一条消息")).toBeTruthy();
    expect(list().queryByRole("button", { name: "撤回这条消息" })).toBeNull();

    act(() =>
      socket.serverEvent({
        type: "message.deleted",
        message: { ...theirs, content: "", mentions: [], deletedAt: new Date().toISOString() },
      }),
    );
    expect(list().getByText("backend-agent 撤回了一条消息")).toBeTruthy();
    expect(list().queryByRole("button", { name: "在输入框中提及 backend-agent" })).toBeNull();

    act(() =>
      socket.serverEvent({
        type: "error",
        code: "FORBIDDEN",
        message: "Only the sender can recall a message.",
      }),
    );
    expect(screen.getByRole("alert").textContent).toContain("只能撤回自己发送的消息");
  });

  it("collapses earlier topics, starts a new topic, and follows a cleared room", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const base = {
      roomId: "general",
      mentions: [] as string[],
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: new Date().toISOString(),
      senderId: self.id,
      senderName: "Alice",
      senderType: "human" as const,
    };
    const message = (seq: number, content: string, kind?: "topic") => ({
      ...base,
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      seq,
      content,
      ...(kind ? { kind } : {}),
    });
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [
          message(1, "旧话题的讨论"),
          message(2, "Alice 开启了新话题", "topic"),
          message(3, "新话题的讨论"),
        ],
        latestSeq: 3,
      }),
    );
    const list = () =>
      within(document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement);
    await waitFor(() => expect(list().getByText("新话题的讨论")).toBeTruthy());
    // 更早的话题默认折叠，分隔线说明之前的消息不再是 Agent 上下文
    expect(list().queryByText("旧话题的讨论")).toBeNull();
    const shadow = document.querySelector(".message-list")!.shadowRoot!;
    expect(shadow.querySelector(".topic-divider")?.textContent).toContain("Alice 开启了新话题");
    await user.click(list().getByRole("button", { name: "显示更早的话题（1 条消息）" }));
    expect(list().getByText("旧话题的讨论")).toBeTruthy();

    // 开启新话题：发出 topic.start；收到分隔后按钮置灰，之前的话题重新折叠
    const newTopic = screen.getByRole("button", { name: "新话题" }) as HTMLButtonElement;
    expect(newTopic.disabled).toBe(false);
    await user.click(newTopic);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "topic.start" });
    act(() =>
      socket.serverEvent({
        type: "message.created",
        message: message(4, "Alice 开启了新话题", "topic"),
      }),
    );
    await waitFor(() => expect(newTopic.disabled).toBe(true));
    expect(list().queryByText("新话题的讨论")).toBeNull();
    expect(list().getByRole("button", { name: "显示更早的话题（3 条消息）" })).toBeTruthy();

    // 房主清空了房间：本地只剩清空后的分隔
    act(() =>
      socket.serverEvent({
        type: "room.cleared",
        message: message(9, "Alice 清空了房间", "topic"),
      }),
    );
    await waitFor(() => expect(list().getByText(/Alice 清空了房间/)).toBeTruthy());
    expect(list().queryByRole("button", { name: /显示更早的话题/ })).toBeNull();
    expect(list().queryByText("Alice 开启了新话题", { exact: false })).toBeNull();
  });

  it("loads earlier messages above without moving the viewport to the very top", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const base = {
      roomId: "general",
      mentions: [] as string[],
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: new Date().toISOString(),
      senderId: self.id,
      senderName: "Alice",
      senderType: "human" as const,
    };
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: Array.from({ length: 120 }, (_, index) => ({
          ...base,
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          seq: index + 1,
          content: `第 ${index + 1} 条`,
        })),
        latestSeq: 120,
      }),
    );
    const container = document.querySelector(".message-list")! as HTMLElement;
    const list = () => within(container.shadowRoot as unknown as HTMLElement);
    await waitFor(() => expect(list().getByText("第 120 条")).toBeTruthy());
    expect(list().queryByText("第 1 条")).toBeNull();
    expect(
      list().getByRole("button", { name: "显示更早的 95 条消息（共隐藏 95 条）" }),
    ).toBeTruthy();

    // jsdom 没有布局：让 scrollHeight 随已挂载消息数增长、scrollTop 可存取，验证锚定算式
    const height = () => container.shadowRoot!.querySelectorAll("[data-message-id]").length * 40;
    let scrollTop = 200;
    Object.defineProperty(container, "scrollHeight", { configurable: true, get: height });
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    // 恢复走 scrollTo({ behavior: "instant" })（容器 CSS 是 scroll-behavior: smooth）；
    // jsdom 的 scrollTo 不实现，替换成与 scrollTop 同一存储的桩
    container.scrollTo = ((options: ScrollToOptions) => {
      scrollTop = options.top ?? 0;
    }) as typeof container.scrollTo;

    await user.click(list().getByRole("button", { name: /显示更早的/ }));
    expect(list().getByText("第 1 条")).toBeTruthy();
    // 点击时 25 条已挂载（高 1000，视口在 200）；展开后 120 条（高 4800），
    // 保持「视口到内容底部的距离」800 不变 → scrollTop 应为 4000，而不是停在顶部 0
    expect(height()).toBe(4800);
    expect(scrollTop).toBe(4000);
  });

  it("asks returning users to grant notification permission from an in-app prompt", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    // 已登录用户没有登录手势可用，不能在加载时直接弹授权，而是给一条可关闭的提示
    expect(FakeNotification.permission).toBe("default");
    const prompt = screen.getByRole("status", { name: "开启浏览器通知" });
    await user.click(within(prompt).getByRole("button", { name: "暂不" }));
    expect(screen.queryByRole("status", { name: "开启浏览器通知" })).toBeNull();
    expect(localStorage.getItem("superhive.notify-prompt-dismissed")).toBe("true");
    expect(localStorage.getItem("superhive.notify-messages")).toBeNull();

    // 设置面板仍能补授权
    await user.click(screen.getByRole("button", { name: "用户菜单" }));
    await user.click(screen.getByRole("menuitem", { name: /设置/ }));
    const settingsDialog = screen.getByRole("dialog", { name: "偏好设置" });
    await user.click(within(settingsDialog).getByRole("tab", { name: /^通知/ }));
    expect(
      within(settingsDialog)
        .getByRole("radio", { name: /^@ 我时通知/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(within(settingsDialog).getByRole("button", { name: "立即授权" }));
    await waitFor(() => expect(FakeNotification.permission).toBe("granted"));
    expect(within(settingsDialog).queryByRole("button", { name: "立即授权" })).toBeNull();
  });

  it("falls back to no notifications when the browser denies permission", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    FakeNotification.nextPermission = "denied";
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const prompt = screen.getByRole("status", { name: "开启浏览器通知" });
    await user.click(within(prompt).getByRole("button", { name: "开启" }));
    await waitFor(() => expect(localStorage.getItem("superhive.notify-messages")).toBe("off"));
    expect(screen.queryByRole("status", { name: "开启浏览器通知" })).toBeNull();
  });

  it("opens the room from a shared #roomId link and follows later hash changes", async () => {
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.room", "general");
    window.history.replaceState(null, "", "#frontend");
    render(<App />);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const frontendSocket = FakeWebSocket.instances[0]!;
    act(() => frontendSocket.open());
    expect(JSON.parse(frontendSocket.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "frontend",
    });
    expect(localStorage.getItem("superhive.room")).toBe("frontend");

    act(() => {
      window.location.hash = "#design";
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const designSocket = FakeWebSocket.instances[1]!;
    act(() => designSocket.open());
    expect(JSON.parse(designSocket.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "design",
    });
    expect(localStorage.getItem("superhive.room")).toBe("design");

    act(() => {
      window.location.hash = "#not a valid room!";
    });
    await waitFor(() => expect(window.location.hash).toBe("#design"));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("shows server-written texts in the selected language", async () => {
    setLocalePreference("en");
    try {
      localStorage.setItem("superhive.username", "Alice");
      localStorage.setItem("superhive.notify-prompt-dismissed", "true");
      render(<App />);
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      act(() => socket.open());
      const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
      const agent = participant("00000000-0000-4000-8000-000000000002", "backend-agent", "agent");
      const now = new Date().toISOString();
      const trigger = {
        id: "00000000-0000-4000-8000-000000000010",
        roomId: "general",
        seq: 1,
        senderId: self.id,
        senderName: "Alice",
        senderType: "human" as const,
        mentions: ["backend-agent"],
        content: "@backend-agent 看看",
        traceId: "00000000-0000-4000-8000-000000000011",
        hopCount: 0,
        createdAt: now,
      };
      const cleared = {
        ...trigger,
        id: "00000000-0000-4000-8000-000000000012",
        seq: 2,
        mentions: [],
        kind: "topic" as const,
        content: "Alice 开启了新话题",
        text: { key: "topic.started", params: { name: "Alice" } },
      };
      act(() =>
        socket.serverEvent({
          type: "room.snapshot",
          self,
          participants: [self, agent],
          messages: [trigger, cleared],
          latestSeq: 2,
          invocations: [
            {
              id: "00000000-0000-4000-8000-0000000000a1",
              roomId: "general",
              messageId: trigger.id,
              agentId: agent.id,
              agentName: "backend-agent",
              requesterName: "Alice",
              requesterType: "human",
              status: "queued",
              detail: "已送达，排队中",
              detailText: { key: "invocation.delivered" },
              attempts: 1,
              createdAt: now,
              updatedAt: now,
              receivedAt: now,
            },
          ],
          whiteboard: [],
        }),
      );
      const shadow = () =>
        document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement;
      await waitFor(() => expect(shadow().textContent).toContain("Alice started a new topic"));
      expect(shadow().textContent).not.toContain("开启了新话题");

      act(() =>
        socket.serverEvent({
          type: "error",
          code: "OWNER_ONLY",
          message: "访客只能忽略自己发起的调用。",
          text: { key: "error.guest.dismissOwn" },
        }),
      );
      expect(screen.getByRole("alert").textContent).toContain(
        "Guests can only dismiss tasks they started.",
      );
    } finally {
      setLocalePreference("zh-CN");
    }
  });

  it("shows per-message invocation chips and sends retry, cancel, and budget actions", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const backend = participant("00000000-0000-4000-8000-000000000002", "backend-agent", "agent");
    const frontend = participant("00000000-0000-4000-8000-000000000003", "frontend-agent", "agent");
    const reviewer = participant("00000000-0000-4000-8000-000000000004", "reviewer-agent", "agent");
    const now = new Date().toISOString();
    const messageBase = {
      roomId: "general",
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: now,
    };
    const trigger = {
      ...messageBase,
      id: "00000000-0000-4000-8000-000000000010",
      seq: 2,
      senderId: self.id,
      senderName: "Alice",
      senderType: "human" as const,
      mentions: ["backend-agent", "frontend-agent", "reviewer-agent"],
      content: "@backend-agent @frontend-agent @reviewer-agent 一起看看构建",
    };
    const plain = {
      ...messageBase,
      id: "00000000-0000-4000-8000-000000000030",
      seq: 1,
      senderId: self.id,
      senderName: "Alice",
      senderType: "human" as const,
      mentions: [] as string[],
      content: "没有 @ 的普通消息",
    };
    const reply = {
      ...messageBase,
      id: "00000000-0000-4000-8000-000000000020",
      seq: 3,
      senderId: backend.id,
      senderName: "backend-agent",
      senderType: "agent" as const,
      mentions: [] as string[],
      content: "构建已修好",
    };
    const invocationBase = {
      roomId: "general",
      messageId: trigger.id,
      requesterName: "Alice",
      requesterType: "human" as const,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    };
    const running = {
      ...invocationBase,
      id: "00000000-0000-4000-8000-0000000000a1",
      agentId: backend.id,
      agentName: "backend-agent",
      status: "running" as const,
      progress: "执行命令：pnpm test",
      receivedAt: now,
      startedAt: new Date(Date.now() - 125_000).toISOString(),
    };
    const failed = {
      ...invocationBase,
      id: "00000000-0000-4000-8000-0000000000a2",
      agentId: frontend.id,
      agentName: "frontend-agent",
      status: "failed" as const,
      detail: "进程退出码 1",
      attempts: 2,
    };
    const blocked = {
      ...invocationBase,
      id: "00000000-0000-4000-8000-0000000000a3",
      agentId: reviewer.id,
      agentName: "reviewer-agent",
      status: "blocked" as const,
      blockReason: "consecutive_limit" as const,
      detail: "Agent 之间已连续对话 8 轮",
    };
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, backend, frontend, reviewer],
        messages: [plain, trigger, reply],
        latestSeq: 3,
        invocations: [running, failed, blocked],
        whiteboard: [],
      }),
    );
    const shadow = () =>
      document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement;
    const list = () => within(shadow());
    await waitFor(() => expect(list().getByRole("list", { name: "Agent 调用状态" })).toBeTruthy());

    const chips = list().getByRole("list", { name: "Agent 调用状态" });
    expect(within(chips).getAllByRole("listitem")).toHaveLength(3);
    expect(within(chips).getByText("执行命令：pnpm test")).toBeTruthy();
    expect(within(chips).getByText("2分钟")).toBeTruthy();
    expect(within(chips).getByText("第2次")).toBeTruthy();
    expect(within(chips).getByText("Agent 之间已连续对话 8 轮")).toBeTruthy();
    // 只有触发了调用的消息才有状态行
    expect(list().getAllByRole("list", { name: "Agent 调用状态" })).toHaveLength(1);

    await user.click(within(chips).getByRole("button", { name: /^@backend-agent.*查看调用详情$/ }));
    const runtimeDialog = screen.getByRole("dialog", { name: "调用详情" });
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          ...running,
          runtime: {
            observability: "partial",
            lastHeartbeatAt: running.updatedAt,
            lastRuntimeEventAt: running.updatedAt,
            lastProgressAt: running.updatedAt,
            lastError: { at: running.updatedAt, code: 503 },
            history: [{ at: running.updatedAt, kind: "provider_error", code: 503 }],
          },
        },
      }),
    );
    expect(within(runtimeDialog).getByText(/尚未确认恢复.*HTTP 503/)).toBeTruthy();
    expect(within(runtimeDialog).getByText("部分事件可见")).toBeTruthy();
    await user.click(within(runtimeDialog).getByRole("button", { name: "关闭调用详情" }));

    await user.click(within(chips).getByRole("button", { name: "停止 @backend-agent" }));
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "invocation.cancel",
      invocationId: running.id,
    });
    await user.click(within(chips).getByRole("button", { name: "重试 @frontend-agent" }));
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "invocation.retry",
      invocationId: failed.id,
    });
    await user.click(
      within(chips).getByRole("button", { name: "为 Agent 对话追加 10 轮，恢复 @reviewer-agent" }),
    );
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "budget.extend", turns: 10 });

    // 房间级提示同样可以续命
    const notice = screen.getByRole("status", { name: "Agent 连续对话已暂停" });
    await user.click(within(notice).getByRole("button", { name: "继续 10 轮" }));
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "budget.extend", turns: 10 });

    // 被拦下的调用恢复后提示消失；运行中的调用完成后可以跳到回复
    act(() => {
      socket.serverEvent({
        type: "invocation.updated",
        invocation: { ...blocked, status: "queued", blockReason: undefined, attempts: 2 },
      });
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          ...running,
          status: "completed",
          progress: undefined,
          replyMessageId: reply.id,
          finishedAt: new Date().toISOString(),
          updatedAt: new Date(Date.now() + 1000).toISOString(),
        },
      });
    });
    expect(screen.queryByRole("status", { name: "Agent 连续对话已暂停" })).toBeNull();
    expect(list().queryByText("执行命令：pnpm test")).toBeNull();
    expect(list().queryByRole("button", { name: "停止 @backend-agent" })).toBeNull();
    const jump = list().getByRole("button", { name: /^@backend-agent，已完成.*跳到回复$/ });
    await user.click(jump);
    const replyArticle = shadow().querySelector(`[data-message-id="${reply.id}"]`)!;
    expect(replyArticle.classList.contains("highlighted")).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    act(() =>
      socket.serverEvent({
        type: "error",
        code: "INVOCATION_NOT_RETRYABLE",
        message: "This invocation cannot be retried now.",
      }),
    );
    expect(screen.getByRole("alert").textContent).toContain("这次调用当前无法重试");

    // Agent 判断无需回复：已完成但没有回复消息，状态上要写明，免得像是漏处理
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          ...failed,
          status: "completed",
          detail: "无需回复",
          finishedAt: new Date().toISOString(),
          updatedAt: new Date(Date.now() + 2000).toISOString(),
        },
      }),
    );
    expect(within(chips).getByText("无需回复")).toBeTruthy();
  });

  it("launches an agent on this machine with one click when the page is local", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localApi.enabled = true;
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
      }),
    );

    await user.click(screen.getByRole("button", { name: "接入 Agent" }));
    // 第 1 步标出本机装了哪些 CLI
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Codex.*本机未安装/ })).toBeTruthy(),
    );
    expect(screen.getByRole("radio", { name: /OpenCode.*1\.19\.4/ })).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: /OpenCode/ }));
    await user.click(screen.getByRole("radio", { name: /^只读/ }));
    expect(screen.getByRole("heading", { name: "在本机启动" })).toBeTruthy();
    expect(screen.getByText("或复制命令，到其他终端运行")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Agent 名称" }) as HTMLInputElement).value).toBe(
      "Alice-opencode",
    );

    await user.click(screen.getByRole("button", { name: "在本机启动" }));
    const created = localApi.requests.find((request) => request.method === "POST");
    expect(created).toMatchObject({
      owner: "owner-secret",
      body: { provider: "opencode", name: "Alice-opencode", access: "read-only" },
    });
    expect(await screen.findByText(/正在启动/)).toBeTruthy();

    // 服务端报告已上线后提示可以 @ 了，成员列表也标出它由本机启动
    localApi.agents = [localAgent({ status: "running" })];
    const agent = participant("00000000-0000-4000-8000-0000000000a9", "Alice-opencode", "agent");
    act(() => socket.serverEvent({ type: "presence.changed", participant: agent }));
    await waitFor(() => expect(screen.getByText(/已上线/)).toBeTruthy(), { timeout: 4_000 });
    expect(screen.getByTitle("由本机 Hive Server 启动")).toBeTruthy();

    // 本机房主也可以一键启动完全访问：需要工作目录，并给出无沙箱警告
    await user.click(screen.getByRole("button", { name: "返回第 2 步：设置权限" }));
    await user.click(screen.getByRole("radio", { name: /^完全访问/ }));
    await user.click(screen.getByRole("button", { name: "我了解风险，开启完全访问" }));
    expect(screen.getByRole("heading", { name: "在本机启动" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("完全访问没有任何沙箱");
    // 工作目录预填启动 Hive 的目录，不用手输
    const cwdInput = () => screen.getByRole("textbox", { name: "工作目录" }) as HTMLInputElement;
    await waitFor(() => expect(cwdInput().value).toBe("/Users/alice/hive"));

    // 点"选择…"用服务端列目录，进子目录后确认
    await user.click(screen.getByRole("button", { name: "选择…" }));
    const picker = screen.getByRole("group", { name: "选择工作目录" });
    // 家目录开头的路径显示成 ~/…，完整路径在 title 里
    await waitFor(() => expect(within(picker).getByText("~/hive")).toBeTruthy());
    expect(within(picker).getByText("~/hive").getAttribute("title")).toBe("/Users/alice/hive");
    await user.click(within(picker).getByRole("button", { name: "apps" }));
    await waitFor(() => expect(within(picker).getByText("~/hive/apps")).toBeTruthy());
    await user.click(within(picker).getByRole("button", { name: "选择当前目录" }));
    expect(cwdInput().value).toBe("/Users/alice/hive/apps");
    expect(screen.queryByRole("group", { name: "选择工作目录" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "在本机启动" }));
    expect(localApi.requests.filter((request) => request.method === "POST").at(-1)).toMatchObject({
      body: { access: "full", cwd: "/Users/alice/hive/apps" },
    });

    // 完全访问不跨次保留：关掉再打开回到工作区档
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "接入 Agent" }));
    await user.click(screen.getByRole("radio", { name: /OpenCode/ }));
    expect(screen.getByRole("radio", { name: /^工作区/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("defaults clear-room confirmation to archiving and offers an explicit chat-only choice", async () => {
    const user = userEvent.setup();
    localApi.enabled = true;
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
      }),
    );
    await waitFor(() =>
      expect(localApi.requests.some((request) => request.url.endsWith("/api/local/session"))).toBe(
        true,
      ),
    );
    await user.click(screen.getByRole("button", { name: "管理房间 general" }));
    const dialog = screen.getByRole("dialog", { name: "房间设置 · # general" });
    await waitFor(() =>
      expect(
        within(dialog).getByRole<HTMLButtonElement>("button", { name: "清空房间" }).disabled,
      ).toBe(false),
    );
    await user.click(within(dialog).getByRole("button", { name: "清空房间" }));
    expect(
      within(dialog).getByRole<HTMLInputElement>("checkbox", {
        name: "同时归档当前白板（历史可恢复）",
      }).checked,
    ).toBe(true);
    expect(
      within(dialog).getByText("进行中、阻塞及工作区占用事项会阻止清空，请先处理。"),
    ).toBeTruthy();
    localApi.clearFailure = "受保护事项未处理，本次未删除任何记录。";
    await user.click(within(dialog).getByRole("button", { name: "确认清空" }));
    await waitFor(() => expect(within(dialog).getByText(localApi.clearFailure!)).toBeTruthy());
    expect(screen.getByRole("dialog", { name: "房间设置 · # general" })).toBe(dialog);
    localApi.clearFailure = undefined;
    await user.click(within(dialog).getByRole("button", { name: "确认清空" }));
    await waitFor(() =>
      expect(
        localApi.requests.find((request) => request.url.endsWith("/rooms/general/clear"))?.body,
      ).toEqual({ username: "Alice", whiteboard: "archive", entries: [] }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "房间设置 · # general" })).toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "管理房间 frontend" }));
    const otherDialog = screen.getByRole("dialog", { name: "房间设置 · # frontend" });
    await user.click(within(otherDialog).getByRole("button", { name: "清空房间" }));
    await user.click(
      within(otherDialog).getByRole("checkbox", { name: "同时归档当前白板（历史可恢复）" }),
    );
    expect(
      within(otherDialog).getByText("仅清空聊天与调用记录，保留白板，不解除工作区占用。"),
    ).toBeTruthy();
    await user.click(within(otherDialog).getByRole("button", { name: "确认清空" }));
    await waitFor(() =>
      expect(
        localApi.requests.find((request) => request.url.endsWith("/rooms/frontend/clear"))?.body,
      ).toEqual({ username: "Alice", whiteboard: "keep" }),
    );
  });

  it("clears only current board state on linked events and preserves boards for chat-only and other rooms", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const now = "2026-11-16T00:00:00.000Z";
    const entry: WhiteboardEntry = {
      id: "00000000-0000-4000-8000-0000000000b1",
      roomId: "general",
      key: "done",
      slot: "ready",
      summary: "board item",
      authorId: self.id,
      authorName: self.username,
      unblocks: [],
      createdAt: now,
      updatedAt: now,
    };
    const message: ChatMessage = {
      id: "00000000-0000-4000-8000-000000000010",
      roomId: "general",
      seq: 1,
      senderId: self.id,
      senderName: self.username,
      senderType: "human",
      content: "cleared",
      kind: "topic",
      mentions: [],
      traceId: "00000000-0000-4000-8000-000000000011",
      hopCount: 0,
      createdAt: now,
    };
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
        whiteboard: [entry],
      }),
    );
    const panel = screen.getByLabelText("成员列表");
    const tab = within(panel).getByRole("tab", { name: /白板/ });
    await user.click(tab);
    act(() => socket.serverEvent({ type: "room.cleared", message, whiteboardArchived: false }));
    expect(within(panel).getByText(entry.summary)).toBeTruthy();
    act(() =>
      socket.serverEvent({
        type: "room.cleared",
        message: { ...message, roomId: "frontend" },
        whiteboardArchived: true,
      }),
    );
    expect(within(panel).getByText(entry.summary)).toBeTruthy();
    act(() => {
      socket.serverEvent({
        type: "whiteboard.removed",
        roomId: "general",
        entryId: entry.id,
        archivedEntry: { ...entry, archivedAt: now },
      });
      socket.serverEvent({ type: "room.cleared", message, whiteboardArchived: true });
    });
    expect(within(panel).queryByText(entry.summary)).toBeNull();
    expect(tab.textContent).toBe("白板");
    whiteboardApi.entries = [{ ...entry, archivedAt: now }];
    await user.click(within(panel).getByRole("button", { name: "历史归档" }));
    await waitFor(() => expect(within(panel).getByText(entry.summary)).toBeTruthy());
  });

  it("shows the room whiteboard grouped by slot and keeps it in sync", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const agent = participant("00000000-0000-4000-8000-000000000002", "backend-agent", "agent");
    const now = new Date().toISOString();
    const entryBase = {
      roomId: "general",
      authorId: agent.id,
      authorName: "backend-agent",
      unblocks: [] as string[],
      createdAt: now,
      updatedAt: now,
    };
    const ready = {
      ...entryBase,
      id: "00000000-0000-4000-8000-0000000000b1",
      key: "api",
      slot: "ready" as const,
      summary: "登录 API 已合入，可以接前端",
      repo: "superhive",
      branch: "feat/login",
      commit: "0123456789abcdef0123",
      unblocks: ["frontend-login"],
    };
    const blockedEntry = {
      ...entryBase,
      id: "00000000-0000-4000-8000-0000000000b2",
      key: "db",
      slot: "blocked" as const,
      summary: "等待数据库迁移权限",
    };
    whiteboardApi.entries = [ready, blockedEntry];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent],
        messages: [],
        latestSeq: 0,
        invocations: [],
        whiteboard: [ready, blockedEntry],
      }),
    );

    const panel = screen.getByLabelText("成员列表");
    const tab = within(panel).getByRole("tab", { name: /白板/ });
    expect(tab.getAttribute("aria-selected")).toBe("false");
    await user.click(tab);
    expect(tab.getAttribute("aria-selected")).toBe("true");
    const board = within(panel).getByRole("tabpanel");
    const headings = within(board)
      .getAllByRole("heading")
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["阻塞1", "已就绪1"]);
    expect(within(board).getByText("登录 API 已合入，可以接前端")).toBeTruthy();
    expect(within(board).getByText("feat/login")).toBeTruthy();
    expect(within(board).getByText("0123456")).toBeTruthy();
    expect(within(board).getByText("解除阻塞：frontend-login")).toBeTruthy();

    act(() =>
      socket.serverEvent({
        type: "whiteboard.updated",
        entry: {
          ...entryBase,
          id: "00000000-0000-4000-8000-0000000000b3",
          key: "ui",
          slot: "in_progress",
          summary: "正在做登录页",
        },
      }),
    );
    expect(
      within(board)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["阻塞1", "进行中的工作1", "已就绪1"]);

    expect(
      (within(board).getByRole("checkbox", { name: "选择事项：db" }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      within(board).queryByRole("button", { name: "从白板移除：等待数据库迁移权限" }),
    ).toBeNull();
    await user.click(within(board).getByRole("button", { name: "归档事项：api" }));
    await waitFor(() => expect(within(board).queryByText(ready.summary)).toBeNull());
    expect(whiteboardApi.requests).toEqual([
      { action: "archive", entries: [{ id: ready.id, updatedAt: ready.updatedAt }] },
    ]);
    expect(tab.textContent).toBe("白板2");
    await user.click(within(board).getByRole("button", { name: "历史归档" }));
    await waitFor(() => expect(within(board).getByText(ready.summary)).toBeTruthy());
    expect(within(board).queryByText(blockedEntry.summary)).toBeNull();
    await user.click(
      within(board).getByRole("button", { name: "从白板移除：登录 API 已合入，可以接前端" }),
    );
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "whiteboard.remove",
      entryId: ready.id,
      updatedAt: whiteboardApi.entries.find((entry) => entry.id === ready.id)!.updatedAt,
    });
    act(() =>
      socket.serverEvent({
        type: "whiteboard.removed",
        roomId: "general",
        entryId: ready.id,
      }),
    );
    expect(within(board).queryByText(ready.summary)).toBeNull();
    await user.click(within(board).getByRole("button", { name: "当前事项" }));

    act(() => {
      socket.serverEvent({
        type: "whiteboard.removed",
        roomId: "general",
        entryId: blockedEntry.id,
      });
      socket.serverEvent({
        type: "whiteboard.removed",
        roomId: "general",
        entryId: "00000000-0000-4000-8000-0000000000b3",
      });
    });
    expect(within(panel).getByText("白板还是空的")).toBeTruthy();
    expect(within(panel).getByText("hive_board_update")).toBeTruthy();
  });

  it("does not let a stale history response resurrect deleted items or overwrite a restore", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const updatedAt = "2026-11-16T00:00:00.000Z";
    const baseEntry = {
      roomId: "general",
      authorId: "00000000-0000-4000-8000-000000000002",
      authorName: "helper",
      unblocks: [],
      createdAt: updatedAt,
      updatedAt,
      archivedAt: updatedAt,
      slot: "ready" as const,
    };
    const restored = {
      ...baseEntry,
      id: "00000000-0000-4000-8000-0000000000b1",
      key: "restored",
      summary: "restored item",
    };
    const deleted = {
      ...baseEntry,
      id: "00000000-0000-4000-8000-0000000000b2",
      key: "deleted",
      summary: "deleted item",
    };
    let resolveHistory!: (response: Response) => void;
    const originalFetch = (fetch as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("/whiteboard?view=all")
          ? new Promise<Response>((resolve) => {
              resolveHistory = resolve;
            })
          : originalFetch(input, init),
    );
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
        whiteboard: [],
      }),
    );
    const panel = screen.getByLabelText("成员列表");
    const tab = within(panel).getByRole("tab", { name: /白板/ });
    await user.click(tab);
    await user.click(within(panel).getByRole("button", { name: "历史归档" }));
    await waitFor(() => expect(resolveHistory).toBeTypeOf("function"));
    const current: WhiteboardEntry = { ...restored };
    delete current.archivedAt;
    act(() => {
      socket.serverEvent({
        type: "whiteboard.updated",
        entry: { ...current, updatedAt: "2026-11-16T00:01:00.000Z" },
      });
      socket.serverEvent({ type: "whiteboard.removed", roomId: "general", entryId: deleted.id });
      resolveHistory(jsonResponse({ entries: [restored, deleted] }));
    });
    await waitFor(() => expect(within(panel).queryByText("正在加载白板历史…")).toBeNull());
    expect(within(panel).queryByText(deleted.summary)).toBeNull();
    expect(within(panel).queryByText(restored.summary)).toBeNull();
    await user.click(within(panel).getByRole("button", { name: "当前事项" }));
    expect(within(panel).getByText(restored.summary)).toBeTruthy();
    expect(tab.textContent).toBe("白板1");
  });

  it.each(["snapshot", "clear"])(
    "discards a history request after a room %s",
    async (eventType) => {
      const user = userEvent.setup();
      localStorage.setItem("superhive.username", "Alice");
      localStorage.setItem("superhive.notify-prompt-dismissed", "true");
      let resolveHistory!: (response: Response) => void;
      let historyRequests = 0;
      const originalFetch = (fetch as ReturnType<typeof vi.fn>).getMockImplementation()!;
      (fetch as ReturnType<typeof vi.fn>).mockImplementation(
        (input: RequestInfo | URL, init?: RequestInit) =>
          String(input).includes("/whiteboard?view=all")
            ? historyRequests++ === 0
              ? new Promise<Response>((resolve) => {
                  resolveHistory = resolve;
                })
              : Promise.resolve(jsonResponse({ entries: [] }))
            : originalFetch(input, init),
      );
      render(<App />);
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      act(() => socket.open());
      const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
      const snapshot = {
        type: "room.snapshot" as const,
        self,
        participants: [self],
        messages: [],
        latestSeq: 0,
        whiteboard: [],
      };
      act(() => socket.serverEvent(snapshot));
      const panel = screen.getByLabelText("成员列表");
      await user.click(within(panel).getByRole("tab", { name: /白板/ }));
      await user.click(within(panel).getByRole("button", { name: "历史归档" }));
      await waitFor(() => expect(resolveHistory).toBeTypeOf("function"));
      act(() => {
        if (eventType === "snapshot") socket.serverEvent(snapshot);
        else
          socket.serverEvent({
            type: "room.cleared",
            whiteboardArchived: true,
            message: {
              id: "00000000-0000-4000-8000-000000000010",
              roomId: "general",
              seq: 1,
              senderId: self.id,
              senderName: self.username,
              senderType: "human",
              content: "cleared",
              kind: "topic",
              mentions: [],
              traceId: "00000000-0000-4000-8000-000000000011",
              hopCount: 0,
              createdAt: "2026-11-16T00:00:00.000Z",
            },
          });
        resolveHistory(
          jsonResponse({
            entries: [
              {
                id: "00000000-0000-4000-8000-0000000000b1",
                key: "old",
                roomId: "general",
                slot: "ready",
                summary: "stale history",
                archivedAt: "2026-11-16T00:00:00.000Z",
                updatedAt: "2026-11-16T00:00:00.000Z",
                createdAt: "2026-11-16T00:00:00.000Z",
                authorId: self.id,
                authorName: "Alice",
                unblocks: [],
              },
            ],
          }),
        );
      });
      await waitFor(() => expect(within(panel).queryByText("正在加载白板历史…")).toBeNull());
      expect(within(panel).queryByText("stale history")).toBeNull();
      expect(historyRequests).toBe(2);
    },
  );

  it("shows a thinking card in the conversation while an agent works and folds it above the reply", async () => {
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const agent = participant("00000000-0000-4000-8000-000000000002", "helper", "agent");
    const now = new Date().toISOString();
    const message: ChatMessage = {
      id: "00000000-0000-4000-8000-0000000000a1",
      roomId: "general",
      seq: 1,
      senderId: self.id,
      senderName: "Alice",
      senderType: "human",
      content: "@helper 提交一下",
      mentions: ["helper"],
      traceId: "00000000-0000-4000-8000-0000000000a2",
      hopCount: 0,
      createdAt: now,
    };
    const invocation = {
      id: "00000000-0000-4000-8000-0000000000a3",
      roomId: "general",
      messageId: message.id,
      agentId: agent.id,
      agentName: "helper",
      requesterId: self.id,
      requesterName: "Alice",
      requesterType: "human" as const,
      status: "running" as const,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent],
        messages: [message],
        latestSeq: 1,
        invocations: [invocation],
      }),
    );
    act(() =>
      socket.serverEvent({
        type: "invocation.trace",
        roomId: "general",
        invocationId: invocation.id,
        steps: [
          { id: "x", kind: "text", text: "先看一下改动", startedAt: now, endedAt: now },
          {
            id: "t1",
            kind: "tool",
            tool: "command",
            summary: "git status",
            status: "running",
            startedAt: now,
          },
        ],
      }),
    );
    const list = () =>
      within(document.querySelector(".message-list")!.shadowRoot as unknown as HTMLElement);
    // 对话流里出现「思考中」卡片：顶部是当前这一步，主体是中途说的话，命令收成一行
    const card = await waitFor(() => list().getByRole("article", { name: "helper 正在处理" }));
    expect(within(card).getByText("运行 git status")).toBeTruthy();
    await waitFor(() => expect(within(card).getByText("先看一下改动")).toBeTruthy());
    expect(within(card).getByText("运行 1 条命令")).toBeTruthy();
    // 状态行不再重复当前这一步；底部「谁在干活」也不再重复列出有卡片的 Agent
    expect(list().getAllByText("运行 git status")).toHaveLength(1);
    expect(
      document.querySelector(".message-list")!.shadowRoot!.querySelector(".typing"),
    ).toBeNull();
    // 思考摘要按纯文本显示，和中途说的话分开
    act(() =>
      socket.serverEvent({
        type: "invocation.trace",
        roomId: "general",
        invocationId: invocation.id,
        steps: [
          {
            id: "th1",
            kind: "thinking",
            text: "<b>Checking</b> the diff [link](https://x.y)",
            startedAt: now,
          },
        ],
      }),
    );
    // 思考按 Markdown 渲染：HTML 原样显示成文字，链接不可点
    await waitFor(() => expect(within(card).getByText("link")).toBeTruthy());
    expect(within(card).getByText("link").closest(".thinking-card-line.thinking")).toBeTruthy();
    expect(card.textContent).toContain("<b>Checking</b>");
    expect(within(card).queryByRole("link")).toBeNull();

    // 详情弹窗里的完整时间线默认收起，免得同一份内容摆两遍
    await userEvent.setup().click(list().getByRole("button", { name: /@helper.*查看调用详情/ }));
    const dialog = screen.getByRole("dialog", { name: "调用详情" });
    const full = within(dialog)
      .getByText(/完整执行过程（3 步）/)
      .closest("details")!;
    expect(full.open).toBe(false);
    const trace = within(dialog).getByRole("region", { name: "执行过程" });
    act(() =>
      socket.serverEvent({
        type: "invocation.trace",
        roomId: "general",
        invocationId: invocation.id,
        steps: [{ id: "t1", kind: "tool", status: "error", startedAt: now, endedAt: now }],
      }),
    );
    expect(within(trace).getByText("失败")).toBeTruthy();
    await userEvent.setup().keyboard("{Escape}");

    // 做完并回复：卡片消失，回复上方收成一行回顾，点开还能看这一轮的过程
    const reply: ChatMessage = {
      ...message,
      id: "00000000-0000-4000-8000-0000000000a4",
      seq: 2,
      senderId: agent.id,
      senderName: "helper",
      senderType: "agent",
      content: "提交好了",
      mentions: [],
      parentMessageId: message.id,
    };
    act(() => {
      socket.serverEvent({
        type: "invocation.trace",
        roomId: "general",
        invocationId: invocation.id,
        steps: [],
        ended: true,
      });
      socket.serverEvent({ type: "message.created", message: reply });
      socket.serverEvent({
        type: "invocation.updated",
        invocation: {
          ...invocation,
          status: "completed",
          finishedAt: now,
          updatedAt: now,
          replyMessageId: reply.id,
        },
      });
    });
    await waitFor(() =>
      expect(list().queryByRole("article", { name: "helper 正在处理" })).toBeNull(),
    );
    const recap = list().getByRole("button", { name: /^helper 的过程/ });
    expect(recap.textContent).toContain("运行 1 条命令");
    await userEvent.setup().click(recap);
    await waitFor(() => expect(list().getByText("先看一下改动")).toBeTruthy());
  });

  it("offers send-and-insert only when the draft mentions an agent that is running", async () => {
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const helper = {
      ...participant("00000000-0000-4000-8000-000000000002", "helper", "agent"),
      provider: "claude",
    };
    const idle = {
      ...participant("00000000-0000-4000-8000-000000000003", "idle", "agent"),
      provider: "claude",
    };
    const now = new Date().toISOString();
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, helper, idle],
        messages: [],
        latestSeq: 0,
        invocations: [
          {
            id: "00000000-0000-4000-8000-0000000000f1",
            roomId: "general",
            messageId: "00000000-0000-4000-8000-0000000000f2",
            agentId: helper.id,
            agentName: "helper",
            requesterName: "Alice",
            requesterType: "human",
            status: "running",
            attempts: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    );
    const composer = screen.getByRole("textbox", { name: "消息" });
    fireEvent.change(composer, { target: { value: "@idle 看一下" } });
    expect(screen.queryByRole("button", { name: "引导" })).toBeNull();
    fireEvent.change(composer, { target: { value: "@helper 顺便把 README 也改了" } });
    fireEvent.click(screen.getByRole("button", { name: "引导" }));
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "message.send",
      content: "@helper 顺便把 README 也改了",
      steer: true,
    });
  });

  it("collapses the room list and remembers the choice after a reload", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const { container, unmount } = render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const workspace = container.querySelector(".workspace")!;
    expect(workspace.classList.contains("rooms-collapsed")).toBe(false);
    await user.click(screen.getByRole("button", { name: "隐藏房间列表" }));
    expect(workspace.classList.contains("rooms-collapsed")).toBe(true);
    expect(localStorage.getItem("superhive.rooms-collapsed")).toBe("true");
    unmount();

    const again = render(<App />);
    expect(again.container.querySelector(".workspace")!.classList.contains("rooms-collapsed")).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: "显示房间列表" }));
    expect(again.container.querySelector(".workspace")!.classList.contains("rooms-collapsed")).toBe(
      false,
    );
  });

  it("reorders pinned rooms by dragging and with Alt+arrow keys, and keeps the order on the server", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    // 旧版存在本机的手动顺序不再沿用，启动时清掉
    localStorage.setItem("superhive.room-order", JSON.stringify(["frontend", "general"]));
    roomPins.ids = ["general", "frontend"];
    const { container, unmount } = render(<App />);
    const names = () =>
      [...container.querySelectorAll(".room-list .room-item-name")].map((node) => node.textContent);
    await waitFor(() => expect(names()).toEqual(["# general", "# frontend"]));
    // jsdom 没有 PointerEvent：用 MouseEvent 补一个带 pointerId / pointerType 的
    if (typeof window.PointerEvent === "undefined") {
      class TestPointerEvent extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
          this.pointerType = init.pointerType ?? "mouse";
        }
      }
      vi.stubGlobal("PointerEvent", TestPointerEvent);
    }
    // jsdom 不排版：给两项各一个 36px 高的位置，拖拽才算得出落点
    const items = [...container.querySelectorAll<HTMLElement>(".room-list .room-item")];
    items.forEach((item, index) => {
      item.getBoundingClientRect = () =>
        ({
          top: index * 36,
          bottom: index * 36 + 36,
          height: 36,
          left: 0,
          right: 200,
          width: 200,
        }) as DOMRect;
    });
    container.querySelector<HTMLElement>(".room-list")!.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, height: 400, left: 0, right: 200, width: 200 }) as DOMRect;
    // 拖拽时的自动滚动每帧排一次：这里换成真正异步的帧，免得同步回调无限递归
    window.requestAnimationFrame = (callback) =>
      window.setTimeout(() => callback(performance.now()), 16);
    window.cancelAnimationFrame = (id) => window.clearTimeout(id);
    const main = items[0]!.querySelector<HTMLElement>(".room-item-main")!;
    fireEvent.pointerDown(main, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 30 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 60 });
    expect(items[0]!.classList.contains("dragging")).toBe(true);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 60 });
    // 松手后先滑到新位置，再提交顺序
    await waitFor(() => expect(names()).toEqual(["# frontend", "# general"]));
    await waitFor(() => expect(roomPins.requests).toEqual([["frontend", "general"]]));
    expect(localStorage.getItem("superhive.room-order")).toBeNull();

    // 键盘：Alt + ↑ 把 general 移回第一位
    const general = [...container.querySelectorAll<HTMLElement>(".room-list .room-item-main")][1]!;
    general.focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(names()).toEqual(["# general", "# frontend"]);
    await waitFor(() => expect(roomPins.ids).toEqual(["general", "frontend"]));
    unmount();

    // 重新打开（换设备也一样）：顺序来自服务端
    roomPins.ids = ["frontend", "general"];
    const again = render(<App />);
    await waitFor(() =>
      expect(
        [...again.container.querySelectorAll(".room-list .room-item-name")].map(
          (node) => node.textContent,
        ),
      ).toEqual(["# frontend", "# general"]),
    );
  });

  it("sorts unpinned rooms by their latest message and re-sorts when a new one arrives", async () => {
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const { container } = render(<App />);
    const names = () =>
      [...container.querySelectorAll(".room-list .room-item-name")].map((node) => node.textContent);
    await waitFor(() => expect(names()).toEqual(["# frontend", "# general"]));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const socket = FakeWebSocket.instances.at(-1)!;
    act(() => socket.open());
    const activity = (latestSeq: number, lastActivityAt: string) =>
      act(() =>
        socket.serverEvent({
          type: "room.activity",
          roomId: "general",
          latestSeq,
          onlineCount: 1,
          lastActivityAt,
        }),
      );
    activity(1, "2026-11-13T04:00:00.000Z");
    expect(names()).toEqual(["# general", "# frontend"]);

    // 鼠标停在列表上时先不动，移开后再排
    const list = container.querySelector<HTMLElement>(".room-list")!;
    fireEvent.pointerEnter(list);
    act(() =>
      socket.serverEvent({
        type: "rooms.changed",
        room: roomSummary("frontend", { latestSeq: 3, lastActivityAt: "2026-11-13T04:05:00.000Z" }),
      }),
    );
    expect(names()).toEqual(["# general", "# frontend"]);
    fireEvent.pointerLeave(list);
    expect(names()).toEqual(["# frontend", "# general"]);
  });

  it("lists scheduled tasks with their run state and lets a human cancel a pending one", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const self = participant("00000000-0000-4000-8000-000000000001", "Alice", "human");
    const agent = participant("00000000-0000-4000-8000-000000000002", "helper", "agent");
    const now = new Date().toISOString();
    const base = {
      roomId: "general",
      agentId: agent.id,
      agentName: "helper",
      requesterId: self.id,
      requesterName: "Alice",
      originMessageId: "00000000-0000-4000-8000-0000000000c0",
      originSeq: 3,
      timeZone: "Asia/Shanghai",
      createdAt: now,
      updatedAt: now,
    };
    const pending = {
      ...base,
      id: "00000000-0000-4000-8000-0000000000c1",
      task: "0 点提醒 Alice 看部署结果",
      runAt: new Date(Date.now() + 90 * 60_000).toISOString(),
      status: "scheduled" as const,
    };
    const fired = {
      ...base,
      id: "00000000-0000-4000-8000-0000000000c2",
      task: "推送日报",
      runAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      status: "fired" as const,
      triggerMessageId: "00000000-0000-4000-8000-0000000000d1",
      invocationId: "00000000-0000-4000-8000-0000000000e1",
    };
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self,
        participants: [self, agent],
        messages: [],
        latestSeq: 0,
        invocations: [
          {
            id: fired.invocationId,
            roomId: "general",
            messageId: fired.triggerMessageId,
            agentId: agent.id,
            agentName: "helper",
            requesterId: self.id,
            requesterName: "Alice",
            requesterType: "human",
            status: "completed",
            attempts: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
        schedules: [pending, fired],
      }),
    );

    const panel = screen.getByLabelText("成员列表");
    const tab = within(panel).getByRole("tab", { name: /定时/ });
    expect(within(tab).getByText("1")).toBeTruthy();
    await user.click(tab);
    const list = within(panel).getByRole("tabpanel");
    expect(
      within(list)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["待执行1", "已发出与结束1"]);
    expect(within(list).getByText("0 点提醒 Alice 看部署结果")).toBeTruthy();
    expect(within(list).getAllByText(/Asia\/Shanghai/, { selector: "time" })).toHaveLength(2);
    // 跑完了但没有回复：不当成成功
    expect(within(list).getByText("没有回复")).toBeTruthy();
    expect(within(list).getByText(/1 小时 30 分钟后|1 小时 29 分钟后/)).toBeTruthy();

    await user.click(
      within(list).getByRole("button", { name: "取消定时任务：0 点提醒 Alice 看部署结果" }),
    );
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "schedule.cancel",
      scheduleId: pending.id,
    });
    act(() =>
      socket.serverEvent({
        type: "schedule.updated",
        schedule: {
          ...pending,
          status: "cancelled",
          cancelledBy: "Alice",
          detail: "Alice 取消了",
          updatedAt: new Date(Date.now() + 1_000).toISOString(),
        },
      }),
    );
    expect(within(list).getByText("已取消")).toBeTruthy();
    expect(within(tab).queryByText("1")).toBeNull();
  });

  it("reminds me across rooms when my task needs me or finishes, and jumps to it", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    FakeNotification.permission = "granted";
    const at = new Date().toISOString();
    const task = (id: string, status: Invocation["status"], extra: Partial<Invocation> = {}) =>
      ({
        id,
        roomId: "frontend",
        messageId: "00000000-0000-4000-8000-000000000201",
        agentId: "00000000-0000-4000-8000-000000000105",
        agentName: "frontend-agent",
        requesterName: "Alice",
        requesterType: "human",
        status,
        attempts: 1,
        createdAt: at,
        updatedAt: at,
        ...extra,
      }) as Invocation;
    const first = "00000000-0000-4000-8000-000000000301";
    const second = "00000000-0000-4000-8000-000000000302";
    crossRoom.invocations = [task(first, "running"), task(second, "running")];
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self: participant("00000000-0000-4000-8000-000000000001", "Alice", "human"),
        participants: [],
        messages: [],
        latestSeq: 0,
      }),
    );
    expect(await screen.findByRole("img", { name: "# frontend：2 个任务进行中" })).toBeTruthy();
    // 标签页图标：你派的任务在跑，蓝点；标题不带数字
    await waitFor(() =>
      expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.dataset.badge).toBe(
        "running",
      ),
    );
    expect(document.title.startsWith("(")).toBe(false);

    // 页面不在前台：两条任务各弹一条系统通知，不会互相顶掉
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => {
      socket.serverEvent({ type: "invocation.updated", invocation: task(first, "waiting_human") });
      socket.serverEvent({
        type: "invocation.updated",
        invocation: task(second, "failed", { detail: "测试没过" }),
      });
    });
    expect(FakeNotification.instances.map((item) => item.title)).toEqual([
      "frontend-agent 在等你回答",
      "frontend-agent 的任务失败了",
    ]);
    expect(FakeNotification.instances[1]!.options?.body).toBe("# frontend · 测试没过");
    expect(new Set(FakeNotification.instances.map((item) => item.options?.tag)).size).toBe(2);
    // 同一状态的重复推送不再提醒
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: task(second, "failed", { detail: "测试没过" }),
      }),
    );
    expect(FakeNotification.instances).toHaveLength(2);
    // 侧栏列出需要处理的，最急的在前
    const group = screen.getByRole("region", { name: "需要你处理" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((item) => item.textContent),
    ).toEqual(["等你回答frontend-agent · # frontend", "失败frontend-agent · # frontend"]);
    // 需要你处理的优先：红点，标题数出 2 条
    expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.dataset.badge).toBe(
      "attention",
    );
    expect(document.title.startsWith("(2) ")).toBe(true);

    // 回到前台、但看的是别的房间：做完了在页面内提示，房间上标「完成未看」
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      socket.serverEvent({ type: "invocation.updated", invocation: task(first, "completed") });
    });
    expect(FakeNotification.instances).toHaveLength(2);
    const toasts = screen.getByRole("region", { name: "任务提醒" });
    expect(within(toasts).getByText("frontend-agent 做完了")).toBeTruthy();
    expect(screen.getByRole("img", { name: "# frontend：1 个任务需要处理" })).toBeTruthy();
    act(() =>
      socket.serverEvent({
        type: "invocation.updated",
        invocation: task(second, "failed", {
          detail: "测试没过",
          resolution: { kind: "dismissed", at },
        }),
      }),
    );
    expect(
      await screen.findByRole("img", { name: "# frontend：1 个任务做完了，还没看" }),
    ).toBeTruthy();
    // 没有要处理、也没有在跑的了：只剩做完未看，绿点，标题去掉数字
    expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.dataset.badge).toBe(
      "unseen",
    );
    expect(document.title.startsWith("(")).toBe(false);

    // 点「查看」跳到那个房间；看过之后「完成未看」消失
    // 点整条提示就跳过去，没有单独的「查看」按钮
    expect(within(toasts).queryByRole("button", { name: "查看" })).toBeNull();
    await user.click(within(toasts).getByRole("button", { name: /frontend-agent 做完了/ }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "# frontend：1 个任务做完了，还没看" })).toBeNull(),
    );
    expect(within(toasts).queryByText("frontend-agent 做完了")).toBeNull();
  });

  it("walks a first-time owner through connecting an agent, notifications and IM", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText("你的用户名"), "Alice");
    await user.click(screen.getByRole("button", { name: /进入聊天室/ }));
    const guide = await screen.findByRole("dialog", { name: "三步开始用 SuperHive" });
    expect(within(guide).getByText("接入一个 Agent")).toBeTruthy();
    expect(within(guide).getByText("连上飞书或微信")).toBeTruthy();
    // 进入时已顺带授权了通知，这一步自动算完成
    await waitFor(() => expect(within(guide).getByText("第一次使用 · 已完成 1/3")).toBeTruthy());

    // 去接 Agent：引导先收起，弹窗关掉后可以接着看
    await user.click(within(guide).getByRole("button", { name: "接入 Agent" }));
    expect(screen.queryByRole("dialog", { name: "三步开始用 SuperHive" })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("button", { name: "继续上手引导（1/3）" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "三步开始用 SuperHive" })).getByRole("button", {
        name: "跳过，以后再说",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "三步开始用 SuperHive" })).toBeNull();
    expect(screen.queryByRole("button", { name: /继续上手引导/ })).toBeNull();
    expect(localStorage.getItem("superhive.onboarding")).toBe("done");
  });

  it("does not show the first-time guide to people who already used this browser", async () => {
    localStorage.setItem("superhive.username", "Alice");
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: "三步开始用 SuperHive" })).toBeNull();
    expect(localStorage.getItem("superhive.onboarding")).toBeNull();
  });

  it("opens search, mentions and agent tasks from the sidebar and jumps across rooms", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const mention: ChatMessage = {
      id: "00000000-0000-4000-8000-000000000101",
      roomId: "frontend",
      seq: 5,
      senderId: "00000000-0000-4000-8000-000000000102",
      senderName: "Bob",
      senderType: "human",
      content: "@Alice 登录页的设计稿好了",
      mentions: ["Alice"],
      traceId: "00000000-0000-4000-8000-000000000103",
      hopCount: 0,
      createdAt: new Date().toISOString(),
    };
    crossRoom.mentions = [mention];
    crossRoom.searchable = [mention];
    crossRoom.invocationMessages = [mention];
    crossRoom.invocations = [
      {
        id: "00000000-0000-4000-8000-000000000104",
        roomId: "frontend",
        messageId: mention.id,
        agentId: "00000000-0000-4000-8000-000000000105",
        agentName: "frontend-agent",
        requesterName: "Bob",
        requesterType: "human",
        status: "failed",
        detail: "连续失败 3 次",
        attempts: 1,
        createdAt: mention.createdAt,
        updatedAt: mention.createdAt,
      },
    ];
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() =>
      socket.serverEvent({
        type: "room.snapshot",
        self: participant("00000000-0000-4000-8000-000000000001", "Alice", "human"),
        participants: [],
        messages: [],
        latestSeq: 0,
      }),
    );

    const mentionsEntry = await screen.findByRole("button", { name: "提及我，1 条未读" });
    expect(await screen.findByRole("button", { name: "Agent 任务，1 个需要处理" })).toBeTruthy();
    // 房间列表里该房间右侧显示需要处理的任务数
    expect(screen.getByRole("img", { name: "# frontend：1 个任务需要处理" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Agent 任务，1 个需要处理" }));
    const tasks = screen.getByRole("dialog", { name: "Agent 任务" });
    expect(within(tasks).getByText("@frontend-agent · 失败")).toBeTruthy();
    expect(within(tasks).getByText("连续失败 3 次")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Agent 任务" })).toBeNull();

    // ⌘K 打开搜索，输入后按 Enter 跳到原文所在房间
    await user.keyboard("{Meta>}k{/Meta}");
    const searchBox = await screen.findByRole("searchbox", { name: "搜索消息" });
    await user.type(searchBox, "设计稿");
    const searchDialog = screen.getByRole("dialog", { name: "搜索消息" });
    await waitFor(() =>
      expect(within(searchDialog).getByRole("option", { name: /Bob/ })).toBeTruthy(),
    );
    await user.keyboard("{Escape}");

    await user.click(mentionsEntry);
    const mentionsDialog = screen.getByRole("dialog", { name: "提及我" });
    // 默认只列未读，读过的提及会离开列表
    expect(
      within(mentionsDialog).getByRole("button", { name: "未读 1" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(within(mentionsDialog).getByRole("option", { name: /登录页的设计稿/ }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    act(() => FakeWebSocket.instances[1]!.open());
    expect(JSON.parse(FakeWebSocket.instances[1]!.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "frontend",
    });
    expect(window.location.hash).toBe("#frontend");
  });

  it("opens Go To with ⌘P, jumps to the next task needing attention with ⌘J, and lists shortcuts", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.username", "Alice");
    localStorage.setItem("superhive.notify-prompt-dismissed", "true");
    const question: ChatMessage = {
      id: "00000000-0000-4000-8000-000000000201",
      roomId: "frontend",
      seq: 7,
      senderId: "00000000-0000-4000-8000-000000000202",
      senderName: "Bob",
      senderType: "human",
      content: "@frontend-agent 改一下登录页",
      mentions: ["frontend-agent"],
      traceId: "00000000-0000-4000-8000-000000000203",
      hopCount: 0,
      createdAt: new Date().toISOString(),
    };
    crossRoom.invocationMessages = [question];
    crossRoom.invocations = [
      {
        id: "00000000-0000-4000-8000-000000000204",
        roomId: "frontend",
        messageId: question.id,
        agentId: "00000000-0000-4000-8000-000000000205",
        agentName: "frontend-agent",
        requesterName: "Bob",
        requesterType: "human",
        status: "waiting_human",
        detail: "用哪套配色？",
        attempts: 1,
        createdAt: question.createdAt,
        updatedAt: question.createdAt,
      },
    ];
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.open());
    act(() =>
      FakeWebSocket.instances[0]!.serverEvent({
        type: "room.snapshot",
        self: participant("00000000-0000-4000-8000-000000000001", "Alice", "human"),
        participants: [],
        messages: [],
        latestSeq: 0,
      }),
    );
    await screen.findByRole("button", { name: "Agent 任务，1 个需要处理" });

    // 输入框里打 ? 只是输入文字，不会弹出快捷键帮助；⌘/ 任何时候都能打开
    const composer = screen.getByRole("textbox", { name: "消息" });
    await user.click(composer);
    await user.keyboard("?");
    expect(screen.queryByRole("dialog", { name: "快捷键" })).toBeNull();
    await user.keyboard("{Meta>}/{/Meta}");
    const help = await screen.findByRole("dialog", { name: "快捷键" });
    expect(within(help).getByText("跳到下一个要你处理的任务")).toBeTruthy();
    await user.type(within(help).getByRole("searchbox", { name: "筛选快捷键" }), "房间");
    expect(within(help).queryByText("换行")).toBeNull();
    expect(within(help).getByText("把选中的置顶房间上移一格")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "快捷键" })).toBeNull();

    // ⌘P 打开跳转器：要处理的任务排最前，可按名字筛
    await user.keyboard("{Meta>}p{/Meta}");
    const goto = await screen.findByRole("dialog", { name: "跳转到" });
    const options = within(goto).getAllByRole("option");
    expect(options[0]!.textContent).toContain("@frontend-agent · 等你回答");
    await user.click(within(goto).getByRole("button", { name: /^要处理/ }));
    for (const option of within(goto).getAllByRole("option")) {
      expect(option.textContent).toContain("要处理");
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "跳转到" })).toBeNull();

    // ⌘J 直接跳到那条任务所在的房间
    await user.keyboard("{Meta>}j{/Meta}");
    expect(await screen.findByText("要处理的第 1/1 条 · @frontend-agent · 等你回答")).toBeTruthy();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    act(() => FakeWebSocket.instances[1]!.open());
    expect(JSON.parse(FakeWebSocket.instances[1]!.sent[0]!)).toMatchObject({
      type: "participant.join",
      roomId: "frontend",
    });
  });
});
