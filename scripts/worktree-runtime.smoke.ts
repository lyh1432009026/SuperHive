import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { HiveDatabase } from "../apps/server/src/database.js";
import { Peer } from "../apps/server/src/test-peer.js";
import { WorktreeManager, worktreeGit } from "../apps/server/src/worktrees.js";
import { AgentBridge } from "../packages/superhive/src/bridge.js";
import { CodexAppServerResponder } from "../packages/superhive/src/codex-app-server-client.js";
import { StateStore } from "../packages/superhive/src/state-store.js";
import { resolveTaskWorkspace } from "../packages/superhive/src/task-workspace.js";
import { discoverCodexMcpServers } from "../packages/superhive/src/mcp-servers.js";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-worktree-runtime-")));
const repo = path.join(root, "repo");
mkdirSync(repo);
const git = async (cwd: string, args: string[]) => {
  const result = await worktreeGit(cwd, args);
  assert.equal(result.code, 0, result.stderr);
};
await git(repo, ["init", "-b", "main"]);
await git(repo, ["config", "user.name", "Smoke"]);
await git(repo, ["config", "user.email", "smoke@example.invalid"]);
await git(repo, ["config", "commit.gpgsign", "false"]);
writeFileSync(path.join(repo, "baseline.txt"), "initial\n");
await git(repo, ["add", "."]);
await git(repo, ["commit", "-m", "initial"]);
const sibling = path.join(root, "repo-wt", "other-agent");
mkdirSync(sibling, { recursive: true });
const secretFile = path.join(sibling, "outside.txt");
writeFileSync(secretFile, "must remain unchanged\n");
const databasePath = path.join(root, "db.sqlite");
const seed = new HiveDatabase(databasePath);
const createWithModel = process.argv.includes("--create-with-model");
seed.updateRoom("general", { workspace: repo });
seed.createLocalAgent({
  name: "writer",
  access: "workspace",
  provider: "codex",
  cwd: repo,
  model: null,
});
if (!createWithModel) {
  const actor = seed.upsertParticipant({ roomId: "general", username: "writer", type: "agent" });
  await new WorktreeManager({ database: seed, activeInvocations: () => [] }).create(
    repo,
    actor,
    "SmokeOwner",
    [],
    { slug: "sandbox-proof" },
  );
}
seed.close();
const token = randomBytes(24).toString("hex");
const app = await buildApp({
  databasePath,
  token,
  staticDir: "/not-present",
  localAgents: {
    cli: { command: "fake", args: [] },
    serverUrl: "http://127.0.0.1",
    spawn: () => {
      let exit: ((code: number | null) => void) | undefined;
      return {
        pid: 9_999_999,
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
const serverUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
const hive = { serverUrl, roomId: "general", username: "writer", token };
const settingsFile = path.join(root, "settings.json");
writeFileSync(
  settingsFile,
  JSON.stringify({
    mcpDisabled: discoverCodexMcpServers()
      .map((item) => item.name)
      .filter((name) => name !== "hive"),
  }),
  { mode: 0o600 },
);
const store = new StateStore(path.join(root, "state"), hive);
const responder = (cwd: string) =>
  new CodexAppServerResponder({ command: "codex", cwd, access: "workspace", hive, settingsFile });
const bridge = new AgentBridge(
  {
    ...hive,
    persona: "Temporary sandbox verification agent",
    provider: "codex",
    access: "workspace",
    cwd: repo,
    taskWorkspace: { resolve: (id) => resolveTaskWorkspace(hive, id), responder },
  },
  store,
  responder(repo),
  (message) => console.log(message),
);
const owner = await Peer.connect(`${serverUrl.replace("http", "ws")}/ws`);
const heartbeat = setInterval(() => owner.send({ type: "presence.heartbeat" }), 15_000);
try {
  owner.send({
    type: "participant.join",
    username: "SmokeOwner",
    participantType: "human",
    roomId: "general",
    token,
  });
  await owner.next((event) => event.type === "room.snapshot");
  console.log("smoke: owner joined");
  await bridge.start();
  await owner.next(
    (event) => event.type === "presence.changed" && event.participant.username === "writer",
    15_000,
  );
  console.log("smoke: agent joined");
  owner.send({
    type: "message.send",
    clientMessageId: "smoke-create",
    content: createWithModel
      ? `@writer 请创建 slug 为 sandbox-proof 的 worktree，按工具的交接说明结束准备回合。Bridge 在新目录开新会话继续后，请用命令写入 proof.txt，内容为 workspace proof 加换行；不要提交。写好后回复完成。`
      : `@writer 请在当前工作目录写入 proof.txt，内容为 workspace proof 加换行；不要提交，也不要调用其它 MCP 工具。写好后回复完成。`,
  });
  const ended = await owner.next(
    (event) =>
      event.type === "invocation.updated" &&
      ["completed", "failed", "uncertain"].includes(event.invocation.status),
    300_000,
  );
  assert.equal(ended.type, "invocation.updated");
  if (ended.type !== "invocation.updated") throw new Error("No invocation result");
  assert.equal(ended.invocation.status, "completed", ended.invocation.detail);
  const checkout = path.join(root, "repo-wt", "writer-sandbox-proof");
  assert.equal(readFileSync(path.join(checkout, "proof.txt"), "utf8"), "workspace proof\n");
  assert.equal(readFileSync(secretFile, "utf8"), "must remain unchanged\n");
  assert.equal(existsSync(path.join(repo, "proof.txt")), false);
  const state = await store.load();
  assert.equal(state?.workspace, checkout);
  assert.ok(state?.threadId);
  await git(checkout, ["add", "proof.txt"]);
  await git(checkout, ["commit", "-m", "workspace proof"]);
  await git(repo, ["merge", "--ff-only", "feat/writer-sandbox-proof"]);
  await (app as unknown as { runWorktreeCleanup(): Promise<void> }).runWorktreeCleanup();
  const notice = await owner.next(
    (event) => event.type === "worktree.cleanup" && event.state === "available",
    15_000,
  );
  assert.equal(notice.type, "worktree.cleanup");
  if (notice.type !== "worktree.cleanup") throw new Error("No cleanup notice");
  const session = (await (await fetch(`${serverUrl}/api/local/session`)).json()) as {
    ownerToken: string;
  };
  const cleanup = await fetch(
    `${serverUrl}/api/local/worktrees/general/batches/${notice.batchId}`,
    { method: "POST", headers: { "X-Hive-Owner": session.ownerToken } },
  );
  assert.equal(cleanup.status, 200);
  await owner.next(
    (event) => event.type === "worktree.cleanup" && event.state === "completed",
    15_000,
  );
  assert.equal(existsSync(checkout), false);
  console.log(
    JSON.stringify({
      workspaceWrite: true,
      siblingUnchanged: true,
      primaryCheckoutUnchanged: true,
      newSessionBoundToCheckout: true,
      cleanupNotificationAndBatchRemoval: true,
      createWithModel,
    }),
  );
} finally {
  clearInterval(heartbeat);
  await bridge.stop();
  owner.socket.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
