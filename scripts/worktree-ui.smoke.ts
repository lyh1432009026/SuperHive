import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { HiveDatabase } from "../apps/server/src/database.js";
import { WorktreeManager, worktreeGit } from "../apps/server/src/worktrees.js";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-worktree-ui-")));
const repo = path.join(root, "project");
mkdirSync(repo);
const git = async (cwd: string, args: string[]) => {
  const result = await worktreeGit(cwd, args);
  if (result.code) throw new Error(result.stderr);
};
await git(repo, ["init", "-b", "main"]);
await git(repo, ["config", "user.name", "UI Smoke"]);
await git(repo, ["config", "user.email", "ui@example.invalid"]);
await git(repo, ["config", "commit.gpgsign", "false"]);
writeFileSync(path.join(repo, "file.txt"), "initial\n");
await git(repo, ["add", "."]);
await git(repo, ["commit", "-m", "initial"]);
const databasePath = path.join(root, "db.sqlite");
const seed = new HiveDatabase(databasePath);
seed.updateRoom("general", { name: "Worktree smoke", workspace: repo });
seed.createLocalAgent({
  name: "worker",
  access: "workspace",
  provider: "codex",
  cwd: repo,
  model: null,
});
const actor = seed.upsertParticipant({ roomId: "general", username: "worker", type: "agent" });
const manager = new WorktreeManager({ database: seed, activeInvocations: () => [] });
for (const slug of ["ready", "in-review", "unfinished", "switched"]) {
  const { worktree } = await manager.create(repo, actor, "Alice", [], { slug });
  if (slug === "switched") {
    // 有人在任务目录里直接换了分支：列表标出来，给房主两个修复操作
    await git(worktree.path, ["switch", "-c", "feat/worker-next-task"]);
    continue;
  }
  if (slug !== "ready") writeFileSync(path.join(worktree.path, "file.txt"), `${slug}\n`);
  if (slug === "in-review") {
    await git(worktree.path, ["add", "."]);
    await git(worktree.path, ["commit", "-m", slug]);
  }
}
seed.close();
const app = await buildApp({
  databasePath,
  token: randomBytes(24).toString("hex"),
  staticDir: path.resolve(import.meta.dirname, "../apps/web/dist"),
  localAgents: {
    cli: { command: "fake", args: [] },
    serverUrl: "http://127.0.0.1",
    spawn: () => {
      let exit: ((code: number | null) => void) | undefined;
      return {
        pid: 9_999_998,
        onOutput: () => undefined,
        onExit: (listener) => {
          exit = listener;
        },
        kill: () => exit?.(0),
      };
    },
  },
});
await app.listen({ host: "127.0.0.1", port: 0 });
console.log(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`);
process.on("SIGTERM", () => {
  void app.close().finally(() => {
    rmSync(root, { recursive: true, force: true });
    process.exit(0);
  });
});
process.on("SIGINT", () => process.emit("SIGTERM"));
