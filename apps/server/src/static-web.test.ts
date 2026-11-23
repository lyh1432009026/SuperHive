import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "./app.js";

describe("网页静态文件", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("运行中重新构建网页后，新生成的资源文件也能取到（不会白屏）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-web-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), '<script src="/assets/index-old.js"></script>');
    writeFileSync(path.join(dir, "assets/index-old.js"), "old");
    const app = await buildApp({ databasePath: ":memory:", token: "test-token", staticDir: dir });
    cleanup = async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    };

    expect((await app.inject({ method: "GET", url: "/assets/index-old.js" })).statusCode).toBe(200);

    // 模拟 pnpm build：换一批带新哈希的文件
    rmSync(path.join(dir, "assets/index-old.js"));
    writeFileSync(path.join(dir, "assets/index-new.js"), "new");
    writeFileSync(path.join(dir, "index.html"), '<script src="/assets/index-new.js"></script>');

    const fresh = await app.inject({ method: "GET", url: "/assets/index-new.js" });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.body).toBe("new");
    expect((await app.inject({ method: "GET", url: "/" })).body).toContain("index-new.js");
    expect((await app.inject({ method: "GET", url: "/assets/index-old.js" })).statusCode).toBe(404);
    // 接口照常走自己的路由
    const rooms = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { authorization: "Bearer test-token" },
    });
    expect(rooms.statusCode).toBe(200);
    expect(rooms.headers["content-type"]).toContain("application/json");
  });
});
