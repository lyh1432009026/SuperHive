import { useEffect, useState } from "react";
import type { AgentContextStatus, Participant } from "@superhive/protocol";
import { t } from "./i18n";
import "./styles/member-context.css";
import { Tooltip } from "./tooltip";
import { formatTokens } from "./usage";

/** 实际生效的压缩阈值：设的阈值和模型上下文取小的（模型更小时 Claude Code 按模型上限压缩） */
export function effectiveCompactWindow(context: AgentContextStatus): number | undefined {
  const { compactWindow, contextWindow } = context;
  if (compactWindow && contextWindow) return Math.min(compactWindow, contextWindow);
  return compactWindow ?? undefined;
}

/** 缓存还剩几分钟（向下取整）；不知道有效期返回 undefined，已过期返回 0 */
export function cacheMinutesLeft(context: AgentContextStatus, now: number): number | undefined {
  if (!context.cacheExpiresAt) return undefined;
  const left = Date.parse(context.cacheExpiresAt) - now;
  return Number.isFinite(left) ? Math.max(0, Math.floor(left / 60_000)) : undefined;
}

/** 每 30 秒刷新一次「现在」，让缓存剩余时间跟着走 */
function useMinuteClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/** 悬停说明：上下文多大、离压缩还有多远、缓存大约什么时候过期 */
export function memberContextHint(context: AgentContextStatus, now: number): string {
  const lines = [t("上一轮结束时上下文 {0} token。", { 0: formatTokens(context.contextTokens) })];
  const window = effectiveCompactWindow(context);
  if (window !== undefined) {
    const capped =
      context.compactWindow !== undefined &&
      context.contextWindow !== undefined &&
      context.contextWindow < context.compactWindow;
    lines.push(
      context.contextTokens >= window
        ? t("已到自动压缩阈值 {0}，下一轮会先压缩。", { 0: formatTokens(window) })
        : t("离自动压缩阈值 {0} 还有 {1}。", {
            0: formatTokens(window),
            1: formatTokens(window - context.contextTokens),
          }),
    );
    if (capped)
      lines.push(
        t("设的阈值是 {0}，但模型上下文只有 {1}，按模型上限压缩。", {
          0: formatTokens(context.compactWindow!),
          1: formatTokens(context.contextWindow!),
        }),
      );
  }
  const minutes = cacheMinutesLeft(context, now);
  if (minutes !== undefined)
    lines.push(
      minutes > 0
        ? t("缓存约剩 {0} 分钟（从最后一次模型请求算起），过期后下一轮要整段重写缓存。", {
            0: minutes,
          })
        : t("缓存已过期：下一轮要把整段会话重新写进缓存，更慢也更贵。"),
    );
  return lines.join("\n");
}

/** 成员名旁：Agent 现在的上下文和缓存剩余时间（从上一轮的用量算，拿不准的不显示） */
export function MemberContextBadge({ participant }: { participant: Participant }) {
  const context = participant.type === "agent" ? participant.context : undefined;
  const now = useMinuteClock(Boolean(context?.cacheExpiresAt));
  if (!context) return null;
  const window = effectiveCompactWindow(context);
  const minutes = cacheMinutesLeft(context, now);
  const size =
    window !== undefined
      ? `${formatTokens(context.contextTokens)}/${formatTokens(window)}`
      : formatTokens(context.contextTokens);
  const cache =
    minutes === undefined
      ? undefined
      : minutes > 0
        ? t("缓存 {0} 分", { 0: minutes })
        : t("缓存已过期");
  const hint = memberContextHint(context, now);
  const near = window !== undefined && context.contextTokens >= window * 0.8;
  return (
    <Tooltip content={hint}>
      <span
        className={`member-context${near || minutes === 0 ? " warning" : ""}`}
        tabIndex={0}
        aria-label={hint}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {cache ? `${size} · ${cache}` : size}
      </span>
    </Tooltip>
  );
}
