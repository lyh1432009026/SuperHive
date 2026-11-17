import { describe, expect, it } from "vitest";
import type { Participant } from "./index.js";
import { sortParticipantsByLastSeen } from "./participant-order.js";

function participant(overrides: Partial<Participant> = {}): Participant {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    roomId: "general",
    username: "Alice",
    type: "human",
    status: "online",
    joinedAt: "2026-11-17T09:00:00.000Z",
    lastSeenAt: "2026-11-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("sortParticipantsByLastSeen", () => {
  it("puts recent activity before status, type and name without mutating the input", () => {
    const busy = participant({ username: "alpha", type: "agent", status: "busy" });
    const human = participant({ lastSeenAt: "2026-11-17T10:00:01.000Z" });
    const offline = participant({
      username: "zulu",
      type: "agent",
      status: "offline",
      lastSeenAt: "2026-11-17T10:00:02.000Z",
    });
    const input = Object.freeze([busy, human, offline]);
    expect(sortParticipantsByLastSeen(input)).toEqual([offline, human, busy]);
    expect(input).toEqual([busy, human, offline]);
  });

  it("breaks equal timestamps by case-insensitive names and stable IDs", () => {
    const lower = participant({ username: "alice" });
    const upper = participant({ id: "00000000-0000-4000-8000-000000000002" });
    const laterName = participant({ username: "Beta" });
    const input = [laterName, upper, lower];
    expect(sortParticipantsByLastSeen(input)).toEqual([lower, upper, laterName]);
    expect(sortParticipantsByLastSeen([...input].reverse())).toEqual([lower, upper, laterName]);
  });

  it("compares timestamps chronologically even with different fractional precision", () => {
    const wholeSecond = participant({ username: "zulu", lastSeenAt: "2026-11-17T10:00:00Z" });
    const fractional = participant({ username: "alpha", lastSeenAt: "2026-11-17T10:00:00.100Z" });
    expect(sortParticipantsByLastSeen([wholeSecond, fractional])).toEqual([
      fractional,
      wholeSecond,
    ]);
  });

  it("falls back to joining time and then the epoch for absent or invalid timestamps", () => {
    const unknown = participant({ username: "unknown", lastSeenAt: "", joinedAt: "invalid" });
    const joined = participant({ username: "joined", lastSeenAt: "invalid" });
    const recent = participant();
    expect(sortParticipantsByLastSeen([unknown, joined, recent])).toEqual([
      recent,
      joined,
      unknown,
    ]);
    expect(sortParticipantsByLastSeen([])).toEqual([]);
  });
});
