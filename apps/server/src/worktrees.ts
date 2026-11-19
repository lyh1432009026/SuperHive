import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  managedWorktreeSchema,
  createWorktreeRequestSchema,
  serverText,
  zhText,
  type CreateWorktreeRequest,
  type ManagedWorktree,
  type Participant,
  type ServerText,
  type WorktreeStatus,
} from "@superhive/protocol";
import { HiveDatabase, HiveError } from "./database.js";
import { gitOperationName, slowOps } from "./slow-ops.js";

type GitResult = { code: number; stdout: string; stderr: string };

/**
 * 任务目录和登记的对不上。switched：同一个 checkout，只是被人切到了另一条（有名字的）分支，
 * 这种情况房主可以就地修好（切回或按当前分支重新登记）。
 */
export class WorktreeIdentityError extends HiveError {
  constructor(
    text: ServerText,
    readonly switched?: { registered: string; current: string },
  ) {
    super("WORKTREE_IDENTITY", text);
  }
}

/** 没沿用「上次用的任务目录」的原因，交给 Bridge 写进这次开工的提示和任务卡片 */
export type FocusDropped = {
  focusDropped: { worktreeId: string; path: string; branch: string; reason: string };
};
type Checkout = { path: string; branch: string | undefined; locked: boolean };
type Repository = { repo: string; commonDir: string; target: string };
type RemovedWorktree = ManagedWorktree & { removed: true };

export type WorktreeCleanupBatch = {
  id: string;
  roomId: string;
  ownerName: string;
  automatic: boolean;
  state: "available" | "queued" | "running" | "completed" | "expired";
  items: Array<{ id: string; repo: string; path: string; branch: string; headCommit: string }>;
  results?: Array<{ path: string; removed: boolean; branchDeleted?: boolean; error?: string }>;
};

export async function worktreeGit(cwd: string, args: string[], input?: string): Promise<GitResult> {
  const started = performance.now();
  let failed = false;
  try {
    return await spawnGit(cwd, args, input);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    slowOps.record({
      kind: "git",
      name: gitOperationName(args),
      durationMs: performance.now() - started,
      repo: cwd,
      ...(failed ? { failed } : {}),
    });
  }
}

function spawnGit(cwd: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    const child = spawn(
      "git",
      [
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-c",
        "core.fsmonitor=false",
        "-C",
        cwd,
        ...args,
      ],
      {
        env: { ...env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGKILL");
      reject(
        new HiveError(
          "WORKTREE_GIT_LIMIT",
          serverText("error.worktree.operation", { reason: "Git timeout/output limit" }),
        ),
      );
    };
    const timer = setTimeout(stop, 20_000);
    const collect = (chunk: string, target: "stdout" | "stderr") => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16 * 1024 * 1024) return stop();
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: string) => collect(chunk, "stderr"));
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!stopped) resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await worktreeGit(cwd, args, input);
  if (result.code !== 0) {
    throw new HiveError(
      "WORKTREE_GIT_FAILED",
      serverText("error.worktree.operation", {
        reason: result.stderr.trim().slice(0, 1000) || `Git exit ${result.code}`,
      }),
    );
  }
  return result.stdout;
}

async function checkouts(repo: string): Promise<Checkout[]> {
  const output = await git(repo, ["worktree", "list", "--porcelain", "-z"]);
  return output
    .split("\0\0")
    .filter(Boolean)
    .map((block) => {
      const fields = block.split("\0");
      return {
        path: path.normalize(fields.find((field) => field.startsWith("worktree "))!.slice(9)),
        branch: fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18),
        locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
      };
    });
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  const result = await worktreeGit(repo, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (result.code !== 0 && result.code !== 1)
    await git(repo, ["show-ref", "--verify", `refs/heads/${branch}`]);
  return result.code === 0;
}

async function validateBranch(repo: string, branch: string): Promise<void> {
  if (
    branch.startsWith("-") ||
    branch === "HEAD" ||
    (await worktreeGit(repo, ["check-ref-format", `refs/heads/${branch}`])).code !== 0
  ) {
    throw new HiveError(
      "WORKTREE_INVALID_REF",
      serverText("error.worktree.invalidRef", { ref: branch }),
    );
  }
}

async function commit(repo: string, ref: string): Promise<string> {
  if (ref.startsWith("-") || /[\0\r\n]/.test(ref)) {
    throw new HiveError("WORKTREE_INVALID_REF", serverText("error.worktree.invalidRef", { ref }));
  }
  return (await git(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
}

export async function worktreeRepository(workspace: string): Promise<Repository> {
  try {
    const cwd = await realpath(workspace);
    if ((await git(cwd, ["rev-parse", "--is-bare-repository"])).trim() !== "false")
      throw new Error("Bare repository");
    const commonDir = await realpath(
      (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
    );
    const listed = await checkouts(cwd);
    const repo = await realpath(listed[0]!.path);
    let target: string | undefined;
    const remoteHead = await worktreeGit(repo, [
      "symbolic-ref",
      "--quiet",
      "refs/remotes/origin/HEAD",
    ]);
    const remoteBranch =
      remoteHead.code === 0
        ? remoteHead.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : undefined;
    for (const name of [
      ...new Set(
        [remoteBranch, "main", "master"].filter((value): value is string => Boolean(value)),
      ),
    ]) {
      if (await branchExists(repo, name)) {
        target = name;
        break;
      }
    }
    if (!target) throw new Error("No local default branch (origin/HEAD, main or master)");
    return { repo, commonDir, target };
  } catch (error) {
    // git 超时只说明机器忙，不说明仓库有问题：原样抛出，调用方据此判断可以稍后重试
    if (error instanceof HiveError && error.code === "WORKTREE_GIT_LIMIT") throw error;
    throw new HiveError(
      "WORKTREE_REPOSITORY_INVALID",
      serverText("error.worktree.repository", {
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** fingerprint：目标分支名和两边分支的提交；有人提交或合入就对不上，立刻重新检查 */
type CachedStatus = { status: WorktreeStatus; at: number; fingerprint: string };

/** 同时检查几条任务线：一条要跑十几个 git 进程，全部并发会把机器拖慢，逐条串行又太久 */
const STATUS_CONCURRENCY = 4;
/** 合入判断按（分支提交, 目标提交）缓存：两边都没动结论就不会变，上限防止无限增长 */
const MERGE_CACHE_LIMIT = 1_000;

export class WorktreeManager {
  /** 写操作（建、删、选目录绑定任务）按仓库串行；只读的状态查询不进这个队列 */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly statusCache = new Map<string, CachedStatus>();
  /** 每条任务线的写版本：写操作前后各加一，算到一半版本变了的状态不进缓存 */
  private readonly statusEpochs = new Map<string, number>();
  private readonly statusInflight = new Map<string, Promise<WorktreeStatus>>();
  /** 正在被写操作改动的任务线（id → 进行中的写操作数）：这期间读到的状态不算可清理、也不进缓存 */
  private readonly writes = new Map<string, number>();
  private readonly mergeCache = new Map<
    string,
    { merged: boolean; mergeMethod?: WorktreeStatus["mergeMethod"] }
  >();
  private scanning: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly options: {
      database: HiveDatabase;
      activeInvocations: (worktree: ManagedWorktree) => string[];
      onBoardChanged?: (roomId: string) => void;
      onCleanup?: (batch: WorktreeCleanupBatch) => void;
      /** Server 替人做了决定（比如不再沿用某个任务目录）：记审计日志 */
      audit?: (message: string, details: Record<string, string>) => void;
      /** 只读状态（未提交/未跟踪/忽略文件）的缓存时长；写操作会立即作废对应任务线的缓存 */
      statusCacheMs?: number;
      /**
       * 沙箱预览：数据库是副本，但登记的路径指向真实仓库。只许读状态，不建、不删、不自动清理，
       * 免得副本里的记录把真实的任务目录删掉。
       */
      readOnly?: boolean;
    },
  ) {
    options.database.connection().exec(`CREATE TABLE IF NOT EXISTS managed_worktrees (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, agent_name TEXT NOT NULL, slug TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, record TEXT NOT NULL,
      UNIQUE(repo, agent_name, slug), UNIQUE(repo, branch)
    )`);
    options.database.connection().exec(`CREATE TABLE IF NOT EXISTS managed_worktree_focus (
      room_id TEXT NOT NULL, agent_name TEXT NOT NULL, worktree_id TEXT NOT NULL,
      PRIMARY KEY(room_id, agent_name)
    )`);
    options.database.connection().exec(`CREATE TABLE IF NOT EXISTS managed_worktree_bindings (
      invocation_id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL
    )`);
    options.database.connection().exec(`CREATE TABLE IF NOT EXISTS managed_worktree_removals (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, record TEXT NOT NULL
    )`);
    options.database.connection().exec(`CREATE TABLE IF NOT EXISTS managed_worktree_notices (
      worktree_id TEXT PRIMARY KEY, head_commit TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS managed_worktree_cleanup (
      id TEXT PRIMARY KEY, record TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS managed_worktree_preferences (
      room_id TEXT PRIMARY KEY, auto_cleanup INTEGER NOT NULL DEFAULT 0
    )`);
  }

  allRecords(): ManagedWorktree[] {
    return (
      this.options.database
        .connection()
        .prepare("SELECT record FROM managed_worktrees ORDER BY rowid")
        .all() as Array<{ record: string }>
    ).map((row) => managedWorktreeSchema.parse(JSON.parse(row.record)));
  }

  autoCleanup(roomId: string): boolean {
    return Boolean(
      (
        this.options.database
          .connection()
          .prepare("SELECT auto_cleanup FROM managed_worktree_preferences WHERE room_id = ?")
          .get(roomId) as { auto_cleanup: number } | undefined
      )?.auto_cleanup,
    );
  }

  setAutoCleanup(roomId: string, enabled: boolean): void {
    this.options.database
      .connection()
      .prepare(
        "INSERT INTO managed_worktree_preferences (room_id, auto_cleanup) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET auto_cleanup = excluded.auto_cleanup",
      )
      .run(roomId, enabled ? 1 : 0);
    for (const batch of this.roomBatches(roomId)) {
      if (enabled && batch.state === "available") {
        batch.automatic = true;
        batch.state = "queued";
        this.saveBatch(batch);
      } else if (!enabled && batch.automatic && batch.state === "queued") {
        batch.automatic = false;
        batch.state = "available";
        this.saveBatch(batch);
      }
    }
  }

  cleanupBatch(id: string): WorktreeCleanupBatch | undefined {
    const row = this.options.database
      .connection()
      .prepare("SELECT record FROM managed_worktree_cleanup WHERE id = ?")
      .get(id) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as WorktreeCleanupBatch) : undefined;
  }

  roomBatches(roomId: string, statuses?: WorktreeStatus[]): WorktreeCleanupBatch[] {
    const batches = (
      this.options.database
        .connection()
        .prepare("SELECT record FROM managed_worktree_cleanup ORDER BY rowid DESC")
        .all() as Array<{ record: string }>
    )
      .map((row) => JSON.parse(row.record) as WorktreeCleanupBatch)
      .filter(
        (batch) => batch.roomId === roomId && !["completed", "expired"].includes(batch.state),
      );
    if (!statuses) return batches;
    const current = new Map(statuses.map((item) => [item.worktree.id, item]));
    return batches
      .filter((batch) => batch.state === "available")
      .map((batch) => ({
        ...batch,
        items: batch.items.filter((item) => {
          const status = current.get(item.id);
          return status?.removable && status.headCommit === item.headCommit;
        }),
      }))
      .filter((batch) => batch.items.length > 0);
  }

  private pruneCleanupBatches(statuses: WorktreeStatus[] = []): void {
    const records = new Set(this.allRecords().map((item) => item.id));
    const current = new Map(statuses.map((item) => [item.worktree.id, item]));
    const rows = this.options.database
      .connection()
      .prepare("SELECT record FROM managed_worktree_cleanup")
      .all() as Array<{ record: string }>;
    for (const row of rows) {
      const batch = JSON.parse(row.record) as WorktreeCleanupBatch;
      if (batch.state !== "available") continue;
      const items = batch.items.filter(
        (item) =>
          records.has(item.id) &&
          (!current.get(item.id)?.headCommit ||
            current.get(item.id)?.headCommit === item.headCommit),
      );
      if (items.length === batch.items.length) continue;
      batch.items = items;
      if (!items.length) batch.state = "expired";
      this.saveBatch(batch);
      this.options.onCleanup?.(batch);
    }
  }

  private saveBatch(batch: WorktreeCleanupBatch): void {
    this.options.database
      .connection()
      .prepare(
        "INSERT INTO managed_worktree_cleanup (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
      )
      .run(batch.id, JSON.stringify(batch));
  }

  requestCleanup(id: string, ownerName: string): boolean {
    const batch = this.cleanupBatch(id);
    if (!batch || batch.ownerName !== ownerName || ["completed", "expired"].includes(batch.state))
      return false;
    if (batch.state !== "available") return true;
    batch.state = "queued";
    this.saveBatch(batch);
    return true;
  }

  scan(): Promise<void> {
    if (this.closed || this.options.readOnly) return Promise.resolve();
    if (this.scanning) return this.scanning;
    this.scanning = this.scanInner().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async scanInner(): Promise<void> {
    const groups = new Map<string, WorktreeCleanupBatch>();
    const statuses: WorktreeStatus[] = [];
    for (const record of this.allRecords()) {
      if (this.closed) return;
      // 后台定时扫描，不在写锁里，也不急：每次都重新检查，不用缓存
      const status = await this.status(record);
      statuses.push(status);
      // 被换了分支的目录：不清理，只在白板上提示房主
      if (status.branchSwitched) this.markSwitched(record, status.branchSwitched.current);
      if (!status.removable || !status.headCommit) continue;
      const notice = this.options.database
        .connection()
        .prepare("SELECT head_commit FROM managed_worktree_notices WHERE worktree_id = ?")
        .get(record.id) as { head_commit: string } | undefined;
      if (notice?.head_commit === status.headCommit) continue;
      const key = `${record.roomId}\0${record.ownerName}`;
      const automatic = this.autoCleanup(record.roomId);
      const batch = groups.get(key) ?? {
        id: randomUUID(),
        roomId: record.roomId,
        ownerName: record.ownerName,
        automatic,
        state: automatic ? ("queued" as const) : ("available" as const),
        items: [],
      };
      batch.items.push({
        id: record.id,
        repo: record.repo,
        path: record.path,
        branch: record.branch,
        headCommit: status.headCommit,
      });
      groups.set(key, batch);
    }
    this.pruneCleanupBatches(statuses);
    for (const batch of groups.values()) {
      if (this.closed) return;
      this.options.database.connection().transaction(() => {
        this.saveBatch(batch);
        const statement = this.options.database
          .connection()
          .prepare(
            "INSERT INTO managed_worktree_notices (worktree_id, head_commit) VALUES (?, ?) ON CONFLICT(worktree_id) DO UPDATE SET head_commit = excluded.head_commit",
          );
        for (const item of batch.items) statement.run(item.id, item.headCommit);
      })();
      if (!batch.automatic) this.options.onCleanup?.(batch);
    }
    const pending = this.options.database
      .connection()
      .prepare("SELECT record FROM managed_worktree_cleanup")
      .all() as Array<{ record: string }>;
    for (const row of pending) {
      if (this.closed) return;
      const batch = JSON.parse(row.record) as WorktreeCleanupBatch;
      if (!["queued", "running"].includes(batch.state)) continue;
      batch.state = "running";
      this.saveBatch(batch);
      batch.results ??= [];
      for (const item of batch.items) {
        if (this.closed) return;
        if (batch.automatic && !this.autoCleanup(batch.roomId)) {
          batch.automatic = false;
          batch.state = "available";
          this.saveBatch(batch);
          break;
        }
        if (batch.results.some((result) => result.path === item.path)) continue;
        try {
          const result = await this.remove(item.repo, {
            path: item.path,
            expectedCommit: item.headCommit,
          });
          batch.results.push({
            path: item.path,
            removed: true,
            branchDeleted: result.branchDeleted,
            ...(result.branchError ? { error: result.branchError } : {}),
          });
        } catch (error) {
          batch.results.push({
            path: item.path,
            removed: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.saveBatch(batch);
      }
      if (batch.state === "available") continue;
      batch.state = "completed";
      this.saveBatch(batch);
      this.options.onCleanup?.(batch);
    }
  }

  private assertWritable(): void {
    if (this.options.readOnly)
      throw new HiveError("SANDBOX_DISABLED", serverText("error.sandbox.disabled"));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.scanning;
  }

  records(repo: string): ManagedWorktree[] {
    const rows = this.options.database
      .connection()
      .prepare("SELECT record FROM managed_worktrees WHERE repo = ? ORDER BY rowid")
      .all(repo) as Array<{ record: string }>;
    return rows.map((row) => managedWorktreeSchema.parse(JSON.parse(row.record)));
  }

  private save(record: ManagedWorktree): void {
    this.options.database
      .connection()
      .prepare("UPDATE managed_worktrees SET record = ? WHERE id = ?")
      .run(JSON.stringify(record), record.id);
  }

  private focus(record: ManagedWorktree): void {
    this.options.database
      .connection()
      .prepare(
        `INSERT INTO managed_worktree_focus (room_id, agent_name, worktree_id) VALUES (?, ?, ?)
         ON CONFLICT(room_id, agent_name) DO UPDATE SET worktree_id = excluded.worktree_id`,
      )
      .run(record.roomId, record.agentName, record.id);
  }

  /**
   * 不再把这个 Agent 的新任务默认放进这个目录。写一条审计日志（谁、哪个目录、为什么），
   * 返回给 Bridge 的说明会写进这次开工的提示和任务卡片。
   */
  private dropFocus(actor: Participant, record: ManagedWorktree, reason: string): FocusDropped {
    this.options.database
      .connection()
      .prepare(
        "DELETE FROM managed_worktree_focus WHERE room_id = ? AND agent_name = ? AND worktree_id = ?",
      )
      .run(actor.roomId, actor.username, record.id);
    this.options.audit?.(
      zhText(
        serverText("worktree.focusDropped", {
          agent: actor.username,
          path: record.path,
          reason,
        }),
      ),
      { roomId: actor.roomId, agentName: actor.username, worktreeId: record.id },
    );
    return {
      focusDropped: { worktreeId: record.id, path: record.path, branch: record.branch, reason },
    };
  }

  /** 白板上这条任务目录标成阻塞：写明登记的、现在的分支和房主能做的事。没变就不重写 */
  private markSwitched(record: ManagedWorktree, current: string): void {
    const author = this.options.database.findParticipant(record.roomId, record.agentName);
    if (!author) return;
    try {
      const board = this.options.database.upsertWhiteboardEntry(author, {
        key: `worktree:${record.id}`,
        slot: "blocked",
        summary: zhText(
          serverText("worktree.branchSwitched", {
            registered: record.branch,
            current,
            path: record.path,
          }),
        ).slice(0, 500),
        repo: path.basename(record.repo),
        branch: record.branch,
        claim: { repo: record.repo, branch: record.branch },
      });
      if (board.changed) this.options.onBoardChanged?.(record.roomId);
    } catch {
      // 白板只是提示；写不进去（比如别人占着这个 key）不影响任务目录本身的判断
    }
  }

  /** 恢复正常后白板上的这条回到进行中 */
  private markRegistered(record: ManagedWorktree): void {
    const author = this.options.database.findParticipant(record.roomId, record.agentName);
    if (!author) return;
    const board = this.options.database.upsertWhiteboardEntry(author, {
      key: `worktree:${record.id}`,
      slot: "in_progress",
      summary: zhText(
        serverText("worktree.created", { branch: record.branch, path: record.path }),
      ).slice(0, 500),
      repo: path.basename(record.repo),
      branch: record.branch,
      claim: { repo: record.repo, branch: record.branch },
    });
    if (board.changed) this.options.onBoardChanged?.(record.roomId);
  }

  private bind(record: ManagedWorktree, invocationIds: string[]): void {
    const statement = this.options.database.connection().prepare(
      `INSERT INTO managed_worktree_bindings (invocation_id, worktree_id) VALUES (?, ?)
       ON CONFLICT(invocation_id) DO UPDATE SET worktree_id = excluded.worktree_id`,
    );
    for (const id of invocationIds) statement.run(id, record.id);
  }

  private removedRecords(repo?: string): RemovedWorktree[] {
    return (
      this.options.database
        .connection()
        .prepare(
          "SELECT record FROM managed_worktree_removals WHERE (? IS NULL OR repo = ?) ORDER BY rowid DESC",
        )
        .all(repo ?? null, repo ?? null) as Array<{ record: string }>
    ).map((row) => ({ ...managedWorktreeSchema.parse(JSON.parse(row.record)), removed: true }));
  }

  confirmedRemoval(actor: Participant, invocationIds: string[]): RemovedWorktree | undefined {
    return this.removedRecords().find(
      (record) =>
        record.roomId === actor.roomId &&
        record.agentName === actor.username &&
        invocationIds.some((id) => record.invocationIds.includes(id)),
    );
  }

  private finishRemoval(record: ManagedWorktree, missing = false): RemovedWorktree {
    this.invalidate(record.id);
    this.options.database.connection().transaction(() => {
      this.options.database
        .connection()
        .prepare("INSERT INTO managed_worktree_removals (id, repo, record) VALUES (?, ?, ?)")
        .run(record.id, record.repo, JSON.stringify(record));
      this.options.database
        .connection()
        .prepare("DELETE FROM managed_worktree_focus WHERE worktree_id = ?")
        .run(record.id);
      this.options.database
        .connection()
        .prepare("DELETE FROM managed_worktree_bindings WHERE worktree_id = ?")
        .run(record.id);
      this.options.database
        .connection()
        .prepare("DELETE FROM managed_worktrees WHERE id = ?")
        .run(record.id);
      const summary = zhText(
        serverText(missing ? "worktree.missingReleased" : "worktree.cleaned", {
          path: record.path,
        }),
      );
      this.options.database
        .connection()
        .prepare(
          // updated_at 是白板归档/清空的版本号：状态变了就得跟着变
          "UPDATE whiteboard_entries SET slot = 'milestone', summary = ?, updated_at = ? WHERE key = ? AND claim_repo = ? AND claim_branch = ?",
        )
        .run(
          summary,
          new Date().toISOString(),
          `worktree:${record.id}`,
          record.repo,
          record.branch,
        );
    })();
    this.options.onBoardChanged?.(record.roomId);
    this.pruneCleanupBatches();
    return { ...record, removed: true };
  }

  async runtimeWorkspace(
    workspace: string,
    actor: Participant,
    ownerName: string,
    invocationId: string,
  ): Promise<ManagedWorktree | RemovedWorktree | FocusDropped | undefined> {
    return (await this.runtimeWorkspaces(workspace, actor, [{ ownerName, invocationId }])).get(
      invocationId,
    );
  }

  async runtimeWorkspaces(
    workspace: string,
    actor: Participant,
    tasks: Array<{ ownerName: string; invocationId: string; ancestorIds?: string[] }>,
  ): Promise<Map<string, ManagedWorktree | RemovedWorktree | FocusDropped | undefined>> {
    const binding = this.options.database
      .connection()
      .prepare("SELECT worktree_id FROM managed_worktree_bindings WHERE invocation_id = ?");
    const focus = this.options.database
      .connection()
      .prepare(
        "SELECT worktree_id FROM managed_worktree_focus WHERE room_id = ? AND agent_name = ?",
      )
      .get(actor.roomId, actor.username) as { worktree_id: string } | undefined;
    const selections = tasks.map((task) => {
      const bound = binding.get(task.invocationId) as { worktree_id: string } | undefined;
      return { ...task, bound, selected: bound ?? focus };
    });
    const result = new Map<string, ManagedWorktree | RemovedWorktree | FocusDropped | undefined>(
      tasks.map((task) => [task.invocationId, undefined]),
    );
    if (
      !selections.some((task) => task.selected) &&
      !this.confirmedRemoval(
        actor,
        tasks.flatMap((task) => [task.invocationId, ...(task.ancestorIds ?? [])]),
      )
    )
      return result;
    const repository = await worktreeRepository(workspace);
    return this.serial(repository.repo, "runtimeWorkspaces", async () => {
      const records = new Map(this.records(repository.repo).map((record) => [record.id, record]));
      const removed = this.removedRecords(repository.repo);
      const occupants = new Map<ManagedWorktree, string[]>();
      // 只是沿用「上次用的任务目录」（没绑定、也不是接着上游的那条）选中的任务
      const viaFocus = new Set<string>();
      for (const task of selections) {
        const previous = removed.find(
          (record) =>
            record.agentName === actor.username &&
            record.roomId === actor.roomId &&
            [task.invocationId, ...(task.ancestorIds ?? [])].some((id) =>
              record.invocationIds.includes(id),
            ),
        );
        const inherited = previous
          ? (task.ancestorIds ?? [])
              .map((id) => {
                const bound = binding.get(id) as { worktree_id: string } | undefined;
                return bound ? records.get(bound.worktree_id) : undefined;
              })
              .find(
                (record) => record?.agentName === actor.username && record.roomId === actor.roomId,
              )
          : undefined;
        const record =
          (task.bound ? records.get(task.bound.worktree_id) : undefined) ??
          inherited ??
          previous ??
          (task.selected ? records.get(task.selected.worktree_id) : undefined);
        if (!record) {
          if (
            !task.bound &&
            task.selected &&
            removed.some(
              (item) =>
                item.id === task.selected!.worktree_id &&
                item.ownerName === task.ownerName &&
                item.agentName === actor.username &&
                item.roomId === actor.roomId,
            )
          )
            continue;
          if (task.selected)
            throw new HiveError(
              "WORKTREE_IDENTITY",
              serverText("error.worktree.identity", { path: task.selected.worktree_id }),
            );
          continue;
        }
        if (
          record.ownerName !== task.ownerName ||
          record.agentName !== actor.username ||
          record.roomId !== actor.roomId
        )
          throw new HiveError(
            "WORKTREE_UNSAFE",
            serverText("error.worktree.unsafe", { path: record.path }),
          );
        if (!task.bound && !inherited && !previous) viaFocus.add(task.invocationId);
        if ("removed" in record) result.set(task.invocationId, record);
        else occupants.set(record, [...(occupants.get(record) ?? []), task.invocationId]);
      }
      const missing = new Set<ManagedWorktree>();
      const stale = new Map<ManagedWorktree, string>();
      for (const record of occupants.keys()) {
        if (await this.missingCheckout(record, repository.target)) {
          if (
            this.options
              .activeInvocations(record)
              .some((id) => !tasks.some((task) => task.invocationId === id))
          )
            throw new HiveError(
              "WORKTREE_UNSAFE",
              serverText("error.worktree.unsafe", { path: record.path }),
            );
          missing.add(record);
        } else {
          if (record.phase !== "ready")
            throw new HiveError(
              "WORKTREE_UNSAFE",
              serverText("error.worktree.unsafe", { path: record.path }),
            );
          try {
            await this.identity(record);
          } catch (error) {
            if (!(error instanceof WorktreeIdentityError)) throw error;
            if (error.switched) this.markSwitched(record, error.switched.current);
            // 绑定在这个目录上的任务照旧失败，原因写清楚。只是沿用「上次用的任务目录」的新任务不再被它卡住
            // （否则这个 Agent 之后每次派活都会失败）：去掉这个默认选择，并把原因带给 Agent，不静默落到默认目录
            if (!occupants.get(record)!.every((id) => viaFocus.has(id))) throw error;
            stale.set(record, error.message);
          }
        }
      }
      for (const [record, reason] of stale) {
        for (const id of occupants.get(record)!)
          result.set(id, this.dropFocus(actor, record, reason));
        occupants.delete(record);
      }
      for (const [record, ids] of occupants) {
        if (missing.has(record)) {
          if (
            !(await this.missingCheckout(record, repository.target)) ||
            this.options
              .activeInvocations(record)
              .some((id) => !tasks.some((task) => task.invocationId === id))
          )
            throw new HiveError(
              "WORKTREE_IDENTITY",
              serverText("error.worktree.identity", { path: record.path }),
            );
          const released = this.finishRemoval(record, true);
          for (const id of ids) {
            const task = selections.find((task) => task.invocationId === id)!;
            if (
              task.bound ||
              [id, ...(task.ancestorIds ?? [])].some((ancestor) =>
                record.invocationIds.includes(ancestor),
              )
            )
              result.set(id, released);
          }
          continue;
        }
        record.invocationIds = [...new Set([...record.invocationIds, ...ids])];
        this.save(record);
        this.bind(record, ids);
        for (const id of ids) result.set(id, record);
      }
      return result;
    });
  }

  /**
   * 仓库级写锁：同一仓库的建、删、选目录一个一个来。排队和持有的时长合起来超过阈值就记一条慢操作，
   * 看得出是谁占着锁、别人等了多久。
   */
  private async serial<Result>(
    repo: string,
    name: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.queues.get(repo) ?? Promise.resolve();
    const queued = performance.now();
    let acquired: number | undefined;
    const next = previous
      .catch(() => undefined)
      .then(() => {
        acquired = performance.now();
        return operation();
      });
    this.queues.set(repo, next);
    let failed = false;
    try {
      return await next;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (this.queues.get(repo) === next) this.queues.delete(repo);
      const released = performance.now();
      slowOps.record({
        kind: "lock",
        name: `worktrees.lock ${name}`,
        waitMs: (acquired ?? released) - queued,
        durationMs: acquired === undefined ? 0 : released - acquired,
        repo,
        ...(failed ? { failed } : {}),
      });
    }
  }

  async create(
    workspace: string,
    actor: Participant,
    ownerName: string,
    invocationIds: string[],
    input: CreateWorktreeRequest,
  ): Promise<{ worktree: ManagedWorktree; reused: boolean }> {
    this.assertWritable();
    input = createWorktreeRequestSchema.parse(input);
    const repository = await worktreeRepository(workspace);
    return this.serial(repository.repo, "create", async () => {
      const existing = this.records(repository.repo).find(
        (record) => record.agentName === actor.username && record.slug === input.slug,
      );
      if (existing) {
        if (
          existing.roomId !== actor.roomId ||
          existing.ownerName !== ownerName ||
          (input.branch && existing.branch !== input.branch) ||
          (input.base && existing.base !== input.base)
        ) {
          throw new HiveError(
            "WORKTREE_CONFLICT",
            serverText("error.worktree.conflict", { path: existing.path }),
          );
        }
        return this.writing(existing.id, async () => {
          try {
            await this.identity(existing);
          } catch (error) {
            if (!(error instanceof WorktreeIdentityError) || !error.switched) throw error;
            this.markSwitched(existing, error.switched.current);
            throw new WorktreeIdentityError(
              serverText("error.worktree.reuseSwitched", {
                slug: existing.slug,
                path: existing.path,
                branch: existing.branch,
                current: error.switched.current,
              }),
              error.switched,
            );
          }
          existing.phase = "ready";
          existing.invocationIds = [...new Set([...existing.invocationIds, ...invocationIds])];
          const board = this.options.database.upsertWhiteboardEntry(actor, {
            key: `worktree:${existing.id}`,
            slot: "in_progress",
            summary: zhText(
              serverText("worktree.created", { branch: existing.branch, path: existing.path }),
            ).slice(0, 500),
            repo: path.basename(existing.repo),
            branch: existing.branch,
            claim: { repo: existing.repo, branch: existing.branch },
          });
          this.save(existing);
          this.focus(existing);
          this.bind(existing, invocationIds);
          if (board.changed) this.options.onBoardChanged?.(actor.roomId);
          return { worktree: existing, reused: true };
        });
      }
      const agentSlug = actor.username
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_.-]/gu, "-")
        .replace(/^-+|-+$/g, "");
      if (!agentSlug)
        throw new HiveError(
          "WORKTREE_INVALID_REF",
          serverText("error.worktree.invalidRef", { ref: actor.username }),
        );
      const branch = input.branch ?? `feat/${agentSlug}-${input.slug}`;
      await validateBranch(repository.repo, branch);
      const base = input.base ?? repository.target;
      const baseCommit = await commit(
        repository.repo,
        input.base ?? `refs/heads/${repository.target}`,
      );
      const root = path.join(path.dirname(repository.repo), `${path.basename(repository.repo)}-wt`);
      await mkdir(root, { recursive: true });
      if ((await realpath(root)) !== root)
        throw new HiveError(
          "WORKTREE_IDENTITY",
          serverText("error.worktree.identity", { path: root }),
        );
      const worktreePath = path.join(root, `${agentSlug}-${input.slug}`);
      const present = await lstat(worktreePath).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return false;
        },
      );
      if (present || (await branchExists(repository.repo, branch))) {
        throw new HiveError(
          "WORKTREE_CONFLICT",
          serverText("error.worktree.conflict", { path: worktreePath }),
        );
      }
      const record: ManagedWorktree = {
        ...repository,
        id: randomUUID(),
        path: worktreePath,
        branch,
        base,
        baseCommit,
        slug: input.slug,
        roomId: actor.roomId,
        agentName: actor.username,
        ownerName,
        invocationIds,
        createdAt: new Date().toISOString(),
        phase: "creating",
      };
      return this.writing(record.id, async () => {
        this.options.database.connection().transaction(() => {
          this.options.database.assertBranchClaimAvailable(repository.repo, branch);
          this.options.database
            .connection()
            .prepare(
              `INSERT INTO managed_worktrees
          (id, repo, agent_name, slug, path, branch, record) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              record.id,
              record.repo,
              record.agentName,
              record.slug,
              record.path,
              record.branch,
              JSON.stringify(record),
            );
          this.options.database.upsertWhiteboardEntry(actor, {
            key: `worktree:${record.id}`,
            slot: "in_progress",
            summary: zhText(
              serverText("worktree.created", { branch: record.branch, path: record.path }),
            ).slice(0, 500),
            repo: path.basename(record.repo),
            branch,
            claim: { repo: record.repo, branch },
          });
        })();
        this.options.onBoardChanged?.(actor.roomId);
        try {
          await git(repository.repo, [
            "worktree",
            "add",
            "-b",
            branch,
            "--",
            worktreePath,
            baseCommit,
          ]);
          await this.identity(record);
          record.phase = "ready";
          this.focus(record);
          this.bind(record, invocationIds);
          this.save(record);
          return { worktree: record, reused: false };
        } catch (error) {
          record.phase = "error";
          this.save(record);
          throw error;
        }
      });
    });
  }

  /** 任务目录还是登记的那一个：路径、仓库、分支都对得上。对不上时说清楚是哪一种 */
  private async identity(record: ManagedWorktree): Promise<void> {
    const params = { path: record.path, branch: record.branch };
    const stat = await lstat(record.path).catch(() => undefined);
    if (!stat?.isDirectory() && !stat?.isSymbolicLink())
      throw new WorktreeIdentityError(serverText("error.worktree.missingDirectory", params));
    if (stat.isSymbolicLink() || (await realpath(record.path)) !== record.path)
      throw new WorktreeIdentityError(serverText("error.worktree.replaced", params));
    const checkout = (await checkouts(record.repo)).find((item) => item.path === record.path);
    if (!checkout)
      throw new WorktreeIdentityError(serverText("error.worktree.notCheckout", params));
    const commonDir = await git(record.path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
      .then((output) => realpath(output.trim()))
      .catch((error: unknown) => {
        // 机器忙（git 超时）照旧抛出，可以稍后重试；目录里根本不是 Git 仓库就是被换掉了
        if (error instanceof HiveError && error.code === "WORKTREE_GIT_LIMIT") throw error;
        throw new WorktreeIdentityError(serverText("error.worktree.replaced", params));
      });
    if (commonDir !== record.commonDir)
      throw new WorktreeIdentityError(serverText("error.worktree.otherRepository", params));
    if (checkout.locked)
      throw new WorktreeIdentityError(serverText("error.worktree.locked", params));
    if (!checkout.branch)
      throw new WorktreeIdentityError(serverText("error.worktree.detached", params));
    // 最常见的：有人在任务目录里直接 git checkout/switch 到了别的分支
    if (checkout.branch !== record.branch)
      throw new WorktreeIdentityError(
        serverText("error.worktree.branchChanged", { ...params, current: checkout.branch }),
        { registered: record.branch, current: checkout.branch },
      );
  }

  private async missingCheckout(record: ManagedWorktree, expectedTarget: string): Promise<boolean> {
    const present = await lstat(record.path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (present) return false;
    const repository = await worktreeRepository(record.repo);
    if (
      repository.repo !== record.repo ||
      repository.commonDir !== record.commonDir ||
      repository.target !== expectedTarget ||
      record.target !== expectedTarget
    )
      throw new HiveError(
        "WORKTREE_IDENTITY",
        serverText("error.worktree.identity", { path: record.path }),
      );
    return (
      !(await checkouts(record.repo)).some((checkout) => checkout.path === record.path) &&
      !(await branchExists(record.repo, record.branch))
    );
  }

  private async merged(
    record: ManagedWorktree,
  ): Promise<{ merged: boolean; mergeMethod?: WorktreeStatus["mergeMethod"] }> {
    const tip = await commit(record.repo, `refs/heads/${record.branch}`);
    const target = await commit(record.repo, `refs/heads/${record.target}`);
    const key = `${record.repo}\0${tip}\0${target}`;
    const known = this.mergeCache.get(key);
    if (known) return known;
    const result = await slowOps.track("worktrees.merged", { repo: record.path }, () =>
      this.mergedBetween(record, tip, target),
    );
    if (this.mergeCache.size >= MERGE_CACHE_LIMIT)
      this.mergeCache.delete(this.mergeCache.keys().next().value!);
    this.mergeCache.set(key, result);
    return result;
  }

  private async mergedBetween(
    record: ManagedWorktree,
    tip: string,
    target: string,
  ): Promise<{ merged: boolean; mergeMethod?: WorktreeStatus["mergeMethod"] }> {
    const ancestor = await worktreeGit(record.repo, ["merge-base", "--is-ancestor", tip, target]);
    if (ancestor.code === 0) return { merged: true, mergeMethod: "ancestor" };
    if (ancestor.code !== 1) await git(record.repo, ["merge-base", "--is-ancestor", tip, target]);
    const fork = (await git(record.repo, ["merge-base", tip, target])).trim();
    const cherry = (await git(record.repo, ["cherry", target, tip]))
      .trim()
      .split("\n")
      .filter(Boolean);
    const merges = (await git(record.repo, ["rev-list", "--merges", `${fork}..${tip}`])).trim();
    if (!merges && cherry.length > 0 && cherry.every((line) => line.startsWith("- "))) {
      return { merged: true, mergeMethod: "patches" };
    }
    const diff = await git(record.repo, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      fork,
      tip,
      "--",
    ]);
    const patch = (await git(record.repo, ["patch-id", "--stable"], diff)).trim().split(" ")[0];
    if (!patch) return { merged: false };
    const history = (
      await git(record.repo, [
        "rev-list",
        "--first-parent",
        "--max-count=500",
        `${fork}..${target}`,
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const revision of history) {
      const parent = await commit(record.repo, `${revision}^1`);
      const change = await git(record.repo, [
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        parent,
        revision,
        "--",
      ]);
      const candidate = (await git(record.repo, ["patch-id", "--stable"], change))
        .trim()
        .split(" ")[0];
      if (candidate === patch) return { merged: true, mergeMethod: "squash" };
    }
    return { merged: false };
  }

  async status(record: ManagedWorktree, expectedTarget = record.target): Promise<WorktreeStatus> {
    return slowOps.track("worktrees.status", { repo: record.path }, () =>
      this.inspect(record, expectedTarget),
    );
  }

  private async inspect(record: ManagedWorktree, expectedTarget: string): Promise<WorktreeStatus> {
    const activeInvocationIds = this.options.activeInvocations(record);
    try {
      if (record.target !== expectedTarget)
        throw new HiveError(
          "WORKTREE_IDENTITY",
          serverText("error.worktree.identity", { path: record.path }),
        );
      if (await this.missingCheckout(record, expectedTarget))
        return {
          worktree: record,
          dirty: false,
          untracked: false,
          ignored: false,
          merged: false,
          missing: true,
          activeInvocationIds,
          removable: activeInvocationIds.length === 0,
        };
      await this.identity(record);
      const { dirty, untracked } = await this.changes(record.path);
      const ignored = Boolean(
        (await git(record.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]))
          .length,
      );
      const merged = await this.merged(record);
      return {
        worktree: record,
        dirty,
        untracked,
        ignored,
        headCommit: await commit(record.repo, `refs/heads/${record.branch}`),
        ...merged,
        activeInvocationIds,
        removable:
          !dirty && !untracked && !ignored && merged.merged && activeInvocationIds.length === 0,
      };
    } catch (error) {
      const switched = error instanceof WorktreeIdentityError ? error.switched : undefined;
      // 只是换了分支：目录本身是好的，照常看有没有未提交的文件（房主据此判断能不能切回）
      const changes = switched ? await this.changes(record.path).catch(() => undefined) : undefined;
      return {
        worktree: record,
        dirty: changes?.dirty ?? false,
        untracked: changes?.untracked ?? false,
        ignored: false,
        merged: false,
        activeInvocationIds,
        removable: false,
        error: error instanceof Error ? error.message : String(error),
        ...(switched ? { branchSwitched: switched } : {}),
      };
    }
  }

  private async changes(directory: string): Promise<{ dirty: boolean; untracked: boolean }> {
    const entries = (
      await git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    )
      .split("\0")
      .filter(Boolean);
    return {
      dirty: entries.some((entry) => !entry.startsWith("?? ")),
      untracked: entries.some((entry) => entry.startsWith("?? ")),
    };
  }

  /**
   * 列出任务线状态。只读，不进写锁：建、删、选目录不会排在这一长串 git 检查后面（#3944：
   * 一次扫 17 条约 110 秒，期间 Agent 开工前选目录全部超时）。读到的可能是写操作进行中的
   * 中间状态，所以正在建/删的一律不算可清理；真正删除时 remove() 会在写锁里重新确认。
   */
  async list(workspace: string): Promise<WorktreeStatus[]> {
    const repository = await worktreeRepository(workspace);
    return slowOps.track("worktrees.list", { repo: repository.repo }, () =>
      this.listIn(repository),
    );
  }

  private async listIn(repository: Repository): Promise<WorktreeStatus[]> {
    const records = this.records(repository.repo);
    // 一次读出所有分支的提交，用来判断缓存是否还对得上（比逐条 rev-parse 省得多）
    const tips = new Map(
      (
        await git(repository.repo, [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)",
          "refs/heads/",
        ])
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\0") as [string, string]),
    );
    const statuses: Array<WorktreeStatus | undefined> = Array.from({ length: records.length });
    let next = 0;
    const worker = async () => {
      while (next < records.length) {
        const index = next++;
        const record = records[index]!;
        const fingerprint = [
          repository.target,
          tips.get(`refs/heads/${record.branch}`) ?? "",
          tips.get(`refs/heads/${repository.target}`) ?? "",
        ].join("\0");
        statuses[index] = await this.cachedStatus(record, repository.target, fingerprint);
      }
    };
    await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, records.length) }, worker));
    const current = new Map(this.records(repository.repo).map((record) => [record.id, record]));
    const result = statuses
      .filter((status): status is WorktreeStatus => Boolean(status))
      .flatMap((status) => {
        // 检查期间被删掉的不再列出；记录本身（阶段、绑定的任务）以最新的为准
        const record = current.get(status.worktree.id);
        return record ? [this.live(status, record)] : [];
      });
    this.pruneCleanupBatches(result);
    return result;
  }

  /** 缓存里的 git 检查结果配上最新的记录和正在执行的任务，重新判断能不能清理 */
  private live(status: WorktreeStatus, record: ManagedWorktree): WorktreeStatus {
    const activeInvocationIds = this.options.activeInvocations(record);
    const idle = activeInvocationIds.length === 0;
    const clean = status.missing
      ? true
      : !status.error && !status.dirty && !status.untracked && !status.ignored && status.merged;
    return {
      ...status,
      worktree: record,
      activeInvocationIds,
      removable: clean && idle && !this.writes.has(record.id),
    };
  }

  private invalidate(id: string): void {
    this.statusEpochs.set(id, (this.statusEpochs.get(id) ?? 0) + 1);
    this.statusCache.delete(id);
  }

  /** 在写锁里改动一条任务线：前后都作废它的状态缓存，进行中的只读检查结果也不会被留下 */
  private async writing<Result>(id: string, operation: () => Promise<Result>): Promise<Result> {
    this.writes.set(id, (this.writes.get(id) ?? 0) + 1);
    this.invalidate(id);
    try {
      return await operation();
    } finally {
      const left = (this.writes.get(id) ?? 1) - 1;
      if (left > 0) this.writes.set(id, left);
      else this.writes.delete(id);
      this.invalidate(id);
    }
  }

  private async cachedStatus(
    record: ManagedWorktree,
    expectedTarget: string,
    fingerprint: string,
  ): Promise<WorktreeStatus> {
    const ttl = this.options.statusCacheMs ?? 15_000;
    const cached = this.statusCache.get(record.id);
    if (cached && cached.fingerprint === fingerprint && Date.now() - cached.at < ttl)
      return this.live(cached.status, record);
    // 同一时刻几个人同时打开列表：同一条任务线只检查一次，大家共用结果
    const key = `${record.id}\0${fingerprint}`;
    const pending = this.statusInflight.get(key);
    if (pending) return this.live(await pending, record);
    const epoch = this.statusEpochs.get(record.id) ?? 0;
    const started = Date.now();
    const running = this.status(record, expectedTarget);
    this.statusInflight.set(key, running);
    try {
      const status = await running;
      // 检查期间有写操作（建、删）碰过这条任务线，结果可能是中间状态，不留给后面的人用
      if (
        ttl > 0 &&
        (this.statusEpochs.get(record.id) ?? 0) === epoch &&
        !this.writes.has(record.id)
      )
        this.statusCache.set(record.id, { status, at: started, fingerprint });
      return this.live(status, record);
    } finally {
      if (this.statusInflight.get(key) === running) this.statusInflight.delete(key);
    }
  }

  /**
   * 房主修好「被换了分支」的任务目录：
   * - restore：在目录里切回登记的分支。只在工作区干净（没有未提交、未跟踪的文件）时做，免得把改动带过去或弄丢；
   * - adopt：按目录现在的分支重新登记。新分支不能已被别的任务线登记或占用。
   * 两种都要等绑定在这个目录上的任务全部结束，免得 Agent 正在里面干活时目录变了。
   */
  async repair(
    workspace: string,
    id: string,
    action: "restore" | "adopt",
  ): Promise<WorktreeStatus> {
    this.assertWritable();
    const repository = await worktreeRepository(workspace);
    return this.serial(repository.repo, `repair ${action}`, async () => {
      const record = this.records(repository.repo).find((item) => item.id === id);
      if (!record)
        throw new HiveError(
          "WORKTREE_UNREGISTERED",
          serverText("error.worktree.unregistered", { path: id }),
        );
      return this.writing(record.id, async () => {
        const status = await this.status(record, repository.target);
        const switched = status.branchSwitched;
        if (!switched)
          throw new HiveError(
            "WORKTREE_NOT_SWITCHED",
            serverText("error.worktree.notSwitched", { path: record.path }),
          );
        const active = this.options.activeInvocations(record);
        if (active.length)
          throw new HiveError(
            "WORKTREE_BUSY",
            serverText("error.worktree.repairBusy", { path: record.path, count: active.length }),
          );
        if (action === "restore") {
          const changes = await this.changes(record.path);
          if (changes.dirty || changes.untracked)
            throw new HiveError(
              "WORKTREE_DIRTY",
              serverText("error.worktree.restoreDirty", {
                path: record.path,
                branch: record.branch,
              }),
            );
          const elsewhere = (await checkouts(record.repo)).some(
            (item) => item.branch === record.branch && item.path !== record.path,
          );
          if (elsewhere || !(await branchExists(record.repo, record.branch)))
            throw new HiveError(
              "WORKTREE_BRANCH_GONE",
              serverText("error.worktree.restoreBranchGone", { branch: record.branch }),
            );
          await validateBranch(record.repo, record.branch);
          // 分支名已核对过合法、存在、不以 - 开头
          await git(record.path, ["switch", "--no-guess", record.branch]);
        } else {
          const branch = switched.current;
          await validateBranch(record.repo, branch);
          const taken = this.records(record.repo).some(
            (item) => item.id !== record.id && item.branch === branch,
          );
          if (taken)
            throw new HiveError(
              "WORKTREE_CLAIM_CONFLICT",
              serverText("error.worktree.adoptTaken", { branch, path: record.path }),
            );
          try {
            this.options.database.assertBranchClaimAvailable(
              record.repo,
              branch,
              (
                this.options.database
                  .connection()
                  .prepare("SELECT id FROM whiteboard_entries WHERE room_id = ? AND key = ?")
                  .get(record.roomId, `worktree:${record.id}`) as { id: string } | undefined
              )?.id,
            );
          } catch {
            throw new HiveError(
              "WORKTREE_CLAIM_CONFLICT",
              serverText("error.worktree.adoptTaken", { branch, path: record.path }),
            );
          }
          const previous = record.branch;
          record.branch = branch;
          this.options.database
            .connection()
            .prepare("UPDATE managed_worktrees SET branch = ?, record = ? WHERE id = ?")
            .run(branch, JSON.stringify(record), record.id);
          this.options.audit?.(
            `任务目录 ${record.path} 按当前分支重新登记：${previous} → ${branch}`,
            {
              roomId: record.roomId,
              agentName: record.agentName,
              worktreeId: record.id,
            },
          );
        }
        await this.identity(record);
        this.markRegistered(record);
        return this.status(record, repository.target);
      });
    });
  }

  async remove(
    workspace: string,
    input: { path: string; deleteBranch?: boolean; expectedCommit?: string },
  ): Promise<{ removed: true; branchDeleted: boolean; branchError?: string }> {
    this.assertWritable();
    const repository = await worktreeRepository(workspace);
    return this.serial(repository.repo, "remove", async () => {
      const record = this.records(repository.repo).find((item) => item.path === input.path);
      if (!record)
        throw new HiveError(
          "WORKTREE_UNREGISTERED",
          serverText("error.worktree.unregistered", { path: input.path }),
        );
      return this.writing(record.id, async () => {
        const status = await this.status(record, repository.target);
        if (!status.removable)
          throw new HiveError(
            "WORKTREE_UNSAFE",
            serverText("error.worktree.unsafe", { path: input.path }),
          );
        if (status.missing) {
          if (
            input.expectedCommit ||
            !(await this.missingCheckout(record, repository.target)) ||
            this.options.activeInvocations(record).length
          )
            throw new HiveError(
              "WORKTREE_UNSAFE",
              serverText("error.worktree.unsafe", { path: record.path }),
            );
          this.finishRemoval(record, true);
          return { removed: true, branchDeleted: true };
        }
        const tip = await commit(record.repo, `refs/heads/${record.branch}`);
        if (input.expectedCommit && tip !== input.expectedCommit)
          throw new HiveError(
            "WORKTREE_UNSAFE",
            serverText("error.worktree.unsafe", { path: record.path }),
          );
        record.phase = "removing";
        this.save(record);
        try {
          await this.identity(record);
          if (
            this.options.activeInvocations(record).length !== 0 ||
            (await commit(record.repo, `refs/heads/${record.branch}`)) !== tip
          ) {
            throw new HiveError(
              "WORKTREE_UNSAFE",
              serverText("error.worktree.unsafe", { path: record.path }),
            );
          }
          await git(record.repo, ["worktree", "remove", "--", record.path]);
        } catch (error) {
          record.phase = "error";
          this.save(record);
          throw error;
        }
        let branchDeleted = false;
        let branchError: string | undefined;
        if (input.deleteBranch !== false) {
          try {
            if ((await commit(record.repo, `refs/heads/${record.branch}`)) !== tip) {
              branchError = zhText(serverText("error.worktree.identity", { path: record.path }));
            } else {
              const deletion = await worktreeGit(record.repo, [
                "branch",
                "-d",
                "--",
                record.branch,
              ]);
              branchDeleted = deletion.code === 0;
              if (!branchDeleted)
                branchError = zhText(
                  serverText("error.worktree.branchRetained", { branch: record.branch }),
                );
            }
          } catch (error) {
            branchError = error instanceof Error ? error.message : String(error);
          }
        }
        this.finishRemoval(record);
        return { removed: true, branchDeleted, ...(branchError ? { branchError } : {}) };
      });
    });
  }
}
