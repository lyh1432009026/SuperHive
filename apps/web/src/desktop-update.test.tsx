// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateInfo, DesktopUpdatesApi } from "./desktop-bridge";
import { DesktopUpdateEntry, noteForLocale } from "./desktop-update";

afterEach(cleanup);

const info: DesktopUpdateInfo = {
  version: "0.4.8",
  currentVersion: "0.4.7",
  publishedAt: "2026-11-30T12:00:00Z",
  notes: ["桌面端会提示新版本 / The desktop app tells you about new versions", "只有中文"],
  assetName: "SuperHive-0.4.8-arm64.dmg",
  assetSize: 129 * 1024 * 1024,
};

function fakeApi(initial: DesktopUpdateInfo | null, withInstall = false) {
  let listener: ((next: DesktopUpdateInfo | null) => void) | undefined;
  const api: DesktopUpdatesApi = {
    get: vi.fn(async () => initial),
    open: vi.fn(async () => true),
    dismiss: vi.fn(async () => true),
    ...(withInstall ? { install: vi.fn(async () => true), restart: vi.fn(async () => true) } : {}),
    onChange: vi.fn((next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    }),
  };
  return { api, push: (next: DesktopUpdateInfo | null) => listener?.(next) };
}

describe("noteForLocale", () => {
  it("按界面语言取中英文的一半，没有分隔就原样", () => {
    expect(noteForLocale("新功能 / New feature", "zh-CN")).toBe("新功能");
    expect(noteForLocale("新功能 / New feature", "en")).toBe("New feature");
    expect(noteForLocale("A / B / C", "en")).toBe("B / C");
    expect(noteForLocale("只有中文", "en")).toBe("只有中文");
  });
});

describe("DesktopUpdateEntry", () => {
  it("不在桌面端或没有新版时什么都不显示", async () => {
    const { container } = render(<DesktopUpdateEntry api={undefined} />);
    expect(container.innerHTML).toBe("");
    const { api } = fakeApi(null);
    const second = render(<DesktopUpdateEntry api={api} />);
    await act(async () => undefined);
    expect(second.container.innerHTML).toBe("");
  });

  it("有新版时显示入口，点开看版本和说明，下载只告诉桌面端打开哪一个", async () => {
    const { api } = fakeApi(info);
    render(<DesktopUpdateEntry api={api} platform="darwin" />);
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
    const dialog = screen.getByRole("dialog", { name: "有新版本 0.4.8" });
    expect(dialog.textContent).toContain("你现在用的是 0.4.7");
    expect(dialog.textContent).toContain("桌面端会提示新版本");
    expect(dialog.textContent).not.toContain("The desktop app");
    expect(dialog.textContent).toContain("拖进「应用程序」");

    fireEvent.click(screen.getByRole("button", { name: "完整发布说明" }));
    expect(api.open).toHaveBeenLastCalledWith("release");
    fireEvent.click(screen.getByRole("button", { name: /^下载/ }));
    expect(api.open).toHaveBeenLastCalledWith("download");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Windows 上提示覆盖安装", async () => {
    const { api } = fakeApi(info);
    render(<DesktopUpdateEntry api={api} platform="win32" />);
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
    expect(screen.getByRole("dialog").textContent).toContain("覆盖安装");
  });

  it("忽略这个版本后入口马上收起，并告诉桌面端", async () => {
    const { api } = fakeApi(info);
    render(<DesktopUpdateEntry api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
    fireEvent.click(screen.getByRole("button", { name: "忽略这个版本" }));
    expect(api.dismiss).toHaveBeenCalledWith("0.4.8");
    expect(screen.queryByRole("button", { name: "有新版本 0.4.8" })).toBeNull();
  });

  it("桌面端后来查到新版时出现，收回时消失", async () => {
    const { api, push } = fakeApi(null);
    render(<DesktopUpdateEntry api={api} />);
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: /有新版本/ })).toBeNull();
    act(() => push({ ...info, version: "0.4.9" }));
    expect(screen.getByRole("button", { name: "有新版本 0.4.9" })).toBeTruthy();
    act(() => push(null));
    expect(screen.queryByRole("button", { name: /有新版本/ })).toBeNull();
  });

  describe("应用内更新", () => {
    const withInstall = (
      install: NonNullable<DesktopUpdateInfo["install"]>,
    ): DesktopUpdateInfo => ({
      ...info,
      install,
    });
    const idle = { phase: "idle" } as const;

    it("能直接更新时主按钮是「下载并更新」，只告诉桌面端版本号", async () => {
      const { api } = fakeApi(
        withInstall({ available: true, size: 120_000_000, state: idle }),
        true,
      );
      render(<DesktopUpdateEntry api={api} platform="darwin" />);
      fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toContain("下次退出时再换");
      fireEvent.click(screen.getByRole("button", { name: /^下载并更新/ }));
      expect(api.install).toHaveBeenCalledWith("0.4.8");
      expect(screen.getByRole("button", { name: /下载并更新.*120 MB/ })).toBeTruthy();
    });

    it("下载中显示进度，入口也显示百分比；不知道大小时（Windows）只说在下载", async () => {
      const { api, push } = fakeApi(
        withInstall({
          available: true,
          size: 200,
          state: { phase: "downloading", received: 50, total: 200 },
        }),
        true,
      );
      render(<DesktopUpdateEntry api={api} platform="darwin" />);
      fireEvent.click(await screen.findByRole("button", { name: "正在下载新版本 25%" }));
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
      const busy = screen.getByRole("button", { name: "下载中 25%" }) as HTMLButtonElement;
      expect(busy.disabled).toBe(true);
      expect(screen.queryByRole("button", { name: "忽略这个版本" })).toBeNull();
      act(() =>
        push(
          withInstall({
            available: true,
            size: 200,
            state: { phase: "downloading", received: 0, total: 0 },
          }),
        ),
      );
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
      expect(screen.getByRole("button", { name: "下载中…" })).toBeTruthy();
      act(() => push(withInstall({ available: true, size: 200, state: { phase: "verifying" } })));
      expect(screen.getByRole("button", { name: "正在校验…" })).toBeTruthy();
    });

    it("下好后「重启以更新」，并说明不重启也会在下次退出时生效", async () => {
      const { api } = fakeApi(
        withInstall({ available: true, size: 200, state: { phase: "ready" } }),
        true,
      );
      render(<DesktopUpdateEntry api={api} platform="darwin" />);
      fireEvent.click(await screen.findByRole("button", { name: "重启以更新到 0.4.8" }));
      const dialog = screen.getByRole("dialog", { name: "新版本 0.4.8 已下载好" });
      expect(dialog.textContent).toContain("下次退出 SuperHive 时自动换上新版本");
      fireEvent.click(screen.getByRole("button", { name: "重启以更新" }));
      expect(api.restart).toHaveBeenCalled();
    });

    it("失败时说明原因，主按钮退回下载安装包，可以重试", async () => {
      const { api } = fakeApi(
        withInstall({ available: true, size: 200, state: { phase: "failed", reason: "checksum" } }),
        true,
      );
      render(<DesktopUpdateEntry api={api} platform="darwin" />);
      fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
      expect(screen.getByRole("status").textContent).toContain("校验不通过");
      expect(screen.getByRole("status").textContent).toContain("当前版本不受影响");
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      expect(api.install).toHaveBeenCalledWith("0.4.8");
      fireEvent.click(screen.getByRole("button", { name: /^下载安装包/ }));
      expect(api.open).toHaveBeenLastCalledWith("download");
    });

    it("位置不能写时只给「下载」，并写明原因；Release 没传更新包时不多说", async () => {
      const { api, push } = fakeApi(
        withInstall({ available: false, reason: "translocated", size: 200, state: idle }),
        true,
      );
      render(<DesktopUpdateEntry api={api} platform="darwin" />);
      fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
      expect(screen.getByRole("status").textContent).toContain("拖进「应用程序」再打开");
      expect(screen.queryByRole("button", { name: /下载并更新/ })).toBeNull();
      expect(screen.getByRole("button", { name: /^下载/ })).toBeTruthy();
      act(() =>
        push(withInstall({ available: false, reason: "no-package", size: 0, state: idle })),
      );
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("老版本桌面端没有 install / restart 时照旧只给「下载」", async () => {
      const { api } = fakeApi(withInstall({ available: true, size: 200, state: idle }));
      render(<DesktopUpdateEntry api={api} platform="darwin" />);
      fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
      expect(screen.queryByRole("button", { name: /下载并更新/ })).toBeNull();
    });
  });
});
