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
  type WorktreeStatus,
} from "@superhive/protocol";
import { HiveDatabase, HiveError } from "./database.js";

type GitResult = { code: number; stdout: string; stderr: string };
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
    throw new HiveError(
      "WORKTREE_REPOSITORY_INVALID",
      serverText("error.worktree.repository", {
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export class WorktreeManager {
  private readonly queues = new Map<string, Promise<unknown>>();
  private scanning: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly options: {
      database: HiveDatabase;
      activeInvocations: (worktree: ManagedWorktree) => string[];
      onBoardChanged?: (roomId: string) => void;
      onCleanup?: (batch: WorktreeCleanupBatch) => void;
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
    if (this.closed) return Promise.resolve();
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
      const status = await this.status(record);
      statuses.push(status);
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
  ): Promise<ManagedWorktree | RemovedWorktree | undefined> {
    return (await this.runtimeWorkspaces(workspace, actor, [{ ownerName, invocationId }])).get(
      invocationId,
    );
  }

  async runtimeWorkspaces(
    workspace: string,
    actor: Participant,
    tasks: Array<{ ownerName: string; invocationId: string; ancestorIds?: string[] }>,
  ): Promise<Map<string, ManagedWorktree | RemovedWorktree | undefined>> {
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
    const result = new Map<string, ManagedWorktree | RemovedWorktree | undefined>(
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
    return this.serial(repository.repo, async () => {
      const records = new Map(this.records(repository.repo).map((record) => [record.id, record]));
      const removed = this.removedRecords(repository.repo);
      const occupants = new Map<ManagedWorktree, string[]>();
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
        if ("removed" in record) result.set(task.invocationId, record);
        else occupants.set(record, [...(occupants.get(record) ?? []), task.invocationId]);
      }
      const missing = new Set<ManagedWorktree>();
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
          await this.identity(record);
        }
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

  private async serial<Result>(repo: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.queues.get(repo) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.queues.set(repo, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(repo) === next) this.queues.delete(repo);
    }
  }

  async create(
    workspace: string,
    actor: Participant,
    ownerName: string,
    invocationIds: string[],
    input: CreateWorktreeRequest,
  ): Promise<{ worktree: ManagedWorktree; reused: boolean }> {
    input = createWorktreeRequestSchema.parse(input);
    const repository = await worktreeRepository(workspace);
    return this.serial(repository.repo, async () => {
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
        await this.identity(existing);
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
  }

  private async identity(record: ManagedWorktree): Promise<void> {
    const stat = await lstat(record.path).catch(() => undefined);
    const listed = await checkouts(record.repo);
    const checkout = listed.find((item) => item.path === record.path);
    if (
      !stat?.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(record.path)) !== record.path ||
      !checkout ||
      checkout.branch !== record.branch ||
      checkout.locked ||
      (await realpath(
        (
          await git(record.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        ).trim(),
      )) !== record.commonDir
    ) {
      throw new HiveError(
        "WORKTREE_IDENTITY",
        serverText("error.worktree.identity", { path: record.path }),
      );
    }
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
      const tracked = await git(record.path, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      const entries = tracked.split("\0").filter(Boolean);
      const untracked = entries.some((entry) => entry.startsWith("?? "));
      const dirty = entries.some((entry) => !entry.startsWith("?? "));
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
      return {
        worktree: record,
        dirty: false,
        untracked: false,
        ignored: false,
        merged: false,
        activeInvocationIds,
        removable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async list(workspace: string): Promise<WorktreeStatus[]> {
    const repository = await worktreeRepository(workspace);
    return this.serial(repository.repo, async () => {
      const statuses: WorktreeStatus[] = [];
      for (const record of this.records(repository.repo))
        statuses.push(await this.status(record, repository.target));
      this.pruneCleanupBatches(statuses);
      return statuses;
    });
  }

  async remove(
    workspace: string,
    input: { path: string; deleteBranch?: boolean; expectedCommit?: string },
  ): Promise<{ removed: true; branchDeleted: boolean; branchError?: string }> {
    const repository = await worktreeRepository(workspace);
    return this.serial(repository.repo, async () => {
      const record = this.records(repository.repo).find((item) => item.path === input.path);
      if (!record)
        throw new HiveError(
          "WORKTREE_UNREGISTERED",
          serverText("error.worktree.unregistered", { path: input.path }),
        );
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
            const deletion = await worktreeGit(record.repo, ["branch", "-d", "--", record.branch]);
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
  }
}
