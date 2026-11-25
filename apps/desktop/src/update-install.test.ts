import { describe, expect, it, vi } from "vitest";
import type { InstallPackage } from "./update-check.js";
import {
  InstallError,
  UpdateInstaller,
  type InstallBackend,
  type InstallFailure,
} from "./update-install.js";

const pkg = (version = "0.4.8"): InstallPackage => ({
  kind: "mac-zip",
  version,
  url: `https://github.com/wangrongding/SuperHive/releases/download/v${version}/x.zip`,
  size: 1000,
  sha256: "a".repeat(64),
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(reason?: InstallFailure) {
  const pending: ReturnType<typeof deferred>[] = [];
  let hooks: Parameters<InstallBackend["prepare"]>[1] | undefined;
  const backend = {
    unavailableReason: vi.fn(() => reason),
    prepare: vi.fn((_pkg: InstallPackage, h: Parameters<InstallBackend["prepare"]>[1]) => {
      hooks = h;
      const next = deferred();
      pending.push(next);
      return next.promise;
    }),
    restartNow: vi.fn(),
    applyOnQuit: vi.fn(),
    cleanup: vi.fn(),
  } satisfies InstallBackend;
  let now = 0;
  const onChange = vi.fn();
  const installer = new UpdateInstaller({ backend, onChange, now: () => now });
  return {
    backend,
    installer,
    onChange,
    pending,
    hooks: () => hooks!,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("UpdateInstaller", () => {
  it("能直接更新时空闲状态可用，并带上下载大小", () => {
    const { installer } = setup();
    expect(installer.view("0.4.8", pkg())).toEqual({
      available: true,
      size: 1000,
      state: { phase: "idle" },
    });
  });

  it("不能直接更新时说明原因：没有后端、Release 没传包、位置不能写", () => {
    expect(
      new UpdateInstaller({ backend: undefined, onChange: () => undefined }).view("0.4.8", pkg()),
    ).toMatchObject({ available: false, reason: "not-installed" });
    expect(setup().installer.view("0.4.8", undefined)).toMatchObject({
      available: false,
      reason: "no-package",
      size: 0,
    });
    expect(setup("translocated").installer.view("0.4.8", pkg())).toMatchObject({
      available: false,
      reason: "translocated",
    });
    const blocked = setup("read-only");
    expect(blocked.installer.start(pkg())).toBe(false);
    expect(blocked.backend.prepare).not.toHaveBeenCalled();
  });

  it("下载 → 校验 → 就绪，进度节流，重复点不会再下一次", async () => {
    const { installer, backend, onChange, pending, hooks, tick } = setup();
    expect(installer.start(pkg())).toBe(true);
    expect(installer.start(pkg())).toBe(false);
    expect(backend.prepare).toHaveBeenCalledTimes(1);
    expect(installer.view("0.4.8", pkg()).state).toEqual({
      phase: "downloading",
      received: 0,
      total: 1000,
    });
    const calls = onChange.mock.calls.length;
    tick(300);
    hooks().progress(100, 1000);
    hooks().progress(200, 1000); // 250ms 内的不推
    expect(onChange.mock.calls.length).toBe(calls + 1);
    hooks().progress(1000, 1000); // 下完的那一下总是推
    expect(onChange.mock.calls.length).toBe(calls + 2);
    expect(installer.view("0.4.8", pkg()).state).toMatchObject({ received: 1000 });
    hooks().verifying();
    expect(installer.phase).toBe("verifying");
    pending[0]!.resolve();
    await flush();
    expect(installer.view("0.4.8", pkg()).state).toEqual({ phase: "ready" });
    expect(installer.start(pkg())).toBe(false);
  });

  it("失败时记下原因，可以重试；别的异常按 unknown", async () => {
    const { installer, backend, pending } = setup();
    installer.start(pkg());
    pending[0]!.reject(new InstallError("checksum"));
    await flush();
    expect(installer.view("0.4.8", pkg()).state).toEqual({ phase: "failed", reason: "checksum" });
    expect(installer.start(pkg())).toBe(true);
    pending[1]!.reject(new Error("boom"));
    await flush();
    expect(installer.view("0.4.8", pkg()).state).toEqual({ phase: "failed", reason: "unknown" });
    expect(backend.prepare).toHaveBeenCalledTimes(2);
  });

  it("出了更新的版本：旧版本的状态不再显示", async () => {
    const { installer, pending } = setup();
    installer.start(pkg("0.4.8"));
    pending[0]!.reject(new InstallError("network"));
    await flush();
    expect(installer.view("0.4.9", pkg("0.4.9")).state).toEqual({ phase: "idle" });
    expect(installer.start(pkg("0.4.9"))).toBe(true);
  });

  it("就绪后才能重启；退出时只有就绪才让更新生效", async () => {
    const { installer, backend, pending } = setup();
    expect(installer.restart()).toBe(false);
    installer.onQuit();
    expect(backend.applyOnQuit).not.toHaveBeenCalled();
    installer.start(pkg());
    installer.onQuit();
    expect(backend.applyOnQuit).not.toHaveBeenCalled();
    pending[0]!.resolve();
    await flush();
    expect(installer.restart()).toBe(true);
    expect(backend.restartNow).toHaveBeenCalledTimes(1);
    installer.onQuit();
    expect(backend.applyOnQuit).toHaveBeenCalledTimes(1);
  });

  it("就绪后位置出了问题也照实显示已就绪", async () => {
    const { installer, backend, pending } = setup();
    installer.start(pkg());
    pending[0]!.resolve();
    await flush();
    backend.unavailableReason.mockReturnValue("not-writable");
    expect(installer.view("0.4.8", pkg()).state).toEqual({ phase: "ready" });
  });

  it("启动清理只在空闲时做，出错也不抛", () => {
    const { installer, backend } = setup();
    backend.cleanup.mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(() => installer.cleanup()).not.toThrow();
    installer.start(pkg());
    installer.cleanup();
    expect(backend.cleanup).toHaveBeenCalledTimes(1);
  });
});
