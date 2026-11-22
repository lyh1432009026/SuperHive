import { describe, expect, it } from "vitest";
import type { Invocation } from "@superhive/protocol";
import { agentTasks, nextAgentTaskIndex } from "./agent-tasks";

function invocation(
  id: string,
  overrides: Partial<Invocation> & Pick<Invocation, "status">,
): Invocation {
  return {
    id,
    roomId: "general",
    messageId: `00000000-0000-4000-8000-0000000000${id}`,
    agentId: "00000000-0000-4000-8000-000000000001",
    agentName: "helper",
    requesterName: "Alice",
    requesterType: "human",
    attempts: 1,
    createdAt: "2026-11-22T10:00:00.000Z",
    updatedAt: "2026-11-22T10:00:00.000Z",
    ...overrides,
  };
}

describe("agentTasks", () => {
  it("lists running first, then waiting and queued, current room before others, oldest first", () => {
    const tasks = agentTasks(
      [
        invocation("01", { status: "queued", createdAt: "2026-11-22T09:00:00.000Z" }),
        invocation("02", { status: "waiting_human" }),
        invocation("03", { status: "running", roomId: "other" }),
        invocation("04", { status: "running", createdAt: "2026-11-22T11:00:00.000Z" }),
        invocation("05", { status: "completed" }),
        invocation("06", { status: "running", agentName: "someone-else" }),
        invocation("07", { status: "running", createdAt: "2026-11-22T10:30:00.000Z" }),
      ],
      "HELPER",
      "general",
    );
    expect(tasks.map((task) => task.id)).toEqual(["07", "04", "03", "02", "01"]);
  });

  it("keeps the later copy when the same invocation appears twice", () => {
    const tasks = agentTasks(
      [invocation("01", { status: "queued" }), invocation("01", { status: "running" })],
      "helper",
      "general",
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("running");
  });
});

describe("nextAgentTaskIndex", () => {
  const tasks = [invocation("01", { status: "running" }), invocation("02", { status: "queued" })];
  it("starts from the first task and cycles to the next on repeated clicks", () => {
    expect(nextAgentTaskIndex(tasks, undefined)).toBe(0);
    expect(nextAgentTaskIndex(tasks, "01")).toBe(1);
    expect(nextAgentTaskIndex(tasks, "02")).toBe(0);
    // 上次跳的那条已经结束：从头开始
    expect(nextAgentTaskIndex(tasks, "99")).toBe(0);
  });
});
