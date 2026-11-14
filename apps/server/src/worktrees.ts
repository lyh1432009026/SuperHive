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

  constructor(
    private readonly options: {
      database: HiveDatabase;
      activeInvocations: (worktree: ManagedWorktree) => string[];
      onBoardChanged?: (roomId: string) => void;
    },
  ) {
    options.database.connection().exec(`CREATE TABLE IF NOT EXISTS managed_worktrees (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, agent_name TEXT NOT NULL, slug TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, record TEXT NOT NULL,
      UNIQUE(repo, agent_name, slug), UNIQUE(repo, branch)
    )`);
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
      return statuses;
    });
  }

  async remove(
    workspace: string,
    input: { path: string; deleteBranch?: boolean },
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
      const tip = await commit(record.repo, `refs/heads/${record.branch}`);
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
            if (!branchDeleted) branchError = deletion.stderr.trim();
          }
        } catch (error) {
          branchError = error instanceof Error ? error.message : String(error);
        }
      }
      this.options.database.connection().transaction(() => {
        this.options.database
          .connection()
          .prepare("DELETE FROM managed_worktrees WHERE id = ?")
          .run(record.id);
        this.options.database
          .connection()
          .prepare(
            "UPDATE whiteboard_entries SET slot = 'milestone' WHERE key = ? AND claim_repo = ? AND claim_branch = ?",
          )
          .run(`worktree:${record.id}`, record.repo, record.branch);
      })();
      this.options.onBoardChanged?.(record.roomId);
      return { removed: true, branchDeleted, ...(branchError ? { branchError } : {}) };
    });
  }
}
