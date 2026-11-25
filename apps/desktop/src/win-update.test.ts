import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { InstallPackage } from "./update-check.js";
import { InstallError } from "./update-install.js";
import { createWindowsUpdater, type SquirrelUpdater } from "./win-update.js";

const EXEC = "C:\\Users\\me\\AppData\\Local\\SuperHive\\app-0.4.7\\SuperHive.exe";
const UPDATE_EXE = "C:\\Users\\me\\AppData\\Local\\SuperHive\\Update.exe";
const FEED = "https://github.com/wangrongding/SuperHive/releases/download/v0.4.8";
const squirrelPkg: InstallPackage = { kind: "squirrel", version: "0.4.8", feedUrl: FEED, size: 9 };

class FakeUpdater extends EventEmitter implements SquirrelUpdater {
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn();
  quitAndInstall = vi.fn();
}

function setup(installed = true) {
  const updater = new FakeUpdater();
  const exists = vi.fn((file: string) => installed && file === UPDATE_EXE);
  const backend = createWindowsUpdater({ execPath: EXEC, updater: () => updater, exists });
  const hooks = { progress: vi.fn(), verifying: vi.fn() };
  return { updater, backend, hooks, exists };
}

describe("createWindowsUpdater", () => {
  it("不是用安装包装的（旁边没有 Update.exe）时不可用", async () => {
    const { backend, hooks, updater } = setup(false);
    expect(backend.unavailableReason()).toBe("not-installed");
    await expect(backend.prepare(squirrelPkg, hooks)).rejects.toMatchObject({
      reason: "not-installed",
    });
    expect(updater.setFeedURL).not.toHaveBeenCalled();
  });

  it("feed 设成 Release 的下载目录，下好后就绪并解绑事件", async () => {
    const { backend, hooks, updater } = setup();
    expect(backend.unavailableReason()).toBeUndefined();
    const done = backend.prepare(squirrelPkg, hooks);
    expect(updater.setFeedURL).toHaveBeenCalledWith({ url: FEED });
    expect(updater.checkForUpdates).toHaveBeenCalled();
    updater.emit("update-available");
    updater.emit("update-downloaded", {}, "notes", "0.4.8");
    await expect(done).resolves.toBeUndefined();
    expect(hooks.verifying).toHaveBeenCalled();
    // 只剩那个兜底的 error 监听
    expect(updater.listenerCount("error")).toBe(1);
    expect(updater.listenerCount("update-downloaded")).toBe(0);
    expect(() => updater.emit("error", new Error("later"))).not.toThrow();
  });

  it("出错算网络问题；RELEASES 里没有更新的包算更新包不对", async () => {
    const first = setup();
    const failing = first.backend.prepare(squirrelPkg, first.hooks);
    first.updater.emit("error", new Error("404"));
    await expect(failing).rejects.toBeInstanceOf(InstallError);
    await expect(failing).rejects.toMatchObject({ reason: "network" });

    const second = setup();
    const stale = second.backend.prepare(squirrelPkg, second.hooks);
    second.updater.emit("update-not-available");
    await expect(stale).rejects.toMatchObject({ reason: "bad-package" });
  });

  it("setFeedURL 抛错时按 unknown 失败，不会挂住", async () => {
    const { backend, hooks, updater } = setup();
    updater.setFeedURL.mockImplementation(() => {
      throw new Error("bad url");
    });
    await expect(backend.prepare(squirrelPkg, hooks)).rejects.toMatchObject({ reason: "unknown" });
    expect(updater.listenerCount("error")).toBe(1);
  });

  it("不是 Squirrel 的包不接", async () => {
    const { backend, hooks } = setup();
    await expect(
      backend.prepare({ kind: "mac-zip", version: "1.0.0", url: "x", size: 1, sha256: "a" }, hooks),
    ).rejects.toMatchObject({ reason: "no-package" });
  });

  it("重启以更新走 quitAndInstall；正常退出什么都不用做", () => {
    const { backend, updater } = setup();
    backend.applyOnQuit();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    backend.restartNow();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
