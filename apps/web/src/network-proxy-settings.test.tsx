// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalAgent, NetworkProxyState } from "@superhive/protocol";
import type { LocalAgentsState } from "./local-agents";
import { agentsOnOldProxy, NetworkProxySettingsGroup } from "./network-proxy-settings";

const agent: LocalAgent = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "agy",
  name: "rd-agy",
  access: "full",
  cwd: "/repo",
  model: null,
  effort: null,
  compactWindow: null,
  cacheTtl: null,
  status: "running",
  pid: 100,
  startedAt: "2026-11-25T04:00:00.000Z",
  lastExitCode: null,
  lastError: null,
  restarts: 0,
  createdAt: "2026-11-19T00:00:00.000Z",
  mcpDisabled: [],
  autoSteer: false,
};

const systemState: NetworkProxyState = {
  mode: "system",
  effective: { source: "system", url: "http://127.0.0.1:7890", noProxy: "localhost" },
  system: { supported: true, url: "http://127.0.0.1:7890" },
  env: {},
};

function localWith(overrides: Partial<LocalAgentsState>): LocalAgentsState {
  return {
    enabled: true,
    canManage: true,
    agents: [],
    act: vi.fn(async () => undefined),
    networkProxy: vi.fn(async () => systemState),
    updateNetworkProxy: vi.fn(async () => systemState),
    ...overrides,
  } as unknown as LocalAgentsState;
}

describe("agentsOnOldProxy", () => {
  it("counts only live agents started before the last change", () => {
    const agents: LocalAgent[] = [
      agent,
      { ...agent, id: "b", startedAt: "2026-11-25T06:00:00.000Z" },
      { ...agent, id: "c", status: "stopped" },
      { ...agent, id: "d", startedAt: null },
    ];
    expect(agentsOnOldProxy(agents, "2026-11-25T05:00:00.000Z").map((item) => item.id)).toEqual([
      agent.id,
    ]);
    expect(agentsOnOldProxy(agents, undefined)).toEqual([]);
  });
});

describe("NetworkProxySettingsGroup", () => {
  afterEach(cleanup);

  it("shows what agents will use when following the system", async () => {
    render(<NetworkProxySettingsGroup local={localWith({})} />);
    expect(await screen.findByText("Agent 将使用 http://127.0.0.1:7890")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /跟随系统/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("validates the manual address before saving and warns about socks", async () => {
    const updateNetworkProxy = vi.fn(async () => ({
      ...systemState,
      mode: "manual" as const,
      url: "socks5://127.0.0.1:7891",
      updatedAt: "2026-11-25T05:00:00.000Z",
      effective: { source: "manual" as const, url: "socks5://127.0.0.1:7891" },
    }));
    render(<NetworkProxySettingsGroup local={localWith({ updateNetworkProxy })} />);
    fireEvent.click(await screen.findByRole("radio", { name: /手动/ }));
    // 还没填地址：只切过去，不发请求
    expect(updateNetworkProxy).not.toHaveBeenCalled();
    const input = screen.getByPlaceholderText("http://127.0.0.1:7890");
    fireEvent.change(input, { target: { value: "127.0.0.1" } });
    expect(screen.getByText("要写端口，例如 http://127.0.0.1:7890")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updateNetworkProxy).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "socks5://127.0.0.1:7891" } });
    expect(screen.getByText(/不支持 socks 代理/)).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updateNetworkProxy).toHaveBeenCalledWith({
      mode: "manual",
      url: "socks5://127.0.0.1:7891",
      noProxy: "",
    });
    expect(await screen.findByText("已保存。")).toBeTruthy();
  });

  it("offers to restart agents still on the old setting, waiting for their tasks", async () => {
    const act = vi.fn(async () => undefined);
    const local = localWith({
      act,
      agents: [agent, { ...agent, id: "fresh", startedAt: "2026-11-25T06:00:00.000Z" }],
      networkProxy: vi.fn(async () => ({ ...systemState, updatedAt: "2026-11-25T05:00:00.000Z" })),
    });
    render(<NetworkProxySettingsGroup local={local} />);
    fireEvent.click(await screen.findByRole("button", { name: "重启全部本机 Agent" }));
    await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
    expect(act).toHaveBeenCalledWith(agent.id, "restart");
  });

  it("shows the reason when saving fails", async () => {
    const updateNetworkProxy = vi.fn(async () => {
      throw new Error("代理地址格式不对");
    });
    render(<NetworkProxySettingsGroup local={localWith({ updateNetworkProxy })} />);
    fireEvent.click(await screen.findByRole("radio", { name: /不用代理/ }));
    expect(await screen.findByText("保存失败：代理地址格式不对")).toBeTruthy();
  });
});
