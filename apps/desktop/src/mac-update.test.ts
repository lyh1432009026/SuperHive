import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appBundlePath,
  BUNDLE_ID,
  createMacUpdater,
  downloadVerified,
  extractAndVerify,
  locationProblem,
  stagedPathFor,
  SWAP_SCRIPT,
  defaultExec,
  type DownloadFetch,
} from "./mac-update.js";
import { InstallError } from "./update-install.js";

const isMac = process.platform === "darwin";
let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mac-update-"));
  dirs.push(dir);
  return dir;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function fetchBytes(bytes: Uint8Array, status = 200): DownloadFetch {
  return async () => ({
    ok: status === 200,
    status,
    headers: { get: () => null },
    body: streamOf([bytes.subarray(0, 3), bytes.subarray(3)]),
  });
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** 造一个最小的 .app：Info.plist + 可执行文件 */
function fakeApp(parent: string, version: string, bundleId = BUNDLE_ID): string {
  const app = path.join(parent, "SuperHive.app");
  mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  writeFileSync(
    path.join(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>SuperHive</string>
</dict></plist>`,
  );
  writeFileSync(path.join(app, "Contents/MacOS/SuperHive"), `#!/bin/sh\necho ${version}\n`, {
    mode: 0o755,
  });
  // 和正式包一样整体 ad-hoc 签名：更新时会核对签名
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app]);
  return app;
}

function zipApp(app: string, zip: string): Uint8Array {
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
  return readFileSync(zip);
}

describe("appBundlePath / locationProblem", () => {
  it("从可执行文件往上找到 .app", () => {
    expect(appBundlePath("/Applications/SuperHive.app/Contents/MacOS/SuperHive")).toBe(
      "/Applications/SuperHive.app",
    );
    expect(appBundlePath("/Users/me/dev/electron/dist/Electron")).toBeUndefined();
  });

  it("App Translocation、只读卷、没权限都不能原地替换", () => {
    const ok = () => undefined;
    const fail = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(locationProblem("/Applications/SuperHive.app", ok)).toBeUndefined();
    expect(locationProblem(undefined, ok)).toBe("not-installed");
    expect(
      locationProblem("/private/var/folders/x/T/AppTranslocation/ABC/d/SuperHive.app", ok),
    ).toBe("translocated");
    expect(locationProblem("/Volumes/SuperHive/SuperHive.app", fail("EROFS"))).toBe("read-only");
    expect(locationProblem("/Applications/SuperHive.app", fail("EACCES"))).toBe("not-writable");
  });

  it("暂存目录在 .app 旁边，不以 .app 结尾", () => {
    expect(stagedPathFor("/Applications/SuperHive.app", "0.4.8")).toBe(
      "/Applications/.SuperHive-update-0.4.8",
    );
  });
});

describe("downloadVerified", () => {
  const bytes = new TextEncoder().encode("hello superhive");

  it("大小和 sha256 都对上才算下好，进度一路报上来", async () => {
    const dest = path.join(tempDir(), "a.zip");
    const progress = vi.fn();
    await downloadVerified(
      fetchBytes(bytes),
      "u",
      dest,
      { size: bytes.length, sha256: sha256(bytes) },
      progress,
    );
    expect(readFileSync(dest)).toEqual(Buffer.from(bytes));
    expect(progress).toHaveBeenLastCalledWith(bytes.length, bytes.length);
  });

  it("sha256 不对、比说好的大，都按校验失败", async () => {
    const dest = path.join(tempDir(), "a.zip");
    await expect(
      downloadVerified(
        fetchBytes(bytes),
        "u",
        dest,
        { size: bytes.length, sha256: "0".repeat(64) },
        () => undefined,
      ),
    ).rejects.toMatchObject({ reason: "checksum" });
    await expect(
      downloadVerified(
        fetchBytes(bytes),
        "u",
        dest,
        { size: 4, sha256: sha256(bytes) },
        () => undefined,
      ),
    ).rejects.toMatchObject({ reason: "checksum" });
  });

  it("HTTP 出错、请求抛错都按网络问题", async () => {
    const dest = path.join(tempDir(), "a.zip");
    const expected = { size: bytes.length, sha256: sha256(bytes) };
    await expect(
      downloadVerified(fetchBytes(bytes, 404), "u", dest, expected, () => undefined),
    ).rejects.toMatchObject({ reason: "network" });
    await expect(
      downloadVerified(
        async () => {
          throw new Error("offline");
        },
        "u",
        dest,
        expected,
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(InstallError);
  });
});

describe.runIf(isMac)("extractAndVerify（真的用 ditto / plutil / xattr）", () => {
  it("解出唯一的 .app，核对版本和 Bundle ID，并清掉 quarantine", async () => {
    const root = tempDir();
    const app = fakeApp(path.join(root, "src"), "0.4.8");
    execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;0;Test;", app]);
    zipApp(app, path.join(root, "u.zip"));
    const out = path.join(root, "out");
    mkdirSync(out);
    const extracted = await extractAndVerify(defaultExec, path.join(root, "u.zip"), out, "0.4.8");
    expect(extracted).toBe(path.join(out, "SuperHive.app"));
    const left = execFileSync("/usr/bin/find", [
      extracted,
      "-xattrname",
      "com.apple.quarantine",
    ]).toString();
    expect(left).toBe("");
  });

  it("版本号或 Bundle ID 不对、不是 zip，都按更新包不对", async () => {
    const root = tempDir();
    zipApp(fakeApp(path.join(root, "a"), "0.4.7"), path.join(root, "old.zip"));
    zipApp(fakeApp(path.join(root, "b"), "0.4.8", "com.evil.app"), path.join(root, "evil.zip"));
    writeFileSync(path.join(root, "junk.zip"), "not a zip");
    // 签名后又改了 Info.plist（0.4.7 及以前的包就是这样）：换上去系统不让打开
    const unsigned = fakeApp(path.join(root, "c"), "0.4.8");
    const plist = path.join(unsigned, "Contents/Info.plist");
    writeFileSync(
      plist,
      readFileSync(plist, "utf8").replace("</dict>", "<key>X</key><string>y</string></dict>"),
    );
    zipApp(unsigned, path.join(root, "unsigned.zip"));
    for (const name of ["old.zip", "evil.zip", "junk.zip", "unsigned.zip"]) {
      const out = path.join(root, `out-${name}`);
      mkdirSync(out);
      await expect(
        extractAndVerify(defaultExec, path.join(root, name), out, "0.4.8"),
      ).rejects.toMatchObject({ reason: "bad-package" });
    }
  });
});

describe.runIf(isMac)("createMacUpdater 下载到暂存", () => {
  it("下载、校验、解压后暂存到 .app 旁边；退出时把参数交给替换脚本", async () => {
    const root = tempDir();
    const installed = fakeApp(path.join(root, "Applications"), "0.4.7");
    const zipBytes = zipApp(fakeApp(path.join(root, "build"), "0.4.8"), path.join(root, "u.zip"));
    const spawnSwap = vi.fn();
    const quit = vi.fn();
    const backend = createMacUpdater({
      exePath: path.join(installed, "Contents/MacOS/SuperHive"),
      pid: 4242,
      workDir: path.join(root, "work"),
      logFile: path.join(root, "install.log"),
      fetch: fetchBytes(zipBytes),
      quit,
      spawnSwap,
    });
    expect(backend.unavailableReason()).toBeUndefined();
    const hooks = { progress: vi.fn(), verifying: vi.fn() };
    await backend.prepare(
      {
        kind: "mac-zip",
        version: "0.4.8",
        url: "https://github.com/wangrongding/SuperHive/releases/download/v0.4.8/x.zip",
        size: zipBytes.length,
        sha256: sha256(zipBytes),
      },
      hooks,
    );
    expect(hooks.verifying).toHaveBeenCalled();
    const staged = stagedPathFor(installed, "0.4.8");
    expect(existsSync(path.join(staged, "Contents/Info.plist"))).toBe(true);
    // 下载的临时文件不留
    expect(existsSync(path.join(root, "work/0.4.8"))).toBe(false);

    backend.restartNow();
    expect(quit).toHaveBeenCalled();
    backend.applyOnQuit();
    backend.applyOnQuit();
    expect(spawnSwap).toHaveBeenCalledTimes(1);
    expect(spawnSwap).toHaveBeenCalledWith(
      ["4242", installed, staged, "1"],
      path.join(root, "install.log"),
    );

    // 启动清理：删掉没换上的暂存目录，不碰 .app 本身
    backend.cleanup?.();
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(installed)).toBe(true);
  });

  it("校验失败时不留暂存目录，已安装的不动", async () => {
    const root = tempDir();
    const installed = fakeApp(path.join(root, "Applications"), "0.4.7");
    const zipBytes = zipApp(fakeApp(path.join(root, "build"), "0.4.8"), path.join(root, "u.zip"));
    const backend = createMacUpdater({
      exePath: path.join(installed, "Contents/MacOS/SuperHive"),
      pid: 1,
      workDir: path.join(root, "work"),
      logFile: path.join(root, "install.log"),
      fetch: fetchBytes(zipBytes),
      quit: () => undefined,
      spawnSwap: vi.fn(),
    });
    await expect(
      backend.prepare(
        {
          kind: "mac-zip",
          version: "0.4.8",
          url: "u",
          size: zipBytes.length,
          sha256: "0".repeat(64),
        },
        { progress: () => undefined, verifying: () => undefined },
      ),
    ).rejects.toMatchObject({ reason: "checksum" });
    expect(readdirSync(path.join(root, "Applications"))).toEqual(["SuperHive.app"]);
    backend.applyOnQuit();
  });
});

describe.runIf(process.platform !== "win32")("SWAP_SCRIPT（真的跑 /bin/sh）", () => {
  function runSwap(args: string[]): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn("/bin/sh", ["-c", SWAP_SCRIPT, "superhive-update", ...args]);
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("close", (code) => resolve({ code, output }));
    });
  }

  it("等主进程退出后换上新版本，删掉旧的", async () => {
    const root = tempDir();
    const app = path.join(root, "SuperHive.app");
    const staged = path.join(root, ".SuperHive-update-0.4.8");
    mkdirSync(app);
    writeFileSync(path.join(app, "v"), "old");
    mkdirSync(staged);
    writeFileSync(path.join(staged, "v"), "new");
    const sleeper = spawn("/bin/sleep", ["0.5"]);
    const started = Date.now();
    const result = await runSwap([String(sleeper.pid), app, staged, "0"]);
    expect(result).toMatchObject({ code: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(readFileSync(path.join(app, "v"), "utf8")).toBe("new");
    expect(readdirSync(root)).toEqual(["SuperHive.app"]);
  });

  it("新版本挪不进去时把旧的挪回来", async () => {
    const root = tempDir();
    const app = path.join(root, "SuperHive.app");
    mkdirSync(app);
    writeFileSync(path.join(app, "v"), "old");
    // 暂存目录放在没有写权限的目录里：挪出来会失败
    const locked = path.join(root, "locked");
    const staged = path.join(locked, "staged");
    mkdirSync(staged, { recursive: true });
    chmodSync(locked, 0o555);
    try {
      const result = await runSwap(["999999", app, staged, "0"]);
      expect(result.code).toBe(6);
      expect(readFileSync(path.join(app, "v"), "utf8")).toBe("old");
      expect(readdirSync(root).sort()).toEqual(["SuperHive.app", "locked"]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("暂存的新版本不见了就什么都不动", async () => {
    const root = tempDir();
    const app = path.join(root, "SuperHive.app");
    mkdirSync(app);
    writeFileSync(path.join(app, "v"), "old");
    const result = await runSwap(["999999", app, path.join(root, "missing"), "0"]);
    expect(result.code).toBe(4);
    expect(readFileSync(path.join(app, "v"), "utf8")).toBe("old");
  });

  it("参数不全直接退出", async () => {
    expect((await runSwap(["", "", "", "0"])).code).toBe(2);
  });
});
