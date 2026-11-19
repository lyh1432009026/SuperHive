// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxBadge } from "./sandbox-badge";

function serve(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("SandboxBadge", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.title = "";
  });

  it("沙箱 Server 上在顶部标出「沙箱预览」并给标题加前缀，卸载后还原", async () => {
    const fetchMock = serve({ status: "ok", sandbox: true });
    document.title = "SuperHive";
    const view = render(<SandboxBadge base="http://127.0.0.1:4321" />);
    expect(await screen.findByText("沙箱预览")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4321/health", { cache: "no-store" });
    expect(document.title).toBe("[沙箱] SuperHive");
    expect(document.documentElement.dataset.sandbox).toBe("true");
    view.unmount();
    expect(document.title).toBe("SuperHive");
    expect(document.documentElement.dataset.sandbox).toBeUndefined();
  });

  it("正常 Server 或连不上时什么都不显示", async () => {
    const fetchMock = serve({ status: "ok" });
    const { container } = render(<SandboxBadge base="" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe("");
    cleanup();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const offline = render(<SandboxBadge base="" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(offline.container.innerHTML).toBe("");
  });
});
