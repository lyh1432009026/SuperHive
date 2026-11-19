import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { HiveDatabase } from "./database.js";
import type { SpawnAgent } from "./local-agents.js";

/** 假的本机 Agent 进程：只记下被拉起过，不真的跑 */
function fakeSpawn() {
  let pid = 9_100_000;
  return vi.fn<SpawnAgent>(() => {
    let exit: ((code: number | null) => void) | undefined;
    return {
      pid: pid++,
      onOutput: () => undefined,
      onExit: (listener) => {
        exit = listener;
      },
      kill: () => exit?.(0),
    };
  });
}

describe("sandbox preview", () => {
  const dirs: string[] = [];
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** 一份带着「开机自启」本机 Agent 的数据，模拟从真实数据目录复制来的副本 */
  function seededDatabase(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-sandbox-"));
    dirs.push(dir);
    const databasePath = path.join(dir, "hive.sqlite");
    const seed = new HiveDatabase(databasePath);
    seed.createLocalAgent({
      name: "helper",
      access: "read-only",
      provider: "codex",
      cwd: dir,
      model: null,
    });
    seed.close();
    return databasePath;
  }

  async function start(databasePath: string, sandbox: boolean) {
    const spawn = fakeSpawn();
    const app = await buildApp({
      databasePath,
      token: "test-token",
      staticDir: "/definitely-not-present",
      ...(sandbox ? { sandbox: true } : {}),
      openTerminal: vi.fn(async () => undefined),
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["/opt/superhive/dist/cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        spawn,
        probe: async () => ({ installed: true, version: "1.0.0" }),
      },
    });
    await app.ready();
    close = () => app.close();
    return { app, spawn };
  }

  it("marks itself in /health and /api/meta and never launches local Agents", async () => {
    const databasePath = seededDatabase();
    const { app, spawn } = await start(databasePath, true);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({
      sandbox: true,
    });
    expect((await app.inject({ method: "GET", url: "/api/meta" })).json()).toMatchObject({
      sandbox: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(spawn).not.toHaveBeenCalled();
    // 本机 Agent 的管理接口整体不可用，不能从网页上手动拉起
    const listed = await app.inject({ method: "GET", url: "/api/local/agents" });
    expect(listed.statusCode).not.toBe(200);
    await close?.();
    close = undefined;

    // 对照：同一份数据正常启动会自启这个 Agent，也不带沙箱标记
    const normal = await start(databasePath, false);
    await vi.waitFor(() => expect(normal.spawn).toHaveBeenCalled());
    expect((await normal.app.inject({ method: "GET", url: "/health" })).json()).not.toHaveProperty(
      "sandbox",
    );
  });
});
