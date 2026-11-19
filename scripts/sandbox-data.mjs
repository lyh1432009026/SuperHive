// 沙箱预览的数据副本：从真实数据目录拷一份到临时目录，拷的时候就剔除密钥和会碰到外面的配置。
// 只读打开原库（VACUUM INTO 是一次一致的只读快照），原数据目录里的任何文件都不会被改。
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** better-sqlite3 只装在 apps/server 下，按那里的依赖解析 */
function openDatabase(file, options) {
  const require = createRequire(path.join(ROOT, "apps/server/package.json"));
  const Database = require("better-sqlite3");
  return new Database(file, options);
}

/**
 * 不随副本带走的东西：
 * - IM（飞书、微信）连接、凭据、投递队列：`im_*` 整组；也不拷 im-secret.key，即使漏删也解不开
 * - 房主登录设备、配对口令、IM 登录票据：`owner_*` 整组
 * - 访客会话与邀请（邀请表里有明文链接口令）
 * - join token 与房主登录签名密钥：沙箱启动时重新生成，真实的设备令牌在沙箱里不认
 */
const DROPPED_TABLE_PREFIXES = ["im_", "owner_"];
const DROPPED_TABLES = ["access_sessions", "invites", "managed_worktree_cleanup"];
const DROPPED_META_KEYS = ["join_token", "setting:ownerLoginSecret", "setting:keepAwake"];

/** 剔除副本里的密钥与外部连接；返回每张表删掉的行数，给启动日志用 */
export function scrubSandboxDatabase(file) {
  const db = openDatabase(file);
  try {
    // 删掉的行连同所在页一起清零，VACUUM 后文件里不留旧数据
    db.pragma("secure_delete = ON");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    const has = (name) => tables.includes(name);
    const removed = {};
    db.transaction(() => {
      for (const table of tables) {
        if (
          !DROPPED_TABLES.includes(table) &&
          !DROPPED_TABLE_PREFIXES.some((prefix) => table.startsWith(prefix))
        )
          continue;
        removed[table] = db.prepare(`DELETE FROM "${table}"`).run().changes;
      }
      if (has("meta")) {
        const statement = db.prepare("DELETE FROM meta WHERE key = ?");
        removed.meta = DROPPED_META_KEYS.reduce((sum, key) => sum + statement.run(key).changes, 0);
      }
      // 沙箱 Server 本来就不拉起本机 Agent；这里再把自启关掉，副本流到别处也不会自己起来
      if (has("local_agents"))
        db.prepare(
          "UPDATE local_agents SET autostart = 0, pid = NULL, pid_started_at = NULL",
        ).run();
      if (has("managed_worktree_preferences"))
        db.prepare("UPDATE managed_worktree_preferences SET auto_cleanup = 0").run();
      if (has("participants")) db.prepare("UPDATE participants SET status = 'offline'").run();
    })();
    db.exec("VACUUM");
    return removed;
  } finally {
    db.close();
  }
}

/** 找到数据库文件：传数据目录（里面有 hive.sqlite）或直接传 .sqlite 文件 */
export function resolveSourceDatabase(from) {
  const resolved = path.resolve(from);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat) throw new Error(`找不到数据目录：${resolved}`);
  const file = stat.isDirectory() ? path.join(resolved, "hive.sqlite") : resolved;
  if (!fs.existsSync(file)) throw new Error(`数据目录里没有 hive.sqlite：${resolved}`);
  return file;
}

/** 递归复制附件；APFS / Btrfs 上用写时复制，几乎不占空间也不花时间 */
function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    // 不跟随符号链接：附件目录里本来不该有，有也不能借它拷出别处的文件
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
  }
}

/**
 * 把 from 的数据拷进 dir（沙箱的临时数据目录）。
 * 只拷数据库和附件；im-secret.key、agent-logs、agent-settings 都不带。
 */
export function prepareSandboxData({ from, dir, attachments = true }) {
  const source = resolveSourceDatabase(from);
  const target = path.join(dir, "hive.sqlite");
  if (path.resolve(path.dirname(source)) === path.resolve(dir))
    throw new Error("沙箱数据目录不能和原数据目录相同");
  fs.mkdirSync(dir, { recursive: true });
  const reader = openDatabase(source, { readonly: true, fileMustExist: true });
  try {
    reader.prepare("VACUUM INTO ?").run(target);
  } finally {
    reader.close();
  }
  const removed = scrubSandboxDatabase(target);
  const attachmentDir = path.join(path.dirname(source), "attachments");
  const copiedAttachments = attachments && fs.existsSync(attachmentDir);
  if (copiedAttachments) copyTree(attachmentDir, path.join(dir, "attachments"));
  return { source, database: target, removed, attachments: copiedAttachments };
}
