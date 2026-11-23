import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultShell,
  MAX_TERMINALS_PER_OWNER,
  resolveCwd,
  TerminalManager,
  terminalEnv,
  type PtyProcess,
} from "./terminal-manager.js";

type FakePty = PtyProcess & {
  emitData(data: string): void;
  emitExit(code: number): void;
  writes: string[];
  resizes: Array<[number, number]>;
  killed: boolean;
};

function fakePty(): FakePty {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number }) => void) | undefined;
  const pty: FakePty = {
    pid: 42,
    writes: [],
    resizes: [],
    killed: false,
    onData: (listener) => {
      onData = listener;
      return { dispose: () => (onData = undefined) };
    },
    onExit: (listener) => {
      onExit = listener;
      return { dispose: () => (onExit = undefined) };
    },
    write: (data) => pty.writes.push(data),
    resize: (cols, rows) => pty.resizes.push([cols, rows]),
    kill: () => {
      pty.killed = true;
    },
    emitData: (data) => onData?.(data),
    emitExit: (code) => onExit?.({ exitCode: code }),
  };
  return pty;
}

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function setup() {
  const ptys: FakePty[] = [];
  type SpawnArgs = [
    string,
    string[],
    { cwd: string; cols: number; rows: number; env: Record<string, string> },
  ];
  const spawn = vi.fn<(...args: SpawnArgs) => FakePty>(() => {
    const pty = fakePty();
    ptys.push(pty);
    return pty;
  });
  const sink = { data: vi.fn(), exit: vi.fn() };
  tmp = mkdtempSync(path.join(os.tmpdir(), "terminal-manager-"));
  const manager = new TerminalManager({
    spawn,
    sink,
    env: () => ({
      PATH: "/usr/bin",
      ELECTRON_RUN_AS_NODE: "1",
      HIVE_SHUTDOWN_TOKEN: "secret",
      HOME: "/home/me",
    }),
    shell: () => ({ file: "/bin/zsh", args: ["-l"] }),
    home: () => tmp!,
  });
  return { manager, spawn, sink, ptys, home: tmp };
}

describe("TerminalManager", () => {
  it("spawns a login shell in the requested folder and routes output to the owner", () => {
    const { manager, spawn, sink, ptys, home } = setup();
    const created = manager.create(1, { cwd: home, cols: 120, rows: 30 });
    expect(created.cwd).toBe(home);
    expect(spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-l"],
      expect.objectContaining({ cwd: home, cols: 120, rows: 30 }),
    );
    ptys[0]!.emitData("hi");
    expect(sink.data).toHaveBeenCalledWith(1, created.id, "hi");
  });

  it("only lets the owner write, resize or kill a session", () => {
    const { manager, ptys } = setup();
    const { id } = manager.create(1, {});
    manager.write(2, id, "rm -rf /\r");
    manager.resize(2, id, 10, 10);
    manager.kill(2, id);
    expect(ptys[0]!.writes).toEqual([]);
    expect(ptys[0]!.resizes).toEqual([]);
    expect(ptys[0]!.killed).toBe(false);

    manager.write(1, id, "ls\r");
    manager.resize(1, id, 100.7, 9999);
    expect(ptys[0]!.writes).toEqual(["ls\r"]);
    expect(ptys[0]!.resizes).toEqual([[100, 500]]);
  });

  it("ignores malformed IPC arguments", () => {
    const { manager, ptys } = setup();
    const { id } = manager.create(1, {});
    manager.write(1, { id }, "x");
    manager.write(1, id, 123);
    manager.resize(1, id, "a", null);
    expect(ptys[0]!.writes).toEqual([]);
    expect(ptys[0]!.resizes).toEqual([[80, 24]]);
  });

  it("forgets sessions that exit and reports the exit code", () => {
    const { manager, sink, ptys } = setup();
    const { id } = manager.create(1, {});
    ptys[0]!.emitExit(3);
    expect(sink.exit).toHaveBeenCalledWith(1, id, 3, undefined);
    expect(manager.size).toBe(0);
  });

  it("kills every session of a page when it reloads or closes, and all on quit", () => {
    const { manager, ptys } = setup();
    manager.create(1, {});
    manager.create(1, {});
    manager.create(2, {});
    manager.disposeOwner(1);
    expect(ptys.map((pty) => pty.killed)).toEqual([true, true, false]);
    expect(manager.size).toBe(1);
    manager.disposeAll();
    expect(ptys[2]!.killed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("caps the number of terminals per window", () => {
    const { manager } = setup();
    for (let i = 0; i < MAX_TERMINALS_PER_OWNER; i += 1) manager.create(1, {});
    expect(() => manager.create(1, {})).toThrow(/Too many terminals/);
    expect(() => manager.create(2, {})).not.toThrow();
  });

  it("does not leak Electron or Hive internals into the shell", () => {
    const { manager, spawn } = setup();
    manager.create(1, {});
    const env = spawn.mock.calls[0]![2].env;
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.HIVE_SHUTDOWN_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.TERM).toBe("xterm-256color");
  });
});

describe("resolveCwd", () => {
  it("expands ~, falls back to home for missing or relative paths and files", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "resolve-cwd-"));
    const file = path.join(tmp, "file.txt");
    writeFileSync(file, "x");
    expect(resolveCwd(tmp, "/home/me")).toBe(tmp);
    expect(resolveCwd("~", tmp)).toBe(tmp);
    expect(resolveCwd("~/", tmp)).toBe(tmp);
    expect(resolveCwd(path.join(tmp, "missing"), "/home/me")).toBe("/home/me");
    expect(resolveCwd(file, "/home/me")).toBe("/home/me");
    expect(resolveCwd("relative/dir", "/home/me")).toBe("/home/me");
    expect(resolveCwd(null, "/home/me")).toBe("/home/me");
  });
});

describe("defaultShell / terminalEnv", () => {
  it("uses the user's login shell, PowerShell on Windows", () => {
    expect(defaultShell("darwin", { SHELL: "/opt/homebrew/bin/fish" })).toEqual({
      file: "/opt/homebrew/bin/fish",
      args: ["-l"],
    });
    expect(defaultShell("darwin", {})).toEqual({ file: "/bin/zsh", args: ["-l"] });
    expect(defaultShell("linux", { SHELL: "bash" })).toEqual({ file: "/bin/bash", args: ["-l"] });
    expect(defaultShell("win32", { SystemRoot: "C:\\Windows" }).file).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("adds a UTF-8 locale when launched from Finder without one", () => {
    if (process.platform === "win32") return;
    expect(terminalEnv({ PATH: "/bin" }).LANG).toBe("en_US.UTF-8");
    expect(terminalEnv({ PATH: "/bin", LANG: "zh_CN.UTF-8" }).LANG).toBe("zh_CN.UTF-8");
  });
});
