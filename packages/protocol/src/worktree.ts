import { z } from "zod";

export const worktreeClaimSchema = z.object({
  repo: z.string().trim().min(1).max(4096),
  branch: z.string().trim().min(1).max(200),
});

export const createWorktreeRequestSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  base: z.string().trim().min(1).max(200).optional(),
  branch: z.string().trim().min(1).max(200).optional(),
});

export const removeWorktreeRequestSchema = z.object({
  path: z.string().min(1).max(4096),
  deleteBranch: z.boolean().default(true),
});

export const managedWorktreeSchema = z.object({
  id: z.string().uuid(),
  repo: z.string(),
  commonDir: z.string(),
  path: z.string(),
  branch: z.string(),
  base: z.string(),
  baseCommit: z.string(),
  target: z.string(),
  slug: z.string(),
  roomId: z.string(),
  agentName: z.string(),
  ownerName: z.string(),
  invocationIds: z.array(z.string().uuid()),
  createdAt: z.string().datetime(),
  phase: z.enum(["creating", "ready", "removing", "error"]),
});

/**
 * 新任务目录的依赖准备情况：installed = 按锁文件装好；linked = 安装失败，退回软链主目录的依赖、
 * workspace 内部包指回本任务线；skipped = 不是 Node 项目或已有依赖；failed = 两种都不行，要自己处理。
 */
export const worktreeDependenciesSchema = z.object({
  state: z.enum(["preparing", "installed", "linked", "skipped", "failed"]),
  manager: z.enum(["pnpm", "npm", "yarn", "bun"]).optional(),
  command: z.string().optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  message: z.string().optional(),
  /** 安装命令输出的末尾一段，失败时用来看原因 */
  output: z.string().optional(),
});

export const worktreeStatusSchema = z.object({
  worktree: managedWorktreeSchema,
  dirty: z.boolean(),
  untracked: z.boolean(),
  ignored: z.boolean(),
  merged: z.boolean(),
  mergeMethod: z.enum(["ancestor", "patches", "squash"]).optional(),
  activeInvocationIds: z.array(z.string()),
  removable: z.boolean(),
  error: z.string().optional(),
  headCommit: z.string().optional(),
  missing: z.boolean().optional(),
  /** 有人在任务目录里换了分支（同一个 checkout，只是不在登记的分支上）：标出来，交给房主处理 */
  branchSwitched: z.object({ registered: z.string(), current: z.string() }).optional(),
  dependencies: worktreeDependenciesSchema.optional(),
});

/** 房主对「被换了分支」的任务目录能做的两个安全操作 */
export const repairWorktreeRequestSchema = z.object({
  action: z.enum(["restore", "adopt"]),
});

export const worktreeCleanupEventSchema = z.object({
  type: z.literal("worktree.cleanup"),
  roomId: z.string(),
  batchId: z.string().uuid(),
  count: z.number().int().nonnegative(),
  state: z.enum(["available", "completed", "expired"]),
  automatic: z.boolean(),
});

export type WorktreeClaim = z.infer<typeof worktreeClaimSchema>;
export type CreateWorktreeRequest = z.infer<typeof createWorktreeRequestSchema>;
export type ManagedWorktree = z.infer<typeof managedWorktreeSchema>;
export type WorktreeStatus = z.infer<typeof worktreeStatusSchema>;
export type RepairWorktreeRequest = z.infer<typeof repairWorktreeRequestSchema>;
export type WorktreeDependencies = z.infer<typeof worktreeDependenciesSchema>;
