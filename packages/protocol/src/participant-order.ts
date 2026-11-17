import type { Participant } from "./index.js";

function activityTimestamp(participant: Participant): number {
  const lastSeen = Date.parse(participant.lastSeenAt);
  if (Number.isFinite(lastSeen)) return lastSeen;
  const joined = Date.parse(participant.joinedAt);
  return Number.isFinite(joined) ? joined : 0;
}

export function sortParticipantsByLastSeen(participants: readonly Participant[]): Participant[] {
  return [...participants].sort((left, right) => {
    const activityOrder = activityTimestamp(right) - activityTimestamp(left);
    if (activityOrder !== 0) return activityOrder;
    const leftName = left.username.toLowerCase();
    const rightName = right.username.toLowerCase();
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}
