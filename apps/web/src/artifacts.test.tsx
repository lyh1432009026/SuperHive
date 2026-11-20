// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, ArtifactCounts, ArtifactsResponse } from "@superhive/protocol";
import { utils, write } from "xlsx";
import { ArtifactsPanel } from "./artifacts";

let serial = 0;
function item(name: string, extra: Partial<Artifact> = {}): Artifact {
  serial += 1;
  const image = /\.png$/.test(name);
  return {
    id: `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    name,
    mime: image ? "image/png" : "text/plain",
    size: 2048,
    kind: image ? "image" : "text",
    sha256: "a".repeat(64),
    category: image ? "image" : /\.ts$/.test(name) ? "code" : "document",
    messageId: `10000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    messageSeq: 100 - serial,
    senderId: "20000000-0000-4000-8000-000000000001",
    senderName: "rd-codex",
    senderType: "agent",
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

const counts = (artifacts: Artifact[]): ArtifactCounts => ({
  all: artifacts.length,
  image: artifacts.filter((a) => a.category === "image").length,
  file: artifacts.filter((a) => a.category !== "image").length,
  document: artifacts.filter((a) => a.category === "document").length,
  code: artifacts.filter((a) => a.category === "code").length,
  data: 0,
  archive: 0,
  media: 0,
  other: 0,
});

/** 假的产物接口：按 type / q / cursor / limit 返回，记录请求 */
let store: Artifact[] = [];
const requests: URLSearchParams[] = [];
function serve(url: string): ArtifactsResponse {
  const params = new URL(url).searchParams;
  requests.push(params);
  const type = params.get("type") ?? "all";
  const q = (params.get("q") ?? "").toLowerCase();
  const limit = Number(params.get("limit") ?? 40);
  const sender = params.get("sender");
  const since = params.get("since");
  const scoped = store.filter(
    (a) =>
      (!sender || a.senderId === sender) &&
      (!since || Date.parse(a.createdAt) >= Date.parse(since)),
  );
  const matched = scoped.filter(
    (a) =>
      (type === "all" || (type === "file" ? a.category !== "image" : a.category === type)) &&
      a.name.toLowerCase().includes(q),
  );
  const cursor = params.get("cursor");
  const start = cursor ? matched.findIndex((a) => a.id === cursor.split(".")[1]) + 1 : 0;
  const page = matched.slice(start, start + limit);
  return {
    artifacts: page,
    ...(start + page.length < matched.length
      ? { nextCursor: `${page.at(-1)!.messageSeq}.${page.at(-1)!.id}` }
      : {}),
    counts: counts(scoped),
    senders: [...new Map(store.map((a) => [a.senderId, a])).values()].map((a) => ({
      id: a.senderId,
      name: a.senderName,
      type: a.senderType,
      count: store.filter((other) => other.senderId === a.senderId).length,
    })),
  };
}

beforeEach(() => {
  localStorage.clear();
  store = [];
  requests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/rooms/general/attachments")) {
        return new Response(JSON.stringify(serve(url)), {
          headers: { "Content-Type": "application/json" },
        });
      }
      // 图片原件
      return new Response(new Blob(["x"], { type: "image/png" }));
    }),
  );
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:thumb" }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const panel = (props: Partial<Parameters<typeof ArtifactsPanel>[0]> = {}) => (
  <ArtifactsPanel
    base="http://hive"
    token="t"
    roomId="general"
    epoch={0}
    onLocate={vi.fn()}
    onClose={vi.fn()}
    {...props}
  />
);

const HUMAN = "20000000-0000-4000-8000-000000000002";

describe("ArtifactsPanel", () => {
  it("shows latest images above the file table, filters by type and searches by name", async () => {
    const user = userEvent.setup();
    store = [item("chart.png"), item("report.md"), item("main.ts"), item("notes.txt")];
    const onCounts = vi.fn();
    render(panel({ onCounts }));

    expect(screen.getByRole("dialog", { name: "产物" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /查看图片 chart\.png/ })).toBeTruthy();
    const files = await screen.findByRole("table", { name: "文件" });
    expect(
      within(files)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("report.md"),
      expect.stringContaining("main.ts"),
      expect.stringContaining("notes.txt"),
    ]);
    expect(
      within(files)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["名称", "类型", "大小", "发送者", "时间", "操作"]);
    expect(onCounts).toHaveBeenCalledWith(expect.objectContaining({ all: 4, image: 1 }));
    const types = screen.getByRole("group", { name: "按类型筛选" });
    expect(
      within(types)
        .getByRole("button", { name: /全部\s*4/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    // 文件细分类型一直列在「文件」下面
    await user.click(within(types).getByRole("button", { name: /^代码\s*1/ }));
    await waitFor(() =>
      expect(screen.getByRole("table", { name: "代码" }).textContent).toContain("main.ts"),
    );
    expect(screen.queryByText("report.md")).toBeNull();
    // 只有文件时没有网格 / 列表切换
    expect(screen.queryByRole("group", { name: "图片显示方式" })).toBeNull();

    await user.click(within(types).getByRole("button", { name: /^全部/ }));
    await user.type(screen.getByRole("searchbox", { name: "按文件名搜索产物" }), "NOTES");
    await waitFor(() => expect(requests.at(-1)?.get("q")).toBe("NOTES"));
    await waitFor(() => expect(screen.queryByText("report.md")).toBeNull());
    expect(screen.getByText("notes.txt")).toBeTruthy();

    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "zzz");
    expect(await screen.findByText("没有文件名包含「zzz」的产物")).toBeTruthy();
  });

  it("filters by sender and time range without moving the header badge", async () => {
    const user = userEvent.setup();
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    store = [
      item("today.md"),
      item("mine.md", { senderId: HUMAN, senderName: "rd", senderType: "human" }),
      item("ancient.md", { createdAt: old }),
    ];
    const onCounts = vi.fn();
    render(panel({ onCounts }));
    const people = await screen.findByRole("group", { name: "按发送者筛选" });
    expect(
      within(people).getByRole("button", { name: "所有人" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(within(people).getByRole("button", { name: /^rd\s*1/ }));
    await waitFor(() => expect(requests.at(-1)?.get("sender")).toBe(HUMAN));
    await waitFor(() => expect(screen.queryByText("today.md")).toBeNull());
    expect(screen.getByText("mine.md")).toBeTruthy();
    // 范围筛选时的计数不报给入口角标
    expect(onCounts).toHaveBeenLastCalledWith(expect.objectContaining({ all: 3 }));

    await user.click(within(people).getByRole("button", { name: "所有人" }));
    const times = screen.getByRole("group", { name: "按时间筛选" });
    await user.click(within(times).getByRole("button", { name: "最近 30 天" }));
    await waitFor(() => expect(requests.at(-1)?.get("since")).toBeTruthy());
    await waitFor(() => expect(screen.queryByText("ancient.md")).toBeNull());
    expect(screen.getByText("today.md")).toBeTruthy();

    // 顶上的范围标签一键清除
    await user.click(screen.getByRole("button", { name: /清除发送者和时间筛选/ }));
    expect(await screen.findByText("ancient.md")).toBeTruthy();
  });

  it("shows a friendly empty state", async () => {
    render(panel());
    expect(await screen.findByText(/这个房间还没有图片或文件/)).toBeTruthy();
  });

  it("flips through every image in the grid with the arrow keys, loading more at the end", async () => {
    const user = userEvent.setup();
    store = Array.from({ length: 45 }, (_, index) => item(`shot-${index + 1}.png`));
    const onLocate = vi.fn();
    render(panel({ onLocate }));
    const types = screen.getByRole("group", { name: "按类型筛选" });
    await user.click(await within(types).findByRole("button", { name: /^图片/ }));
    const grid = await screen.findByRole("list", { name: "图片" });
    await waitFor(() => expect(within(grid).getAllByRole("listitem")).toHaveLength(40));

    // 点一下选中看详情，再点一下打开看图器
    const tile = within(grid).getByRole("button", { name: /查看图片 shot-39\.png/ });
    await user.click(tile);
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("complementary", { name: "shot-39.png 的详情" })).toBeTruthy();
    await user.click(tile);
    const viewer = await screen.findByRole("dialog", { name: "shot-39.png" });
    // 翻到网格末尾附近时自动取下一页，计数跟着变
    await waitFor(() => expect(within(viewer).getByText("39 / 45")).toBeTruthy());
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(await screen.findByRole("dialog", { name: "shot-41.png" })).toBeTruthy();
    // 详情栏跟着翻
    expect(screen.getByRole("complementary", { name: "shot-41.png 的详情" })).toBeTruthy();

    await user.click(
      within(screen.getByRole("dialog", { name: "shot-41.png" })).getByRole("button", {
        name: "定位到消息",
      }),
    );
    expect(onLocate).toHaveBeenCalledWith(expect.objectContaining({ name: "shot-41.png" }));
    expect(screen.queryByRole("dialog", { name: /shot-/ })).toBeNull();
  });

  it("moves the selection with the arrow keys after clicking an item, without opening the viewer", async () => {
    const user = userEvent.setup();
    store = [item("a.png"), item("b.png"), item("c.png"), item("one.md"), item("two.md")];
    render(panel());
    // 网格：点一下选中，→ ← 换着看，详情栏跟着变
    const first = await screen.findByRole("button", { name: /查看图片 a\.png/ });
    await user.click(first);
    expect(screen.getByRole("complementary", { name: "a.png 的详情" })).toBeTruthy();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("complementary", { name: "b.png 的详情" })).toBeTruthy();
    expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
    await user.keyboard("{ArrowRight}{ArrowLeft}");
    expect(screen.getByRole("complementary", { name: "b.png 的详情" })).toBeTruthy();
    // 只换选中，不打开看图器
    expect(screen.queryByRole("dialog", { name: "b.png" })).toBeNull();
    // 表格：↓ ↑ 上下一行，到头就停
    await user.click(screen.getByRole("button", { name: /^one\.md，/ }));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("complementary", { name: "two.md 的详情" })).toBeTruthy();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("complementary", { name: "two.md 的详情" })).toBeTruthy();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("complementary", { name: "one.md 的详情" })).toBeTruthy();
    // 搜索框里的方向键照常移动光标，不换选中
    await user.click(screen.getByRole("searchbox", { name: "按文件名搜索产物" }));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("complementary", { name: "one.md 的详情" })).toBeTruthy();
  });

  it("switches images between grid and list, remembering the choice", async () => {
    const user = userEvent.setup();
    store = [item("chart.png"), item("report.md")];
    const { unmount } = render(panel());
    expect(await screen.findByRole("button", { name: /查看图片 chart\.png/ })).toBeTruthy();
    const toggle = screen.getByRole("group", { name: "图片显示方式" });
    await user.click(within(toggle).getByRole("button", { name: "列表" }));
    // 列表视图：图片和文件合成一张表
    const table = await screen.findByRole("table", { name: "全部" });
    expect(within(table).getByText("chart.png")).toBeTruthy();
    expect(within(table).getByText("report.md")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /查看图片/ })).toBeNull();
    expect(localStorage.getItem("superhive.artifacts-view")).toBe("list");
    unmount();
    render(panel());
    expect(await screen.findByRole("table", { name: "全部" })).toBeTruthy();
  });

  it("shows details with versions, locates any version and closes with Escape", async () => {
    const user = userEvent.setup();
    const old = item("plan.md", {
      size: 1024,
      createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    });
    store = [item("plan.md", { versions: [old] })];
    const onLocate = vi.fn();
    const onClose = vi.fn();
    render(panel({ onLocate, onClose }));
    await user.click(await screen.findByRole("button", { name: /^plan\.md，/ }));
    const detail = screen.getByRole("complementary", { name: "plan.md 的详情" });
    expect(within(detail).getByText("2.0 KB")).toBeTruthy();
    expect(within(detail).getByRole("button", { name: "预览" })).toBeTruthy();
    const history = within(detail).getByRole("list", { name: "plan.md 的历史版本" });
    expect(history.textContent).toContain("3 小时前");
    // 选中旧版本：信息换成那一版
    await user.click(within(history).getByRole("button", { name: /3 小时前/ }));
    expect(within(detail).getByText("1.0 KB")).toBeTruthy();
    await user.click(
      within(history).getAllByRole("button", { name: "定位到 plan.md 所在的消息" })[1]!,
    );
    expect(onLocate).toHaveBeenCalledWith(expect.objectContaining({ id: old.id }));

    // Esc 先关详情栏，再按才关面板
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: /的详情/ })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // 焦点回到选中的那一行
    expect(document.activeElement?.textContent).toContain("plan.md");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Office 文档在详情栏里直接预览，点「预览」打开大窗口", async () => {
    const user = userEvent.setup();
    const book = utils.book_new();
    utils.book_append_sheet(
      book,
      utils.aoa_to_sheet([
        ["门店", "销量"],
        ["静安店", 42],
      ]),
      "明细",
    );
    const xlsx = write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/rooms/general/attachments"))
          return new Response(JSON.stringify(serve(url)), {
            headers: { "Content-Type": "application/json" },
          });
        return new Response(xlsx);
      }),
    );
    store = [
      item("sales.xlsx", { kind: "file", mime: "application/octet-stream", category: "data" }),
      item("huge.docx", {
        kind: "file",
        mime: "application/octet-stream",
        size: 30 * 1024 * 1024,
      }),
    ];
    render(panel());
    await user.click(await screen.findByRole("button", { name: /^sales\.xlsx，/ }));
    const detail = screen.getByRole("complementary", { name: "sales.xlsx 的详情" });
    const table = await within(detail).findByRole("table", { name: "明细" }, { timeout: 5000 });
    expect(table.textContent).toContain("静安店");
    await user.click(within(detail).getByRole("button", { name: "预览" }));
    const dialog = await screen.findByRole("dialog", { name: "预览 sales.xlsx" });
    expect(
      (await within(dialog).findByRole("table", { name: "明细" }, { timeout: 5000 })).textContent,
    ).toContain("42");
    await user.keyboard("{Escape}");

    // 太大的不在详情栏里自动下载解析，照旧显示图标，「预览」仍可用
    await user.click(screen.getByRole("button", { name: /^huge\.docx，/ }));
    const big = screen.getByRole("complementary", { name: "huge.docx 的详情" });
    expect(big.querySelector(".office-preview")).toBeNull();
    expect(within(big).getByRole("button", { name: "预览" })).toBeTruthy();
  });

  it("记住了在右侧栏看时，打开文件直接交给 onDock，不再弹窗", async () => {
    const user = userEvent.setup();
    localStorage.setItem("superhive.preview-docked", "1");
    store = [item("report.md")];
    const onDock = vi.fn();
    render(panel({ onDock }));
    await user.dblClick(await screen.findByRole("button", { name: /^report\.md，/ }));
    expect(onDock).toHaveBeenCalledWith(expect.objectContaining({ name: "report.md" }));
    expect(screen.queryByRole("dialog", { name: "预览 report.md" })).toBeNull();
  });

  it("opens maximized and restores to a side drawer, remembered under its own key", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(panel({ onClose }));
    const dialog = screen.getByRole("dialog", { name: "产物" });
    expect(dialog.classList.contains("maximized")).toBe(true);
    await user.click(screen.getByRole("button", { name: "还原为侧边面板" }));
    expect(dialog.classList.contains("maximized")).toBe(false);
    expect(localStorage.getItem("superhive.artifacts-maximized")).toBe("false");
    expect(localStorage.getItem("superhive.workspace-maximized")).toBeNull();
    await user.click(screen.getByRole("button", { name: "关闭产物面板" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("refreshes in place when a new attachment or a recall bumps the epoch", async () => {
    store = [item("first.md")];
    const { rerender } = render(panel());
    expect(await screen.findByText("first.md")).toBeTruthy();
    store = [item("second.md"), ...store];
    rerender(panel({ epoch: 1 }));
    expect(await screen.findByText("second.md")).toBeTruthy();
    // 撤回：服务端不再返回
    store = store.slice(0, 1);
    rerender(panel({ epoch: 2 }));
    await waitFor(() => expect(screen.queryByText("first.md")).toBeNull());
    expect(screen.getByText("second.md")).toBeTruthy();
  });

  it("explains errors instead of showing an empty list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 403 })),
    );
    await act(async () => {
      render(panel());
    });
    expect((await screen.findByRole("alert")).textContent).toBe("没有权限查看这个房间的产物");
  });
});
