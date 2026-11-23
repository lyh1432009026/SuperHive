import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareSandboxData } from "./sandbox-data.mjs";
import {
  actionScript,
  compareHtml,
  initialStorage,
  outputFiles,
  parseOptions,
} from "./screenshot.mjs";

const require = createRequire(path.resolve(import.meta.dirname, "../apps/server/package.json"));
const Database = require("better-sqlite3");

/** 造一份「真实数据目录」：带 IM 连接、登录设备、邀请、自启 Agent、待清理任务目录和附件 */
function seed(dir) {
  fs.mkdirSync(path.join(dir, "attachments", "ab"), { recursive: true });
  fs.writeFileSync(path.join(dir, "attachments", "ab", "file.png"), "png");
  fs.writeFileSync(path.join(dir, "im-secret.key"), "key");
  fs.mkdirSync(path.join(dir, "agent-settings"));
  const db = new Database(path.join(dir, "hive.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('join_token', 'real-join-token'), ('setting:ownerLoginSecret', 'c2VjcmV0'),
      ('setting:room-pins', '[]');
    CREATE TABLE im_connections (id TEXT, secret TEXT);
    INSERT INTO im_connections VALUES ('c1', 'feishu-app-secret');
    CREATE TABLE im_deliveries (id TEXT);
    INSERT INTO im_deliveries VALUES ('d1');
    CREATE TABLE owner_devices (id TEXT, token_hash TEXT);
    INSERT INTO owner_devices VALUES ('o1', 'hash');
    CREATE TABLE invites (id TEXT, token TEXT);
    INSERT INTO invites VALUES ('i1', 'invite-plain-token');
    CREATE TABLE access_sessions (id TEXT);
    INSERT INTO access_sessions VALUES ('a1');
    CREATE TABLE local_agents (id TEXT, autostart INTEGER, pid INTEGER, pid_started_at TEXT);
    INSERT INTO local_agents VALUES ('l1', 1, 4242, 'x');
    CREATE TABLE managed_worktree_cleanup (id TEXT, record TEXT);
    INSERT INTO managed_worktree_cleanup VALUES ('b1', '{}');
    CREATE TABLE managed_worktree_preferences (room_id TEXT, auto_cleanup INTEGER);
    INSERT INTO managed_worktree_preferences VALUES ('build', 1);
    CREATE TABLE participants (id TEXT, status TEXT);
    INSERT INTO participants VALUES ('p1', 'online');
    CREATE TABLE messages (id TEXT, content TEXT);
    INSERT INTO messages VALUES ('m1', 'hello');
  `);
  return db;
}

/** 每个文件的摘要；-shm 是 SQLite 读者之间共享的锁与索引内存，只读打开也会更新，不是数据 */
const snapshot = (dir) =>
  Object.fromEntries(
    fs
      .readdirSync(dir, { recursive: true })
      .map(String)
      .filter((name) => !name.endsWith("-shm"))
      .sort()
      .map((name) => {
        const file = path.join(dir, name);
        return [
          name,
          fs.statSync(file).isFile()
            ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
            : "dir",
        ];
      }),
  );

test("沙箱副本剔除密钥与外部连接，保留业务数据，原数据文件不变", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-sandbox-data-"));
  try {
    const source = path.join(root, "data");
    const target = path.join(root, "sandbox");
    const live = seed(source);
    // 原库还开着（真实 Server 在跑），WAL 里还有没落盘的写入
    live.prepare("INSERT INTO messages VALUES ('m2', 'in wal')").run();
    const before = snapshot(source);

    const copied = prepareSandboxData({ from: source, dir: target });
    assert.equal(copied.attachments, true);
    assert.deepEqual(snapshot(source), before);
    live.close();

    assert.deepEqual(fs.readdirSync(target).sort(), ["attachments", "hive.sqlite"]);
    assert.equal(fs.readFileSync(path.join(target, "attachments/ab/file.png"), "utf8"), "png");
    const db = new Database(copied.database, { readonly: true });
    try {
      const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
      for (const table of [
        "im_connections",
        "im_deliveries",
        "owner_devices",
        "invites",
        "access_sessions",
        "managed_worktree_cleanup",
      ])
        assert.equal(count(table), 0, table);
      assert.deepEqual(
        db
          .prepare("SELECT key FROM meta")
          .all()
          .map((row) => row.key),
        ["setting:room-pins"],
      );
      assert.deepEqual(db.prepare("SELECT autostart, pid FROM local_agents").get(), {
        autostart: 0,
        pid: null,
      });
      assert.equal(
        db.prepare("SELECT auto_cleanup FROM managed_worktree_preferences").get().auto_cleanup,
        0,
      );
      assert.equal(db.prepare("SELECT status FROM participants").get().status, "offline");
      assert.equal(count("messages"), 2);
    } finally {
      db.close();
    }
    // 删掉的密钥不能还留在文件的空闲页里
    const raw = fs.readFileSync(copied.database).toString("latin1");
    for (const secret of ["feishu-app-secret", "invite-plain-token", "real-join-token"])
      assert.equal(raw.includes(secret), false, secret);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("沙箱数据目录不能就是原数据目录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-sandbox-data-"));
  try {
    seed(root).close();
    assert.throws(() => prepareSandboxData({ from: root, dir: root }), /不能和原数据目录相同/);
    assert.throws(
      () => prepareSandboxData({ from: path.join(root, "missing"), dir: root }),
      /找不到/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("截图参数：多主题加后缀、预置动作、首次引导跳过", async () => {
  const options = parseOptions([
    "--url",
    "http://127.0.0.1:4000/#build",
    "--theme",
    "light,dark",
    "--action",
    "code",
    "--action",
    "settings:appearance",
    "--out",
    "output/x.png",
  ]);
  assert.deepEqual(options.themes, ["light", "dark"]);
  assert.deepEqual(
    outputFiles(options.out, options.themes).map((file) => path.basename(file)),
    ["x-light.png", "x-dark.png"],
  );
  assert.match(actionScript("code"), /\.workspace-toggle/);
  assert.match(actionScript("artifacts"), /\.artifacts-toggle/);
  assert.match(actionScript("settings:appearance"), /settings-panel-appearance/);
  assert.match(actionScript("side:whiteboard"), /#side-tab-whiteboard/);
  assert.match(actionScript("schedules"), /data-entry=\\"schedules\\"/);
  assert.match(actionScript("click:a:hover"), /"a:hover"/);
  // wait-for 只等元素出现，不把元素当结果按值回传（DOM 元素回传会报错）
  const element = { tagName: "DIV" };
  element.self = element;
  const waited = await new Function("window", `return ${actionScript("wait-for:.x")}`)({
    __shot: { find: async () => element },
  });
  assert.equal(waited, undefined);
  assert.throws(() => parseOptions(["--action", "fly"]), /不认识的动作/);
  assert.throws(() => parseOptions(["--theme", "blue"]), /light \/ dark/);
  assert.throws(() => parseOptions(["--compare", "one.png"]), /至少要两张图/);
  // 测试替身脚本：解析成绝对路径；不存在的直接报错，不静默截一张没有替身的图
  assert.deepEqual(parseOptions([]).initScripts, []);
  assert.deepEqual(parseOptions(["--init-script", "scripts/screenshot.mjs"]).initScripts, [
    path.resolve("scripts/screenshot.mjs"),
  ]);
  assert.throws(() => parseOptions(["--init-script", "nope.js"]), /文件不存在/);
  assert.deepEqual(initialStorage({ user: "rd", theme: "dark", room: "build" }), {
    "superhive.username": "rd",
    "superhive.theme": "dark",
    "superhive.onboarding": "done",
    "superhive.notify-prompt-dismissed": "true",
    "superhive.reduce-motion": "true",
    "superhive.room": "build",
  });
  assert.match(compareHtml(["/tmp/a.png", "/tmp/b.png"], ["改前", "<改后>"]), /&lt;改后&gt;/);
});
