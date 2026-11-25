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

function fakeApi(initial: DesktopUpdateInfo | null) {
  let listener: ((next: DesktopUpdateInfo | null) => void) | undefined;
  const api: DesktopUpdatesApi = {
    get: vi.fn(async () => initial),
    open: vi.fn(async () => true),
    dismiss: vi.fn(async () => true),
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
});
