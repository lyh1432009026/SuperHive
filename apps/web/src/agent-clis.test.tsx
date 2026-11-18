// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCliJob } from "@superhive/protocol";
import { AgentClisGroup, JOB_POLL_MS } from "./agent-clis";
import type { AgentCliWithAgents } from "./local-agents";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const COMMAND =
  "'/Users/a/.npm-global/bin/codex-npm' i -g --prefix '/Users/a/.npm-global' @openai/codex@latest";

const codex = (overrides: Partial<AgentCliWithAgents> = {}): AgentCliWithAgents => ({
  tool: "codex",
  name: "Codex",
  package: "@openai/codex",
  status: "ok",
  version: "0.160.0",
  installations: [
    {
      path: "/Users/a/.npm-global/bin/codex",
      realPath: "/Users/a/.npm-global/lib/node_modules/@openai/codex/bin/codex.js",
      version: "0.160.0",
      runnable: true,
      source: "npm",
      pathDefault: true,
    },
  ],
  conflict: false,
  latest: "0.170.0",
  updateAvailable: true,
  plan: { kind: "anchored", command: COMMAND },
  agents: [
    { id: "a1", name: "rd-codex", status: "running" },
    { id: "a2", name: "rd-codex2", status: "stopped" },
  ],
  ...overrides,
});

const claude = (overrides: Partial<AgentCliWithAgents> = {}): AgentCliWithAgents => ({
  tool: "claude",
  name: "Claude Code",
  package: "@anthropic-ai/claude-code",
  status: "notInstalled",
  version: null,
  installations: [],
  conflict: false,
  latest: null,
  updateAvailable: false,
  agents: [],
  ...overrides,
});

const job = (overrides: Partial<AgentCliJob> = {}): AgentCliJob => ({
  id: "job-1",
  tool: "codex",
  command: COMMAND,
  state: "running",
  progress: "",
  startedAt: "2026-11-19T02:00:00.000Z",
  versionBefore: "0.160.0",
  ...overrides,
});

function api(tools: AgentCliWithAgents[] = [codex(), claude()]) {
  return {
    agentClis: vi.fn<
      (refresh?: boolean) => Promise<{ tools: AgentCliWithAgents[]; job: AgentCliJob | null }>
    >(async () => ({ tools, job: null })),
    upgradeAgentCli: vi.fn(async () => job()),
    agentCliJob: vi.fn(async () => job()),
    act: vi.fn(async () => undefined),
  };
}

describe("AgentClisGroup", () => {
  it("shows versions, source, and what can't be updated", async () => {
    const client = api([
      codex(),
      claude(),
      codex({
        tool: "copilot",
        name: "GitHub Copilot CLI",
        version: "1.0.88",
        latest: "1.0.114",
        plan: {
          kind: "manual",
          reason: "认不出 /Users/a/bin/copilot 是怎么装的，请用原来的安装方式升级",
        },
        agents: [],
      }),
      codex({
        tool: "openclaw",
        name: "OpenClaw",
        nodeGap: { required: ">=24.16.0", current: "20.1.0" },
        agents: [],
      }),
    ]);
    render(<AgentClisGroup api={client} />);
    const card = await screen.findByRole("region", { name: "Codex" });
    expect(card.textContent).toContain("0.160.0");
    expect(card.textContent).toContain("有新版 0.170.0");
    expect(card.textContent).toContain("npm");
    expect(screen.getByRole("region", { name: "Claude Code" }).textContent).toContain("未安装");
    // 认不出来源：只给原因，没有升级按钮
    const copilot = screen.getByRole("region", { name: "GitHub Copilot CLI" });
    expect(copilot.textContent).toContain("请用原来的安装方式升级");
    expect(copilot.querySelector("button")).toBeNull();
    // Node 不满足：不给升级
    const openclaw = screen.getByRole("region", { name: "OpenClaw" });
    expect(openclaw.textContent).toContain("新版需要 Node >=24.16.0");
    expect(openclaw.querySelector("button")).toBeNull();
    expect(client.agentClis).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    await waitFor(() => expect(client.agentClis).toHaveBeenCalledWith(true));
  });

  it("lists every installation when they conflict", async () => {
    const client = api([
      codex({
        conflict: true,
        installations: [
          ...codex().installations,
          {
            path: "/Users/a/.nvm/versions/node/v20.1.0/bin/codex",
            realPath:
              "/Users/a/.nvm/versions/node/v20.1.0/lib/node_modules/@openai/codex/bin/codex.js",
            version: "0.150.0",
            runnable: true,
            source: "nvm",
            pathDefault: false,
          },
        ],
      }),
    ]);
    render(<AgentClisGroup api={client} />);
    const summary = await screen.findByText(/装了 2 处/);
    fireEvent.click(summary);
    expect(screen.getByText("/Users/a/.nvm/versions/node/v20.1.0/bin/codex")).toBeTruthy();
    expect(screen.getByText(/0\.150\.0 · nvm/)).toBeTruthy();
  });

  it("asks before running the exact command, then shows progress and offers restarts", async () => {
    const client = api();
    let current = job({ progress: "npm http fetch GET 200" });
    client.agentCliJob.mockImplementation(async () => current);
    render(<AgentClisGroup api={client} />);
    const upgrade = await screen.findByRole("button", { name: "升级到 0.170.0" });
    fireEvent.click(upgrade);
    // 确认气泡里是原样的命令；取消不执行
    const dialog = screen.getByRole("dialog", { name: "确认升级 Codex" });
    expect(dialog.textContent).toContain(COMMAND);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(client.upgradeAgentCli).not.toHaveBeenCalled();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole("button", { name: "升级到 0.170.0" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "升级" }));
    });
    expect(client.upgradeAgentCli).toHaveBeenCalledWith("codex", COMMAND);
    expect(await screen.findByText("正在升级…")).toBeTruthy();
    // 一次只升级一个：重新检测也先停用
    expect(screen.getByRole("button", { name: "重新检测" }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    expect(screen.getByText("npm http fetch GET 200")).toBeTruthy();

    current = job({ state: "succeeded", versionAfter: "0.170.0", progress: "changed 2 packages" });
    client.agentClis.mockImplementation(async () => ({
      tools: [codex({ version: "0.170.0", updateAvailable: false })],
      job: current,
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    expect(await screen.findByText(/已升级到 0\.170\.0/)).toBeTruthy();
    expect(screen.getByText(/rd-codex、rd-codex2/)).toBeTruthy();
    // 只重启在跑的
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重启这 1 个 Agent" }));
    });
    expect(client.act).toHaveBeenCalledTimes(1);
    expect(client.act).toHaveBeenCalledWith("a1", "restart");
    expect(await screen.findByText("已重启 1 个 Agent")).toBeTruthy();
  });

  it("shows the reason and the last lines of output when an update fails", async () => {
    const client = api();
    client.agentClis.mockImplementation(async () => ({
      tools: [codex()],
      job: job(),
    }));
    client.agentCliJob.mockImplementation(async () =>
      job({
        state: "failed",
        reason: "升级命令失败（退出码 243）。",
        error: "npm error code EACCES\nnpm error path /usr/local/lib/node_modules",
      }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<AgentClisGroup api={client} />);
    // 打开页面时已有升级在跑：接着轮询
    expect(await screen.findByText("正在升级…")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("升级失败：升级命令失败（退出码 243）。");
    expect(alert.textContent).toContain("npm error code EACCES");
  });

  it("shows the server's refusal next to the button", async () => {
    const client = api();
    client.upgradeAgentCli.mockRejectedValue(
      new Error("Codex 的安装情况变了，升级命令和你确认的不一样，没有执行。请刷新后重新确认。"),
    );
    render(<AgentClisGroup api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "升级到 0.170.0" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "升级" }));
    });
    expect(await screen.findByText(/升级命令和你确认的不一样/)).toBeTruthy();
  });
});
