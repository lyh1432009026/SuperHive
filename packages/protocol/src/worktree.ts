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
