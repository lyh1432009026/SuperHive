import { z } from "zod";

/**
 * Claude Code 的上下文设置：自动压缩阈值和缓存时长，只对 Claude Agent 生效。
 *
 * 本机实测 Claude Code 2.1.330（--print、stream-json 输入输出、常驻进程）：
 * - 两项都经 `--settings '{"autoCompactWindow":200000,"promptCacheTtl":"1h"}'` 传入生效，多个 --settings 会合并。
 * - autoCompactWindow 至少 10 万 token；上下文接近这个大小时（实测 20 万的阈值在 17 万处压缩），在下一次请求前自动压缩，
 *   --resume 接上、常驻进程里一轮接一轮都会触发，压缩后会话照常 --resume。
 *   压缩时输出 system/status（compacting）和 system/compact_boundary（pre_tokens、post_tokens、duration_ms）。
 * - promptCacheTtl 不设时 Claude Code 自动选：订阅额度内一般 1 小时，超出额度、API key、Bedrock 等是 5 分钟，
 *   同一台机器、同一个模型也会两种都出现；指定 "5m" / "1h" 后每次请求都按指定的写缓存。
 */

/**
 * 没设过（老 Agent、新建的 Agent）时用的压缩阈值。所选模型的上下文窗口比它小时，Claude Code 按模型上限处理
 * （「capped to model limit」），接近上限时压缩，不会因为超出上限报错。
 */
export const CLAUDE_COMPACT_WINDOW_DEFAULT = 400_000;
/** Claude Code 接受的最小阈值，再小它会当成 10 万 */
export const CLAUDE_COMPACT_WINDOW_MIN = 100_000;
/** 上限给到 200 万：超过模型自己的上下文上限时 Claude Code 会按模型上限压缩 */
export const CLAUDE_COMPACT_WINDOW_MAX = 2_000_000;
/** 设置里列出的常用档位 */
export const CLAUDE_COMPACT_WINDOW_PRESETS = [200_000, 400_000, 600_000, 800_000] as const;

/**
 * 自动压缩阈值：token 数，或 "auto" 表示不传、交给 Claude Code 自己定（1M 上下文的模型接近上限才压缩）。
 */
export const claudeCompactWindowSchema = z.union([
  z.literal("auto"),
  z.number().int().min(CLAUDE_COMPACT_WINDOW_MIN).max(CLAUDE_COMPACT_WINDOW_MAX),
]);
export type ClaudeCompactWindow = z.infer<typeof claudeCompactWindowSchema>;

/** 缓存时长：不设（null）就不传，由 Claude Code 自动选 */
export const claudeCacheTtlSchema = z.enum(["5m", "1h"]);
export type ClaudeCacheTtl = z.infer<typeof claudeCacheTtlSchema>;

/** 这个运行时能不能设压缩阈值和缓存时长 */
export function supportsClaudeContextSettings(provider: string): boolean {
  return provider === "claude";
}

/** 一次自动压缩：压缩前后的上下文大小 */
export const contextCompactionSchema = z.object({
  preTokens: z.number().int().min(0).max(100_000_000),
  postTokens: z.number().int().min(0).max(100_000_000).optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
});
export type ContextCompaction = z.infer<typeof contextCompactionSchema>;
