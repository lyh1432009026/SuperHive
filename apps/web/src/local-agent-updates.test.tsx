// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalAgent, Participant } from "@superhive/protocol";
import type { LocalAgentsState } from "./local-agents";
import { LocalAgentUpdatesGroup, OutdatedBadge } from "./local-agent-updates";

const base: LocalAgent = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "claude",
  name: "rd-claude",
  access: "full",
  cwd: "/repo",
  model: null,
  effort: null,
  status: "running",
  pid: 100,
  startedAt: null,
  lastExitCode: null,
  lastError: null,
  restarts: 0,
  createdAt: "2026-11-19T00:00:00.000Z",
  mcpDisabled: [],
  autoSteer: false,
};

function localWith(overrides: Partial<LocalAgentsState>): LocalAgentsState {
  return {
    enabled: true,
    canManage: true,
    autoUpdate: true,
    currentVersion: { package: "0.3.1", commit: "bbbbbbbbbb", fingerprint: "new.tree" },
    agents: [],
    refreshAgents: vi.fn(async () => undefined),
    setAutoUpdate: vi.fn(async () => undefined),
    act: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as LocalAgentsState;
}

describe("LocalAgentUpdatesGroup", () => {
  afterEach(cleanup);

  it("shows the current code, who is outdated or busy, and restarts when idle by default", async () => {
    const act = vi.fn(async () => undefined);
    const setAutoUpdate = vi.fn(async () => undefined);
    const local = localWith({
      act,
      setAutoUpdate,
      agents: [
        {
          ...base,
          busy: true,
          outdated: true,
          restartWhenIdle: true,
          version: { package: "0.3.1", commit: "aaaaaaaaaa" },
        },
        {
          ...base,
          id: "22222222-2222-4222-8222-222222222222",
          name: "rd-codex",
          busy: false,
          outdated: true,
        },
        { ...base, id: "33333333-3333-4333-8333-333333333333", name: "idle", status: "stopped" },
      ],
    });
    render(<LocalAgentUpdatesGroup local={local} />);
    expect(screen.getByText(/当前代码：0\.3\.1 · bbbbbbb；2 个 Agent 在跑旧版本/)).toBeTruthy();
    expect(screen.getByText("运行中 · 0.3.1 · aaaaaaa · 正在执行任务")).toBeTruthy();
    expect(screen.getByText("运行中 · 版本未上报 · 空闲")).toBeTruthy();
    expect(screen.getAllByText("旧版本")).toHaveLength(2);
    expect(screen.getByText("空闲后重启")).toBeTruthy();

    const rows = screen.getAllByRole("listitem");
    // 已经安排了空闲后重启：「重启」不用再点
    const busyRestart = rows[0]!.querySelector("button")!;
    expect(busyRestart.disabled).toBe(true);
    // 停止的 Agent 不给重启按钮
    expect(rows[2]!.querySelector("button")).toBeNull();

    fireEvent.click(rows[1]!.querySelector("button")!);
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", "restart"),
    );

    fireEvent.click(screen.getByRole("switch", { name: /代码更新后自动重启/ }));
    expect(setAutoUpdate).toHaveBeenCalledWith(false);
  });

  it("asks before restarting now, and warns that running tasks get interrupted", async () => {
    const act = vi.fn(async () => undefined);
    render(
      <LocalAgentUpdatesGroup local={localWith({ act, agents: [{ ...base, busy: true }] })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "立即重启" }));
    const confirm = screen.getByRole("dialog", { name: "确认立即重启 rd-claude" });
    expect(confirm.textContent).toContain("正在执行的会被中断");
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(confirm.querySelector("button.primary")!);
    await waitFor(() => expect(act).toHaveBeenCalledWith(base.id, "restart", { now: true }));
  });

  it("stays hidden on a Server that does not support auto-update", () => {
    const { container } = render(
      <LocalAgentUpdatesGroup local={localWith({ autoUpdate: undefined })} />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("OutdatedBadge", () => {
  afterEach(cleanup);
  const participant: Participant = {
    id: "44444444-4444-4444-8444-444444444444",
    roomId: "general",
    username: "rd-claude",
    type: "agent",
    status: "online",
    joinedAt: "2026-11-19T00:00:00.000Z",
    lastSeenAt: "2026-11-19T00:00:00.000Z",
  };

  it("only shows for outdated agents, with the running version in the tooltip", () => {
    const { rerender, container } = render(<OutdatedBadge participant={participant} />);
    expect(container.textContent).toBe("");
    rerender(
      <OutdatedBadge
        participant={{ ...participant, outdated: true, version: { package: "0.3.0" } }}
      />,
    );
    expect(screen.getByText("旧版本").getAttribute("title")).toBe(
      "运行的是 0.3.0，比当前代码旧；重启后才用上新代码",
    );
  });
});
