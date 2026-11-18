/**
 * 「结果未知」里哪些是 Agent 确认自己已经不在跑这一轮的：人可以点「继续」，接着原会话核对现状再往下做。
 * 白名单而不是前缀：旧进程还活着（crashedRuntimeAlive）、停止未确认（alreadyEnded、cancelNotPersisted）、
 * 插入的消息可能已经执行过（steerEndRace）这些也是 Bridge 报的，但重新派发会让同一任务并行跑两份。
 * 服务端（是否放行重试）和网页（是否显示「等你决定」）共用这一份。
 */
export const RESUMABLE_UNKNOWN_KEYS: readonly string[] = [
  "bridge.crashedMidTurn",
  "bridge.crashedAfterResume",
  // 中断时正在跑一个撤不回的对外操作：卡片上写明是哪一步，人核对后可以继续
  "bridge.crashedIrreversible",
  "bridge.reconnectedGone",
  "bridge.uncertain",
  // 从没确认收到：一定还没开工
  "invocation.unacknowledged",
];

export function isResumableUnknown(invocation: {
  status: string;
  detailText?: { key: string } | undefined;
}): boolean {
  return (
    invocation.status === "timed_out" &&
    RESUMABLE_UNKNOWN_KEYS.includes(invocation.detailText?.key ?? "")
  );
}
