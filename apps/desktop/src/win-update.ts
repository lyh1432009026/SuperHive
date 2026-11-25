/**
 * Windows 应用内更新：Electron 自带的 autoUpdater（Squirrel.Windows），不需要签名。
 *
 * - feed 是新版 Release 自己的下载目录 `https://github.com/<本仓库>/releases/download/<tag>`，
 *   Update.exe 读那里的 `RELEASES`，再下载同目录的 `SuperHive-<版本>-full.nupkg`，按 RELEASES 里的 sha1 校验，
 *   解到 `%LOCALAPPDATA%\SuperHive\app-<新版本>`。不依赖第三方更新服务，地址也在本仓库 Release 白名单里。
 * - 下载在 Update.exe 里做，没有进度事件，网页只显示「正在后台下载」。
 * - 下好以后：点「重启以更新」调 quitAndInstall()；不点的话，下次从开始菜单 / 桌面快捷方式打开就是新版本
 *   （快捷方式指向 Squirrel 的启动壳，它总是运行最新的 app-x.y.z）。
 * - 不是用安装包装的（开发版、解压版，旁边没有 Update.exe）时不可用，退回打开下载页。
 */
import { existsSync } from "node:fs";
import type { InstallPackage } from "./update-check.js";
import { updateExePath } from "./squirrel.js";
import { InstallError, type InstallBackend } from "./update-install.js";

/** 用到的 Electron autoUpdater 的那一部分（测试里换成假的） */
export interface SquirrelUpdater {
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "update-available" | "update-not-available" | "update-downloaded",
    listener: (...args: unknown[]) => void,
  ): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export type WindowsUpdaterOptions = {
  execPath: string;
  updater: () => SquirrelUpdater;
  exists?: (file: string) => boolean;
};

export function createWindowsUpdater(options: WindowsUpdaterOptions): InstallBackend {
  const exists = options.exists ?? existsSync;
  const installed = () => exists(updateExePath(options.execPath));
  let guarded = false;
  const updater = () => {
    const value = options.updater();
    // EventEmitter 的 error 事件没人听会直接抛出、弄崩主进程；下载流程外的错误只是忽略
    if (!guarded) {
      guarded = true;
      value.on("error", () => undefined);
    }
    return value;
  };

  return {
    unavailableReason: () => (installed() ? undefined : "not-installed"),

    prepare(pkg: InstallPackage, hooks) {
      if (pkg.kind !== "squirrel") return Promise.reject(new InstallError("no-package"));
      if (!installed()) return Promise.reject(new InstallError("not-installed"));
      const squirrel = updater();
      return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          squirrel.removeListener("error", onError);
          squirrel.removeListener("update-not-available", onNotAvailable);
          squirrel.removeListener("update-downloaded", onDownloaded);
        };
        const onError = (error: unknown) => {
          cleanup();
          reject(
            new InstallError("network", error instanceof Error ? error.message : String(error)),
          );
        };
        // feed 里的 RELEASES 没有比当前新的包：Release 传错了文件
        const onNotAvailable = () => {
          cleanup();
          reject(new InstallError("bad-package", "update-not-available"));
        };
        const onDownloaded = () => {
          cleanup();
          hooks.verifying();
          resolve();
        };
        squirrel.on("error", onError);
        squirrel.on("update-not-available", onNotAvailable);
        squirrel.on("update-downloaded", onDownloaded);
        try {
          squirrel.setFeedURL({ url: pkg.feedUrl });
          squirrel.checkForUpdates();
        } catch (error) {
          cleanup();
          reject(new InstallError("unknown", String(error)));
        }
      });
    },

    restartNow() {
      // 先启动 Update.exe --processStartAndWait（等本进程退出再打开新版本），再走正常的退出流程
      updater().quitAndInstall();
    },

    applyOnQuit() {
      // 不用做什么：下次打开时 Squirrel 的启动壳直接运行最新的 app-x.y.z
    },
  };
}
