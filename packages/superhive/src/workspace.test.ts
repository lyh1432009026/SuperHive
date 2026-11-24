import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allowedWorkspaceRoots, resolveRoomWorkspace, type WorkspaceFs } from "./workspace.js";

describe("房间工作区", () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ws-")));
  const code = path.join(base, "Coding");
  const hive = path.join(code, "superhive");
  const other = path.join(code, "autoclaw");
  const outside = path.join(base, "secrets");
  for (const dir of [hive, other, outside]) mkdirSync(dir, { recursive: true });
  symlinkSync(outside, path.join(other, "escape"));
  const roots = allowedWorkspaceRoots(hive);

  it("默认允许启动目录及其上一级", () => {
    expect(roots).toEqual([hive, code]);
    expect(allowedWorkspaceRoots(hive, [outside])).toContain(outside);
  });

  it("允许范围内跟随；范围外、符号链接逃逸、不存在都留在默认目录并说明；只读档同样跟随", () => {
    const resolve = (
      roomWorkspace: string | undefined,
      access: "workspace" | "read-only" = "workspace",
    ) => resolveRoomWorkspace({ roomWorkspace, defaultCwd: hive, allowedRoots: roots, access });
    expect(resolve(undefined)).toEqual({ cwd: hive });
    expect(resolve(other)).toEqual({ cwd: other });
    expect(resolve(outside).note).toContain("不在你允许的目录范围内");
    expect(resolve(path.join(other, "escape"))).toMatchObject({ cwd: hive });
    expect(resolve(path.join(base, "nope")).note).toContain("不存在");
    // 只读档能读文件：不跟随的话「读一下代码」会去读它自己的启动目录（rd #5467）
    expect(resolve(other, "read-only")).toEqual({ cwd: other });
    expect(resolve(outside, "read-only").note).toContain("不在你允许的目录范围内");
  });

  it("本机 Server 拉起的 Agent 信任房主设的工作区：范围外也跟随（只读档也是），但仍要存在、不接受根目录", () => {
    const trusted = (roomWorkspace: string, access: "workspace" | "read-only" = "workspace") =>
      resolveRoomWorkspace({
        roomWorkspace,
        defaultCwd: hive,
        allowedRoots: roots,
        access,
        trusted: true,
      });
    expect(trusted(outside)).toEqual({ cwd: outside });
    expect(trusted(path.join(base, "nope")).note).toContain("不存在");
    expect(trusted(outside, "read-only")).toEqual({ cwd: outside });
    expect(trusted("/")).toMatchObject({ cwd: hive });
    expect(trusted("/").note).toContain("根目录");
  });

  it("管不了只读的 Provider（OpenClaw）只读档不跟随；专属空目录在说明里点明", () => {
    const result = resolveRoomWorkspace({
      roomWorkspace: outside,
      defaultCwd: hive,
      allowedRoots: roots,
      access: "read-only",
      trusted: true,
      readOnlyEnforced: false,
    });
    expect(result.cwd).toBe(hive);
    expect(result.note).toContain("没法限制为只读");
    // 只读档不跟随时可写档照常跟随
    expect(
      resolveRoomWorkspace({
        roomWorkspace: outside,
        defaultCwd: hive,
        allowedRoots: roots,
        access: "workspace",
        trusted: true,
        readOnlyEnforced: false,
      }),
    ).toEqual({ cwd: outside });
    const scratch = resolveRoomWorkspace({
      roomWorkspace: path.join(base, "nope"),
      defaultCwd: hive,
      allowedRoots: roots,
      access: "read-only",
      trusted: true,
      scratchDefault: true,
    });
    expect(scratch.note).toContain("专属的空目录");
  });
});

describe("房间工作区：Windows 路径", () => {
  // 假的 Windows 文件系统：目录按不分大小写的反斜杠路径登记，realpath 返回登记时的写法（和 NTFS 一样）
  const dirs = ["C:\\Users\\zphz", "D:\\Code", "D:\\Code\\Proj", "D:\\Code\\Other"];
  const lookup = (input: string) =>
    dirs.find((dir) => dir.toLowerCase() === path.win32.resolve(input).toLowerCase());
  const fs: WorkspaceFs = {
    path: path.win32,
    home: "C:\\Users\\zphz",
    realpath: (input) => {
      const found = lookup(input);
      if (!found) throw new Error(`ENOENT: ${input}`);
      return found;
    },
    isDirectory: (input) => lookup(input) !== undefined,
  };
  const roots = allowedWorkspaceRoots("D:\\Code\\Proj", [], fs);
  const resolve = (roomWorkspace: string, trusted = false) =>
    resolveRoomWorkspace(
      {
        roomWorkspace,
        defaultCwd: "D:\\Code\\Proj",
        allowedRoots: roots,
        access: "read-only",
        trusted,
      },
      fs,
    );

  it("正斜杠、结尾分隔符、大小写不同都认成同一个目录", () => {
    expect(roots).toEqual(["D:\\Code\\Proj", "D:\\Code"]);
    expect(resolve("D:/Code/Other/")).toEqual({ cwd: "D:\\Code\\Other" });
    expect(resolve("d:\\code\\other")).toEqual({ cwd: "D:\\Code\\Other" });
    expect(resolve("d:/CODE/proj")).toEqual({ cwd: "D:\\Code\\Proj" });
  });

  it("~\\ 展开到家目录；不存在、盘符根目录退回并说明", () => {
    expect(resolve("~\\", true)).toEqual({ cwd: "C:\\Users\\zphz" });
    expect(resolve("E:\\Missing", true).note).toContain("不存在");
    dirs.push("D:\\");
    expect(resolve("d:/", true).note).toContain("根目录");
    expect(resolve("C:\\Users\\zphz").note).toContain("不在你允许的目录范围内");
  });
});
