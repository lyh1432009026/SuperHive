// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceDiff,
  WorkspaceOverview,
  WorkspaceStatus,
  WorkspaceTree,
} from "@superhive/protocol";
import { WorkspacePanel, type WorkspaceApi } from "./workspace-panel";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

const overview: WorkspaceOverview = {
  configured: true,
  name: "hive",
  git: true,
  changeCount: 3,
  guestsAllowed: false,
  canReveal: true,
  sources: [{ id: "workspace", kind: "workspace", label: "hive", branch: "main" }],
};

const status: WorkspaceStatus = {
  git: true,
  branch: "main",
  upstream: "origin/main",
  ahead: 2,
  behind: 0,
  changes: [
    { path: "src/app.ts", group: "unstaged", status: "M", additions: 1, deletions: 1 },
    { path: "README.md", group: "staged", status: "A", additions: 2, deletions: 0 },
    { path: ".env", group: "untracked", status: "?", additions: 1, sensitive: true },
  ],
};

const longPatch = [
  "@@ -1,16 +1,16 @@",
  ...Array.from({ length: 10 }, (_, index) => ` line${index + 1}`),
  "-const value = 1;",
  "+const value = 2;",
  ...Array.from({ length: 5 }, (_, index) => ` line${index + 12}`),
  "",
].join("\n");

type Handler = (query: Record<string, string | undefined>) => unknown;

function fakeApi(overrides: Record<string, Handler> = {}) {
  const handlers: Record<string, Handler> = {
    "": () => overview,
    "/status": () => status,
    "/diff": (query) =>
      query.path === ".env" && !query.reveal
        ? ({ path: ".env", sensitive: true } satisfies WorkspaceDiff)
        : query.path === ".env"
          ? { path: ".env", sensitive: true, patch: "@@ -0,0 +1 @@\n+TOKEN=1\n", full: true }
          : { path: query.path!, patch: longPatch, full: true },
    "/tree": (query) =>
      ({
        path: query.path ?? "",
        entries:
          (query.path ?? "") === ""
            ? [
                { name: "src", path: "src", type: "directory", status: "M" },
                { name: "README.md", path: "README.md", type: "file", size: 12 },
              ]
            : [{ name: "app.ts", path: "src/app.ts", type: "file", size: 20, status: "M" }],
      }) satisfies WorkspaceTree,
    "/file": (query) => ({ path: query.path, size: 20, content: "const a = 1;\nconst b = 2;\n" }),
    "/log": () => ({ commits: [] }),
    "/raw-url": (query) => ({
      url: `/raw?t=${query.ref}:${query.path}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      size: 10,
      contentType: "image/png",
      inline: true,
    }),
    ...overrides,
  };
  const api = vi.fn(async (path: string, query: Record<string, string | undefined> = {}) => {
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected ${path}`);
    return handler(query);
  });
  return api as typeof api & WorkspaceApi;
}

function open(api: WorkspaceApi, props: Partial<Parameters<typeof WorkspacePanel>[0]> = {}) {
  const onClose = vi.fn();
  render(
    <WorkspacePanel
      api={api}
      roomId="general"
      workspaceConfigured
      isOwner
      onClose={onClose}
      {...props}
    />,
  );
  return { onClose };
}

describe("WorkspacePanel", () => {
  it("房间没设工作区：给出说明和去设置的入口，不发请求", async () => {
    const api = fakeApi();
    const onOpenSettings = vi.fn();
    open(api, { workspaceConfigured: false, onOpenSettings });
    expect(screen.getByText("这个房间还没有设工作区。")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "去设置工作区" }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  it("按已暂存 / 未暂存 / 未跟踪分组列出改动，带分支与领先数，自动打开第一个文件的 diff", async () => {
    const api = fakeApi();
    const onOverview = vi.fn();
    open(api, { onOverview });
    const list = await screen.findByLabelText("改动的文件");
    const groups = (await within(list).findAllByRole("heading", { level: 3 })).map(
      (heading) => heading.textContent,
    );
    expect(groups).toEqual(["已暂存1", "未暂存1", "未跟踪1"]);
    expect(within(list).getByText("main")).toBeTruthy();
    expect(within(list).getByText("↑2")).toBeTruthy();
    expect(within(list).getByTitle("可能含密钥")).toBeTruthy();
    expect(onOverview).toHaveBeenCalledWith(expect.objectContaining({ changeCount: 3 }));
    // 第一个是已暂存的 README.md
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/diff",
        expect.objectContaining({ path: "README.md", mode: "staged", full: "1" }),
      ),
    );
    expect(await screen.findByRole("table", { name: "README.md 的改动" })).toBeTruthy();
  });

  it("diff：折叠未改动、全部展开、切换左右对照并记住选择", async () => {
    const api = fakeApi();
    open(api);
    const table = await screen.findByRole("table", { name: "README.md 的改动" });
    expect(within(table).getByRole("button", { name: "展开 7 行未改动" })).toBeTruthy();
    expect(within(table).queryByText("line1")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(within(table).getByText("line1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "折叠未改动" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    await userEvent.click(screen.getByRole("radio", { name: "左右对照" }));
    expect(localStorage.getItem("superhive.workspace-diff-view")).toBe("split");
    const split = screen.getByRole("table", { name: "README.md 的改动" });
    expect(split.classList.contains("split")).toBe(true);
    // 删除和新增配成同一行：左边旧值、右边新值
    const row = within(split)
      .getAllByRole("row")
      .find((item) => item.textContent?.includes("const value = 1;"));
    expect(row?.textContent).toContain("const value = 2;");
  });

  it("疑似密钥文件：默认不显示，房主确认后带 reveal 再取", async () => {
    const api = fakeApi();
    open(api);
    await userEvent.click(await screen.findByRole("button", { name: /\.env/ }));
    expect(await screen.findByText("这个文件可能含有密钥，默认不显示内容。")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "显示内容…" }));
    await userEvent.click(screen.getByRole("button", { name: "确认显示" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/diff",
        expect.objectContaining({ path: ".env", reveal: "1" }),
      ),
    );
    expect(await screen.findByText("TOKEN=1")).toBeTruthy();
  });

  it("不能查看密钥的人只看到说明", async () => {
    const api = fakeApi({ "": () => ({ ...overview, canReveal: false }) });
    open(api);
    await userEvent.click(await screen.findByRole("button", { name: /\.env/ }));
    expect(await screen.findByText("只有房主可以查看。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "显示内容…" })).toBeNull();
  });

  it("文件树懒加载：展开目录才取下一层，点文件只读预览", async () => {
    const api = fakeApi();
    open(api);
    await userEvent.click(await screen.findByRole("tab", { name: "文件树" }));
    const src = await screen.findByRole("button", { name: /^src/ });
    expect(src.getAttribute("aria-expanded")).toBe("false");
    expect(api).not.toHaveBeenCalledWith("/tree", expect.objectContaining({ path: "src" }));
    await userEvent.click(src);
    expect(src.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(await screen.findByRole("button", { name: /^app\.ts/ }));
    expect(api).toHaveBeenCalledWith("/tree", expect.objectContaining({ path: "src" }));
    const preview = await screen.findByRole("table", { name: "src/app.ts" });
    expect(within(preview).getAllByRole("row")).toHaveLength(2);
    // 切换显示被忽略的文件会带上 ignored=1 重新取
    await userEvent.click(screen.getByRole("checkbox", { name: "显示被 .gitignore 忽略的文件" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/tree",
        expect.objectContaining({ path: "", ignored: "1" }),
      ),
    );
  });

  it("面板打开时定时刷新状态，Esc 关闭", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi();
    const { onClose } = open(api);
    await screen.findByLabelText("改动的文件");
    const before = api.mock.calls.filter(([path]) => path === "/status").length;
    await act(async () => {
      vi.advanceTimersByTime(4100);
    });
    await waitFor(() =>
      expect(api.mock.calls.filter(([path]) => path === "/status").length).toBeGreaterThan(before),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("有 worktree 时可以切换来源，默认看相对 base 的改动", async () => {
    const worktreeId = "00000000-0000-4000-8000-0000000000aa";
    const api = fakeApi({
      "": () => ({
        ...overview,
        sources: [
          ...overview.sources,
          {
            id: worktreeId,
            kind: "worktree",
            label: "feat/x",
            branch: "feat/x",
            agentName: "helper",
            base: "main",
          },
        ],
      }),
      "/compare": () => ({
        base: "main",
        mergeBase: "abc",
        commits: [{ hash: "a", shortHash: "a", subject: "work", author: "h", date: "" }],
        changes: [{ path: "src/x.ts", group: "unstaged", status: "M", additions: 3, deletions: 0 }],
      }),
    });
    open(api);
    await userEvent.click(await screen.findByRole("combobox", { name: "查看哪份代码" }));
    await userEvent.click(await screen.findByRole("option", { name: /feat\/x/ }));
    expect(await screen.findByText("1 个提交 · 1 个文件")).toBeTruthy();
    expect(api).toHaveBeenCalledWith("/compare", { source: worktreeId, base: "main" });
    expect(screen.getByRole("radio", { name: "相对 main" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/diff",
        expect.objectContaining({
          source: worktreeId,
          path: "src/x.ts",
          mode: "base",
          base: "main",
        }),
      ),
    );
  });

  it("加载失败时显示服务端说明并可重试", async () => {
    let fail = true;
    const api = fakeApi({
      "": () => {
        if (fail) throw new Error("房主没有开放工作区文件查看。");
        return overview;
      },
    });
    open(api);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("房主没有开放工作区文件查看。"),
    );
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByLabelText("改动的文件")).toBeTruthy();
  });

  it("图片改动显示改前改后对照，新增图片只显示改后", async () => {
    const api = fakeApi({
      "/status": () => ({
        git: true,
        branch: "main",
        changes: [
          { path: "logo.png", group: "unstaged", status: "M", binary: true },
          { path: "new.png", group: "untracked", status: "?", binary: true },
        ],
      }),
      "/diff": (query) => ({ path: query.path, binary: true }),
    });
    open(api);
    expect(await screen.findByText("改前")).toBeTruthy();
    const images = await screen.findAllByRole<HTMLImageElement>("img");
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "/raw?t=index:logo.png",
      "/raw?t=worktree:logo.png",
    ]);
    expect(screen.queryByRole("radio", { name: "左右对照" })).toBeNull();
    await userEvent.click(
      within(screen.getByLabelText("改动的文件")).getByRole("button", { name: /new\.png/ }),
    );
    expect(await screen.findByText("新增")).toBeTruthy();
    expect(screen.queryByText("改前")).toBeNull();
  });

  it("文件树：图片直接预览、SVG 可切到源码，其他二进制给下载", async () => {
    const api = fakeApi({
      "/tree": () => ({
        path: "",
        entries: [
          { name: "icon.svg", path: "icon.svg", type: "file", size: 30 },
          { name: "tool.bin", path: "tool.bin", type: "file", size: 30 },
        ],
      }),
      "/file": (query) =>
        query.path === "tool.bin"
          ? { path: "tool.bin", size: 30, binary: true }
          : { path: query.path, size: 30, content: "<svg></svg>\n" },
    });
    open(api);
    await userEvent.click(await screen.findByRole("tab", { name: "文件树" }));
    await userEvent.click(await screen.findByRole("button", { name: /^icon\.svg/ }));
    expect((await screen.findByRole("img", { name: "icon.svg" })).getAttribute("src")).toBe(
      "/raw?t=worktree:icon.svg",
    );
    expect(api).not.toHaveBeenCalledWith("/file", expect.objectContaining({ path: "icon.svg" }));
    await userEvent.click(screen.getByRole("button", { name: "看源码" }));
    expect(await screen.findByRole("table", { name: "icon.svg" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^tool\.bin/ }));
    expect(await screen.findByText("二进制文件，不能在这里预览。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "下载" })).toBeTruthy();
  });
});
