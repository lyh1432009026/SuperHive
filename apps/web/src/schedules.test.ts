import { describe, expect, it } from "vitest";
import type { Schedule } from "@superhive/protocol";
import type { Invocation } from "@superhive/protocol";
import {
  formatRepeat,
  groupSchedules,
  scheduleNeedsAttention,
  scheduleRoomOptions,
} from "./schedules";

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

const at = (id: string, patch: Partial<Schedule>): Schedule => ({
  ...base,
  id: `00000000-0000-4000-8000-0000000001${id}`,
  ...patch,
});

describe("groupSchedules", () => {
  it("puts pending ones first by next run, then ended ones newest first, across rooms", () => {
    const list = [
      at("01", { roomId: "a", runAt: "2026-11-10T12:00:00.000Z" }),
      at("02", { roomId: "b", runAt: "2026-11-10T11:30:00.000Z", status: "firing" }),
      at("03", { roomId: "a", runAt: "2026-11-09T10:00:00.000Z", status: "fired" }),
      at("04", { roomId: "b", runAt: "2026-11-10T10:00:00.000Z", status: "missed" }),
    ];
    const { pending, history } = groupSchedules(list);
    expect(pending.map((item) => item.id.slice(-2))).toEqual(["02", "01"]);
    expect(history.map((item) => item.id.slice(-2))).toEqual(["04", "03"]);
  });
});

describe("scheduleRoomOptions", () => {
  it("lists rooms that have schedules, current room first, then by name, with counts", () => {
    const names: Record<string, string> = { a: "zeta", b: "alpha", c: "beta" };
    const options = scheduleRoomOptions(
      [
        at("01", { roomId: "a" }),
        at("02", { roomId: "b", status: "cancelled" }),
        at("03", { roomId: "c" }),
        at("04", { roomId: "c", status: "fired" }),
      ],
      (id) => names[id]!,
      "a",
    );
    expect(options).toEqual([
      { id: "a", name: "zeta", total: 1, pending: 1 },
      { id: "b", name: "alpha", total: 1, pending: 0 },
      { id: "c", name: "beta", total: 2, pending: 1 },
    ]);
  });
});

describe("scheduleNeedsAttention", () => {
  const invocation = (patch: Partial<Invocation>) =>
    ({ id: "i", status: "completed", replyMessageId: "m", ...patch }) as Invocation;
  it("flags ended runs that didn't finish normally, never pending ones", () => {
    expect(scheduleNeedsAttention(at("01", {}), undefined)).toBe(false);
    expect(scheduleNeedsAttention(at("02", { status: "missed" }), undefined)).toBe(true);
    expect(scheduleNeedsAttention(at("03", { status: "failed" }), undefined)).toBe(true);
    expect(scheduleNeedsAttention(at("04", { status: "cancelled" }), undefined)).toBe(false);
    const fired = at("05", { status: "fired", invocationId: "i" });
    expect(scheduleNeedsAttention(fired, invocation({}))).toBe(false);
    expect(scheduleNeedsAttention(fired, invocation({ replyMessageId: undefined }))).toBe(true);
    expect(scheduleNeedsAttention(fired, invocation({ status: "failed" }))).toBe(true);
  });
});
