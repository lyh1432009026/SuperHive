// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INCIDENT_SETTINGS,
  type Incident,
  type IncidentsResponse,
  type RuleProposal,
} from "@superhive/protocol";
import { IncidentsPanel, IncidentsSettingsEntry, groupIncidents } from "./incidents-panel";
import type { LocalAgentsState } from "./local-agents";
import { installErrorReporter, ignorableError } from "./error-report";

afterEach(cleanup);

let sequence = 0;
function incident(patch: Partial<Incident> = {}): Incident {
  sequence++;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    fingerprint: `server:TypeError:f${sequence}`,
    origin: "internal",
    source: "server",
    title: `TypeError: boom ${sequence}`,
    status: "open",
    count: 3,
    recentCount: 3,
    firstSeenAt: "2026-11-22T01:00:00.000Z",
    lastSeenAt: `2026-11-22T01:${String(sequence).padStart(2, "0")}:00.000Z`,
    samples: [
      {
        at: "2026-11-22T01:00:00.000Z",
        route: "GET /api/rooms",
        stack: "TypeError: boom\n    at f (apps/server/src/app.ts)",
      },
    ],
    failedAttempts: 0,
    dispatches: [],
    reopenedCount: 0,
    updatedAt: "2026-11-22T01:00:00.000Z",
    ...patch,
  };
}

function proposal(patch: Partial<RuleProposal> = {}): RuleProposal {
  return {
    id: "p1",
    roomId: "build",
    agentName: "rd-claude2",
    text: "合入前先跑全量测试",
    reason: "漏跑了 docs 的测试",
    status: "pending",
    createdAt: "2026-11-22T01:00:00.000Z",
    ...patch,
  };
}

function response(patch: Partial<IncidentsResponse> = {}): IncidentsResponse {
  return {
    incidents: [],
    lessons: [],
    proposals: [],
    settings: { ...DEFAULT_INCIDENT_SETTINGS },
    dispatchedToday: 0,
    protectedPaths: ["apps/server/src/agent-instructions.ts"],
    runningCommit: "a".repeat(40),
    ...patch,
  };
}

describe("groupIncidents", () => {
  it("puts incidents that need a person first and keeps external and unclear ones apart", () => {
    const older = incident({ lastSeenAt: "2026-11-22T00:00:00.000Z" });
    const escalated = incident({ status: "escalated", lastSeenAt: "2026-11-21T00:00:00.000Z" });
    const newer = incident({ lastSeenAt: "2026-11-22T02:00:00.000Z" });
    const resolved = incident({ status: "resolved" });
    const external = incident({ origin: "external" });
    const unknown = incident({ origin: "unknown" });
    const groups = groupIncidents([older, escalated, newer, resolved, external, unknown]);
    expect(groups.active.map((item) => item.id)).toEqual([escalated.id, newer.id, older.id]);
    expect(groups.closed).toEqual([resolved]);
    expect(groups.external).toEqual([external]);
    expect(groups.unknown).toEqual([unknown]);
  });
});

describe("IncidentsPanel", () => {
  const handlers = () => ({ onSettings: vi.fn(), onAction: vi.fn(), onDecide: vi.fn() });

  it("shows our incidents with actions and saves the dispatch settings", () => {
    const calls = handlers();
    const open = incident({ title: "TypeError: x is undefined" });
    render(
      <IncidentsPanel
        data={response({ incidents: [open, incident({ origin: "external" })] })}
        rooms={[{ id: "build", name: "build" }]}
        currentRoomId="build"
        username="rd"
        {...calls}
      />,
    );
    expect(screen.getByText("TypeError: x is undefined")).toBeTruthy();
    expect(screen.getByText("外部原因（1）")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "派修" })[0]!);
    expect(calls.onAction).toHaveBeenCalledWith(open.id, "dispatch");
    fireEvent.change(screen.getByLabelText("修的 Agent"), { target: { value: "rd-claude2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(calls.onSettings).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: "build", requester: "rd", fixer: "rd-claude2" }),
    );
    fireEvent.click(screen.getByRole("switch", { name: /自动派修/ }));
    expect(calls.onSettings).toHaveBeenCalledWith({ autoDispatch: true });
  });

  it("can't switch on automatic fixing when the server doesn't run from a checkout", () => {
    const calls = handlers();
    const data = response();
    delete data.runningCommit;
    render(
      <IncidentsPanel data={data} rooms={[]} currentRoomId="build" username="rd" {...calls} />,
    );
    expect((screen.getByRole("switch", { name: /自动派修/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("lets the owner approve or reject rule proposals", () => {
    const calls = handlers();
    render(
      <IncidentsPanel
        data={response({ proposals: [proposal()] })}
        rooms={[]}
        currentRoomId="build"
        username="rd"
        {...calls}
      />,
    );
    expect(screen.getByText("合入前先跑全量测试")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(calls.onDecide).toHaveBeenCalledWith("p1", "approve");
  });
});

describe("IncidentsSettingsEntry", () => {
  it("loads incidents when opened and shows the attention count", async () => {
    const incidents = vi.fn(async () =>
      response({ incidents: [incident({ title: "TypeError: loaded" })] }),
    );
    const local = { mode: "local", incidents } as unknown as LocalAgentsState;
    render(
      <IncidentsSettingsEntry
        local={local}
        attention={2}
        rooms={[]}
        currentRoomId="build"
        username="rd"
      />,
    );
    expect(screen.getByTitle("需要你处理的故障单和规则提议").textContent).toBe("2");
    expect(incidents).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    await waitFor(() => expect(screen.getByText("TypeError: loaded")).toBeTruthy());
  });

  it("isn't shown on other devices", () => {
    const local = { mode: "device", incidents: vi.fn() } as unknown as LocalAgentsState;
    const { container } = render(
      <IncidentsSettingsEntry
        local={local}
        attention={0}
        rooms={[]}
        currentRoomId="build"
        username="rd"
      />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("installErrorReporter", () => {
  it("reports uncaught errors and rejections once per minute, skipping extension noise", () => {
    const sent: Array<{ message: string; kind: string; roomId: string | undefined }> = [];
    const uninstall = installErrorReporter({
      base: "",
      token: "t",
      roomId: () => "build",
      send: (report, roomId) => sent.push({ message: report.message, kind: report.kind, roomId }),
    });
    const error = new TypeError("x is undefined");
    window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
    window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
    const rejection = new Event("unhandledrejection") as Event & { reason: unknown };
    rejection.reason = new Error("fetch failed");
    window.dispatchEvent(rejection);
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    uninstall();
    window.dispatchEvent(new ErrorEvent("error", { message: "later" }));
    expect(sent).toEqual([
      { message: "x is undefined", kind: "error", roomId: "build" },
      { message: "fetch failed", kind: "unhandledrejection", roomId: "build" },
    ]);
    expect(ignorableError("x", "at chrome-extension://abc/content.js:1:1")).toBe(true);
  });
});
