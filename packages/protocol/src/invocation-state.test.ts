import { describe, expect, it } from "vitest";
import {
  explainInvocationState,
  formatInvocationStateForAgent,
  invocationsAhead,
  type Invocation,
} from "./index.js";

const now = Date.parse("2026-11-06T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
let seq = 0;
function invocation(patch: Partial<Invocation> = {}): Invocation {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    roomId: "build",
    messageId: "10000000-0000-4000-8000-000000000000",
    agentId: "20000000-0000-4000-8000-000000000000",
    agentName: "rd-codex",
    requesterName: "rd",
    requesterType: "human",
    status: "queued",
    attempts: 1,
    createdAt: iso(-1_000),
    updatedAt: iso(-1_000),
    ...patch,
  };
}

describe("explainInvocationState", () => {
  it("flags an offline target as stalled once past the 5s gate", () => {
    const fresh = explainInvocationState({ invocation: invocation(), agentOnline: false, now });
    expect(fresh).toMatchObject({ code: "queued_offline", stalled: false });
    const late = explainInvocationState({
      invocation: invocation({ createdAt: iso(-6_000) }),
      agentOnline: false,
      now,
    });
    expect(late).toMatchObject({ code: "queued_offline", stalled: true });
    expect(formatInvocationStateForAgent(late, "rd-codex")).toContain("离线");
  });

  it("explains the queue position behind the running task", () => {
    const running = invocation({
      status: "running",
      requesterName: "rd-claude",
      createdAt: iso(-60_000),
    });
    const earlier = invocation({ createdAt: iso(-30_000) });
    const mine = invocation({ createdAt: iso(-10_000) });
    const later = invocation({ createdAt: iso(-1_000) });
    const otherAgent = invocation({
      status: "running",
      agentId: "30000000-0000-4000-8000-000000000000",
    });
    const all = [running, earlier, mine, later, otherAgent];
    expect(invocationsAhead(mine, all).map((item) => item.id)).toEqual([running.id, earlier.id]);
    const state = explainInvocationState({ invocation: mine, agentOnline: true, others: all, now });
    expect(state).toMatchObject({ code: "queued_behind", ahead: 2, stalled: true });
    expect(formatInvocationStateForAgent(state, "rd-codex")).toContain("rd-claude 派的");
  });

  it("separates undelivered from received-but-not-started", () => {
    expect(
      explainInvocationState({
        invocation: invocation({ createdAt: iso(-8_000) }),
        agentOnline: true,
        now,
      }),
    ).toMatchObject({ code: "queued_undelivered", stalled: true });
    expect(
      explainInvocationState({
        invocation: invocation({ receivedAt: iso(-500) }),
        agentOnline: true,
        now,
      }),
    ).toMatchObject({ code: "queued_received", stalled: false });
  });

  it("reports how long a running task has been quiet", () => {
    const runtime = {
      observability: "full" as const,
      lastHeartbeatAt: iso(-1_000),
      lastProgressAt: iso(-180_000),
      history: [],
    };
    const quiet = explainInvocationState({
      invocation: invocation({ status: "running", startedAt: iso(-300_000), runtime }),
      agentOnline: true,
      now,
    });
    expect(quiet).toMatchObject({ code: "running_quiet", quietMs: 180_000, stalled: false });
    expect(
      explainInvocationState({
        invocation: invocation({
          status: "running",
          runtime: { ...runtime, observability: "heartbeat", lastProgressAt: undefined },
        }),
        agentOnline: true,
        now,
      }),
    ).toMatchObject({ code: "running_heartbeat", quietMs: 1_000 });
    expect(
      explainInvocationState({
        invocation: invocation({ status: "running" }),
        agentOnline: false,
        now,
      }),
    ).toMatchObject({ code: "running_offline" });
  });
});
