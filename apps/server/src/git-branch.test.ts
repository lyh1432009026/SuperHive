import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitBranch } from "./git-branch.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive-branch-"));
  dirs.push(dir);
  return dir;
};

describe("gitBranch", () => {
  it("reads the branch from a subdirectory, a worktree pointer and a detached HEAD", () => {
    const repo = temp();
    mkdirSync(path.join(repo, ".git"));
    writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/feat/sidebar\n");
    mkdirSync(path.join(repo, "apps", "web"), { recursive: true });
    expect(gitBranch(path.join(repo, "apps", "web"))).toBe("feat/sidebar");

    const worktree = temp();
    const meta = path.join(repo, ".git", "worktrees", "w1");
    mkdirSync(meta, { recursive: true });
    writeFileSync(path.join(meta, "HEAD"), "ref: refs/heads/release/0.3.0\n");
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${meta}\n`);
    expect(gitBranch(worktree)).toBe("release/0.3.0");

    writeFileSync(path.join(meta, "HEAD"), "27cf5334a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6\n");
    expect(gitBranch(worktree)).toBe("27cf533");
  });

  it("returns nothing outside a repository", () => {
    expect(gitBranch(temp())).toBeUndefined();
  });
});

describe("room branch in the room list", () => {
  it("lists the branch and announces it when someone switches branches in the workspace", async () => {
    const { buildApp } = await import("./app.js");
    const { Peer } = await import("./test-peer.js");
    const repo = temp();
    mkdirSync(path.join(repo, ".git"));
    writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    const app = await buildApp({
      databasePath: ":memory:",
      token: "t",
      staticDir: "/nope",
      branchCheckMs: 30,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const port = (app.server.address() as { port: number }).port;
      const created = await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { authorization: "Bearer t" },
        payload: { id: "web", name: "web", workspace: repo },
      });
      expect(created.json().room).toMatchObject({ id: "web", branch: "main" });
      const listed = await app.inject({
        url: "/api/rooms",
        headers: { authorization: "Bearer t" },
      });
      expect(listed.json().rooms.find((room: { id: string }) => room.id === "web").branch).toBe(
        "main",
      );

      const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
      peer.send({
        type: "participant.join",
        username: "Alice",
        participantType: "human",
        roomId: "web",
        token: "t",
      });
      await peer.next((event) => event.type === "room.snapshot");
      writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/feat/branch-label\n");
      const changed = await peer.next(
        (event) => event.type === "rooms.changed" && event.room.branch === "feat/branch-label",
      );
      expect(changed).toBeTruthy();
      peer.socket.close();
    } finally {
      await app.close();
    }
  });
});
