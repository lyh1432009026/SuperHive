import { describe, expect, it } from "vitest";
import { failureClass, type FailureClass } from "./invocation-decision.js";
import { serverTexts } from "./server-text.js";

const cases: Array<
  [
    status: string,
    key: string,
    expected: FailureClass | undefined,
    params?: Record<string, unknown>,
  ]
> = [
  ["failed", "bridge.transientFailed", "transient"],
  ["failed", "bridge.worktreeBusy", "transient"],
  ["failed", "bridge.beyondCatchUp", "transient"],
  ["timed_out", "invocation.unacknowledged", "transient"],
  ["timed_out", "bridge.uncertain", "uncertain"],
  ["timed_out", "bridge.crashedMidTurn", "uncertain"],
  ["timed_out", "bridge.crashedAfterResume", "uncertain"],
  ["timed_out", "bridge.crashedIrreversible", "uncertain"],
  ["timed_out", "bridge.crashedRuntimeAlive", "uncertain"],
  ["timed_out", "bridge.reconnectedGone", "uncertain"],
  ["timed_out", "bridge.alreadyEnded", "uncertain"],
  ["timed_out", "bridge.cancelNotPersisted", "uncertain"],
  ["timed_out", "bridge.steerUnconfirmed", "uncertain"],
  ["timed_out", "bridge.steerCancelRace", "uncertain"],
  ["timed_out", "bridge.steerEndRace", "uncertain"],
  ["failed", "bridge.upstreamFailed", "uncertain"],
  ["failed", "bridge.worktreeCheckBeforeContinue", "uncertain"],
  ["failed", "bridge.sessionInvalid", "uncertain", { why: { key: "bridge.sessionExecuted" } }],
  ["failed", "bridge.sessionInvalid", "transient", { why: { key: "bridge.sessionRetried" } }],
  ["failed", "bridge.unsafe", "unsafe"],
  // 不在三类里：模型用不了要换模型，连续失败原因不明
  ["failed", "bridge.modelFailed", undefined],
  ["failed", "bridge.failedRepeatedly", undefined],
  // 只看失败与结果未知
  ["completed", "bridge.unsafe", undefined],
  ["cancelled", "bridge.transientFailed", undefined],
];

describe("failureClass", () => {
  it.each(cases)("%s %s → %s", (status, key, expected, params) => {
    expect(failureClass({ status, detailText: { key, ...(params ? { params } : {}) } })).toBe(
      expected,
    );
  });

  it("returns undefined for an old bridge that only sent Chinese detail", () => {
    expect(failureClass({ status: "failed" })).toBeUndefined();
  });

  it("only classifies keys the server knows how to render", () => {
    for (const [, key] of cases) expect(serverTexts).toHaveProperty([key]);
  });
});
