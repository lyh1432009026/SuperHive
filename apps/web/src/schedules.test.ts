import { describe, expect, it } from "vitest";
import type { Schedule } from "@superhive/protocol";
import { formatRepeat } from "./schedules";

const base = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "general",
  agentId: "00000000-0000-4000-8000-000000000002",
  agentName: "helper",
  requesterId: "00000000-0000-4000-8000-000000000003",
  requesterName: "rd",
  originMessageId: "00000000-0000-4000-8000-000000000004",
  originSeq: 1,
  task: "看一下构建",
  runAt: "2026-11-10T11:05:00.000Z",
  timeZone: "Asia/Shanghai",
  status: "scheduled",
  createdAt: "2026-11-10T11:00:00.000Z",
  updatedAt: "2026-11-10T11:00:00.000Z",
} satisfies Schedule;

describe("formatRepeat", () => {
  it("describes a recurring schedule and leaves one-off ones alone", () => {
    expect(formatRepeat(base)).toBeUndefined();
    const label = formatRepeat({
      ...base,
      everyMinutes: 5,
      until: "2026-11-10T12:00:00.000Z",
      occurrence: 3,
    });
    expect(label).toContain("每 5 分钟");
    expect(label).toContain("第 3 次");
    expect(label).toContain("20:00");
    expect(formatRepeat({ ...base, everyMinutes: 120, until: base.runAt })).toContain("每 2 小时");
  });
});
