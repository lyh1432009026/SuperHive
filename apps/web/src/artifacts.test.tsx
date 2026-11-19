// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, ArtifactCounts, ArtifactsResponse } from "@superhive/protocol";
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
  const matched = store.filter(
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
    counts: counts(store),
  };
}

beforeEach(() => {
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
    {...props}
  />
);

describe("ArtifactsPanel", () => {
  it("shows latest images above the file list, filters by type and searches by name", async () => {
    const user = userEvent.setup();
    store = [item("chart.png"), item("report.md"), item("main.ts"), item("notes.txt")];
    const onCounts = vi.fn();
    render(panel({ onCounts }));

    expect(await screen.findByRole("button", { name: /查看图片 chart\.png/ })).toBeTruthy();
    const files = await screen.findByRole("list", { name: "文件" });
    expect(
      within(files)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining("report.md"),
      expect.stringContaining("main.ts"),
      expect.stringContaining("notes.txt"),
    ]);
    expect(onCounts).toHaveBeenCalledWith(expect.objectContaining({ all: 4, image: 1 }));
    expect(screen.getByRole("button", { name: /全部\s*4/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    // 「文件」下再按细分类型筛
    await user.click(screen.getByRole("button", { name: /^文件\s*3/ }));
    await user.click(await screen.findByRole("button", { name: /^代码\s*1/ }));
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "代码" }).textContent).toContain("main.ts"),
    );
    expect(screen.queryByText("report.md")).toBeNull();

    await user.click(screen.getByRole("button", { name: /^全部/ }));
    await user.type(screen.getByRole("searchbox", { name: "按文件名搜索产物" }), "NOTES");
    await waitFor(() => expect(requests.at(-1)?.get("q")).toBe("NOTES"));
    await waitFor(() => expect(screen.queryByText("report.md")).toBeNull());
    expect(screen.getByText("notes.txt")).toBeTruthy();

    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "zzz");
    expect(await screen.findByText("没有文件名包含「zzz」的产物")).toBeTruthy();
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
    await user.click(await screen.findByRole("button", { name: /^图片/ }));
    const grid = await screen.findByRole("list", { name: "图片" });
    await waitFor(() => expect(within(grid).getAllByRole("listitem")).toHaveLength(40));

    await user.click(within(grid).getByRole("button", { name: /查看图片 shot-39\.png/ }));
    const viewer = await screen.findByRole("dialog", { name: "shot-39.png" });
    // 翻到网格末尾附近时自动取下一页，计数跟着变
    await waitFor(() => expect(within(viewer).getByText("39 / 45")).toBeTruthy());
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(await screen.findByRole("dialog", { name: "shot-41.png" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "定位到消息" }));
    expect(onLocate).toHaveBeenCalledWith(expect.objectContaining({ name: "shot-41.png" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("groups versions under the latest file and locates the message of any version", async () => {
    const user = userEvent.setup();
    const old = item("plan.md", { createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() });
    store = [item("plan.md", { versions: [old] })];
    const onLocate = vi.fn();
    render(panel({ onLocate }));
    const toggle = await screen.findByRole("button", { name: "另有 1 个历史版本" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    const history = screen.getByRole("list", { name: "plan.md 的历史版本" });
    expect(history.textContent).toContain("3 小时前");
    await user.click(within(history).getByRole("button", { name: "定位到 plan.md 所在的消息" }));
    expect(onLocate).toHaveBeenCalledWith(expect.objectContaining({ id: old.id }));
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
