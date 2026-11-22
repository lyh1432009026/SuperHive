import type { Invocation } from "@superhive/protocol";

/** 成员列表里点忙碌的 Agent 跳到它在做的事：正在执行的先跳，其次等你回答的，最后排队中的 */
const ORDER: Partial<Record<Invocation["status"], number>> = {
  running: 0,
  waiting_human: 1,
  queued: 2,
};

/**
 * 某个 Agent 手上在办的调用（跨房间），按跳转顺序排好：先按状态，同状态时当前房间的在前，再按发起先后。
 * 同一个 Agent 在不同房间是不同的成员记录，按名字（不分大小写）认。
 */
export function agentTasks(
  invocations: Iterable<Invocation>,
  agentName: string,
  currentRoomId: string,
): Invocation[] {
  const key = agentName.toLocaleLowerCase();
  const byId = new Map<string, Invocation>();
  for (const invocation of invocations) {
    if (invocation.agentName.toLocaleLowerCase() !== key) continue;
    if (ORDER[invocation.status] === undefined) continue;
    byId.set(invocation.id, invocation);
  }
  return [...byId.values()].sort(
    (a, b) =>
      ORDER[a.status]! - ORDER[b.status]! ||
      Number(b.roomId === currentRoomId) - Number(a.roomId === currentRoomId) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

/** 再点一次跳下一条：上次跳的那条还在就往后挪一位（到头回到第一条），否则从第一条开始 */
export function nextAgentTaskIndex(tasks: readonly Invocation[], lastId: string | undefined) {
  const index = lastId ? tasks.findIndex((task) => task.id === lastId) : -1;
  return index < 0 ? 0 : (index + 1) % tasks.length;
}
