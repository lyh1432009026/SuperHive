// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageMarkdown } from "./message-markdown";
import { SplitResizer, useSplitWidth } from "./split-resizer";
import {
  RefResolver,
  RefText,
  WorkspaceRefsContext,
  isRefCandidate,
  type RefTarget,
} from "./workspace-refs";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

const full = "6c28c9a0f1e2d3c4b5a69788796a5b4c3d2e1f00";

function withRefs(ui: ReactNode, known: Record<string, string> = {}) {
  const api = vi.fn(async (_path: string, query: Record<string, string | undefined> = {}) => {
    const tokens = (query.q ?? "").split(",");
    return {
      commits: Object.fromEntries(
        tokens.filter((token) => known[token]).map((token) => [token, known[token]]),
      ),
      branches: tokens.includes("feat/rd-claude2-x") ? { "feat/rd-claude2-x": "wt-1" } : {},
    };
  });
  const open = vi.fn<(target: RefTarget) => void>();
  const resolver = new RefResolver(api);
  render(
    <WorkspaceRefsContext.Provider value={{ resolver, open }}>{ui}</WorkspaceRefsContext.Provider>,
  );
  return { api, open };
}

describe("消息里的提交号与分支名", () => {
  it("候选规则：十六进制要同时有字母和数字，分支名要带常见前缀", () => {
    expect(isRefCandidate("6c28c9a")).toBe(true);
    expect(isRefCandidate("1234567")).toBe(false);
    expect(isRefCandidate("deadbeef")).toBe(false);
    expect(isRefCandidate("feat/rd-claude2-x")).toBe(true);
    expect(isRefCandidate("apps/web")).toBe(false);
  });

  it("服务端确认存在的提交、任务线变成按钮，点了打开代码面板；不存在的照常显示文字", async () => {
    const { api, open } = withRefs(
      <MessageMarkdown
        content={"提交 `6c28c9a`，另见 a1b2c3d4e 和分支 feat/rd-claude2-x，路径 apps/web/src"}
      />,
      { "6c28c9a": full },
    );
    const commit = await screen.findByRole("button", { name: "6c28c9a" });
    expect(commit.querySelector("code")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "a1b2c3d4e" })).toBeNull();
    expect(screen.getByText(/a1b2c3d4e/)).toBeTruthy();
    // 同一批渲染里的候选合成一次请求
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0]![1]!.q!.split(",").sort()).toEqual(
      ["6c28c9a", "a1b2c3d4e", "feat/rd-claude2-x"].sort(),
    );
    await userEvent.click(commit);
    expect(open).toHaveBeenCalledWith({ kind: "commit", hash: full });
    await userEvent.click(screen.getByRole("button", { name: "feat/rd-claude2-x" }));
    expect(open).toHaveBeenCalledWith({ kind: "branch", source: "wt-1" });
  });

  it("不能看代码时（没有上下文）不发请求、不出链接；思考卡片里的不可交互渲染也不出链接", () => {
    render(<MessageMarkdown content="提交 6c28c9a" />);
    expect(screen.queryByRole("button")).toBeNull();
    const { api } = withRefs(<MessageMarkdown inert content="提交 6c28c9a" />, { "6c28c9a": full });
    expect(screen.queryByRole("button", { name: "6c28c9a" })).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });

  it("白板这类纯文字也能识别", async () => {
    withRefs(<RefText text="已提交 6c28c9a（未合入）" />, { "6c28c9a": full });
    expect(await screen.findByRole("button", { name: "6c28c9a" })).toBeTruthy();
    expect(screen.getByText(/已提交/)).toBeTruthy();
  });
});

function Split() {
  const split = useSplitWidth("test-split", 300, 220);
  return (
    <div>
      <SplitResizer width={split.width} min={220} onChange={split.set} label="调整左栏宽度" />
    </div>
  );
}

describe("SplitResizer", () => {
  it("键盘调宽（最宽为容器一半）、记在本机、双击恢复默认", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1000,
    } as DOMRect);
    render(<Split />);
    const handle = screen.getByRole("separator", { name: "调整左栏宽度" });
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("316");
    expect(localStorage.getItem("test-split")).toBe("316");
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuenow")).toBe("500");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle.getAttribute("aria-valuenow")).toBe("220");
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    expect(localStorage.getItem("test-split")).toBeNull();
  });
});
