// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LocalAgent,
  LocalAgentMcpResponse,
  LocalAgentModelsResponse,
} from "@superhive/protocol";
import { AgentSettingsDialog, formatTokens } from "./agent-settings-dialog";

const agent = {
  id: "00000000-0000-4000-8000-0000000000e1",
  provider: "claude",
  name: "rd-claude",
  access: "full",
  cwd: "/repo",
  model: null,
  effort: null,
  status: "running",
  pid: 1,
  startedAt: null,
  lastExitCode: null,
  lastError: null,
  restarts: 0,
  createdAt: new Date().toISOString(),
  mcpDisabled: [],
  autoSteer: false,
} as LocalAgent;

const listed: LocalAgentMcpResponse = {
  supported: true,
  baselineTokens: 40_000,
  servers: [
    {
      name: "chrome-devtools",
      scope: "user",
      transport: "stdio",
      enabled: true,
      configurable: true,
      measurement: { ok: true, tools: 32, tokens: 12_000 },
    },
    {
      name: "rea",
      scope: "user",
      transport: "stdio",
      enabled: true,
      configurable: true,
      measurement: { ok: true, tools: 207, tokens: 350_000 },
    },
    { name: "figma", scope: "plugin", transport: "http", enabled: true, configurable: false },
  ],
};

const modelList: LocalAgentModelsResponse = {
  source: "runtime",
  models: [{ id: "gpt-a", label: "GPT A", isDefault: true }, { id: "gpt-b" }],
  efforts: [],
};

describe("AgentSettingsDialog", () => {
  afterEach(cleanup);

  it("lists MCP sizes, estimates the start cost and saves the unchecked servers", async () => {
    const mcpServers = vi.fn(async () => listed);
    const updateSettings = vi.fn(async (_id: string, settings: { mcpDisabled: string[] }) => ({
      ...agent,
      mcpDisabled: settings.mcpDisabled,
    }));
    const act = vi.fn(async () => undefined);
    render(
      <AgentSettingsDialog
        agent={agent}
        local={{
          mcpServers,
          updateSettings,
          act,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText("207 个工具 · 约 35 万 token")).toBeTruthy();
    // figma 来自插件，不能在这里开关；估算只能在它也有大小时给出
    expect((screen.getByRole("checkbox", { name: /figma/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByText(/每个新会话开局约/)).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /rea/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith(agent.id, { mcpDisabled: ["rea"] }),
    );
    expect(act).not.toHaveBeenCalled();
    expect(await screen.findByText("已保存。")).toBeTruthy();
  });

  it("only lists MCP on an owner device without management access: no measuring, no changes", async () => {
    const mcpServers = vi.fn(async () => ({ ...listed, servers: listed.servers.slice(0, 2) }));
    render(
      <AgentSettingsDialog
        agent={agent}
        local={{
          mcpServers,
          updateSettings: async (_id, settings) => ({ ...agent, ...settings }),
          act: async () => undefined,
          canManage: false,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText("这台设备只能查看。要修改，先申请管理权。")).toBeTruthy();
    // 测量会在 Server 所在电脑上起进程，没获批不发
    expect(mcpServers).toHaveBeenCalledTimes(1);
    expect(mcpServers).toHaveBeenCalledWith(agent.id, false);
    for (const box of screen.getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for a restart when the running process predates the settings file", async () => {
    const act = vi.fn(async () => undefined);
    render(
      <AgentSettingsDialog
        agent={{ ...agent, settingsPendingRestart: true }}
        local={{
          mcpServers: async () => ({ ...listed, servers: listed.servers.slice(0, 2) }),
          updateSettings: async (_id, settings) => ({ ...agent, ...settings }),
          act,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText(/每个新会话开局约 40 万 token/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /rea/ }));
    expect(screen.getByText(/每个新会话开局约 5.2 万 token/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存并重启" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(agent.id, "restart"));
  });

  it("picks the model from the runtime's list, accepts a typed one and goes back to the default", async () => {
    const models = vi.fn(async () => modelList);
    const updateSettings = vi.fn(async (_id: string, settings: { model?: string | null }) => ({
      ...agent,
      model: settings.model ?? null,
    }));
    render(
      <AgentSettingsDialog
        agent={agent}
        local={{
          mcpServers: async () => listed,
          updateSettings,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models,
        }}
        onClose={() => undefined}
      />,
    );
    const picker = await screen.findByRole("combobox", { name: "模型" });
    await waitFor(() => expect(picker.textContent).toContain("运行时默认"));
    const save = screen.getByRole("button", { name: "保存模型" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.click(picker);
    // 运行时默认那一项写明现在实际是哪个模型
    expect(screen.getByRole("option", { name: /运行时默认.*现在是 GPT A/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /^gpt-b/ }));
    fireEvent.click(save);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(agent.id, { model: "gpt-b" }));
    expect(await screen.findByText("已保存。")).toBeTruthy();

    fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
    fireEvent.click(screen.getByRole("option", { name: /^手动输入/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "模型名" }), {
      target: { value: " my/custom-model " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith(agent.id, { model: "my/custom-model" }),
    );

    fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
    fireEvent.click(screen.getByRole("option", { name: /^运行时默认/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));
    await waitFor(() => expect(updateSettings).toHaveBeenLastCalledWith(agent.id, { model: null }));

    // 刷新：让 Server 重新拉一次
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(models).toHaveBeenLastCalledWith(agent.id, true));
  });

  it("picks a reasoning effort that follows the chosen model and saves it with the model", async () => {
    const codexModels: LocalAgentModelsResponse = {
      source: "runtime",
      models: [
        { id: "gpt-a", isDefault: true, efforts: ["low", "high"], defaultEffort: "high" },
        { id: "gpt-b", efforts: ["xhigh"], defaultEffort: "xhigh" },
      ],
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    };
    const updateSettings = vi.fn(
      async (_id: string, settings: { model?: string | null; effort?: string | null }) => ({
        ...agent,
        model: settings.model ?? null,
        effort: settings.effort ?? null,
      }),
    );
    render(
      <AgentSettingsDialog
        agent={{ ...agent, provider: "codex" }}
        local={{
          mcpServers: async () => listed,
          updateSettings,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => codexModels,
        }}
        onClose={() => undefined}
      />,
    );
    const effort = await screen.findByRole("combobox", { name: "思考强度" });
    expect(effort.textContent).toContain("跟随 CLI 配置");
    fireEvent.click(effort);
    // 运行时默认模型 gpt-a 只有 low、high 两档，并写明默认档
    expect(
      screen.getByRole("option", { name: /跟随 CLI 配置.*这个模型默认是 高 · high/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("option", { name: /xhigh/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /^低 · low/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存模型和强度" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith(agent.id, { model: null, effort: "low" }),
    );

    // 换到 gpt-b：low 它不支持，仍列出并提示
    fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
    fireEvent.click(screen.getByRole("option", { name: /^gpt-b/ }));
    expect(screen.getByText(/当前模型不支持 low/)).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "思考强度" }));
    fireEvent.click(screen.getByRole("option", { name: /^很高 · xhigh/ }));
    expect(screen.queryByText(/当前模型不支持/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存模型和强度" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith(agent.id, {
        model: "gpt-b",
        effort: "xhigh",
      }),
    );
  });

  it("hides the reasoning effort for runtimes that cannot switch it", async () => {
    render(
      <AgentSettingsDialog
        agent={{ ...agent, provider: "opencode" }}
        local={{
          mcpServers: async () => listed,
          updateSettings: async () => agent,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => modelList,
        }}
        onClose={() => undefined}
      />,
    );
    await screen.findByRole("combobox", { name: "模型" });
    await waitFor(() => expect(screen.getByRole("button", { name: "保存模型" })).toBeTruthy());
    expect(screen.queryByRole("combobox", { name: "思考强度" })).toBeNull();
  });

  it("shows why the model list could not be fetched and still allows typing one", async () => {
    render(
      <AgentSettingsDialog
        agent={{ ...agent, model: "legacy-model" }}
        local={{
          mcpServers: async () => listed,
          updateSettings: async () => agent,
          act: async () => undefined,
          canManage: true,
          logs: async () => [],
          remove: async () => undefined,
          models: async () => ({
            source: "preset",
            models: [],
            efforts: [],
            error: "spawn codex ENOENT",
          }),
        }}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText(/没能从运行时拉到模型列表（spawn codex ENOENT）/)).toBeTruthy();
    // 设置里的模型不在列表里：直接显示在手填框里
    expect((screen.getByRole("textbox", { name: "模型名" }) as HTMLInputElement).value).toBe(
      "legacy-model",
    );
  });

  it("formats token counts", () => {
    expect(formatTokens(800)).toBe("800");
    expect(formatTokens(12_000)).toBe("1.2 万");
    expect(formatTokens(350_000)).toBe("35 万");
  });

  it("restarts or stops the agent right from its settings, and starts it again once stopped", async () => {
    const act = vi.fn(async () => undefined);
    const props = {
      mcpServers: vi.fn(async () => listed),
      updateSettings: vi.fn(async () => agent),
      act,
      canManage: true,
      logs: vi.fn(async () => ["[hive] 已加入 #build"]),
      remove: vi.fn(async () => undefined),
      models: vi.fn(async () => modelList),
    };
    const { rerender } = render(
      <AgentSettingsDialog agent={agent} local={props} onClose={() => undefined} />,
    );
    expect(screen.getByText("运行中 · 版本未上报 · 空闲")).toBeTruthy();
    // 「重启」等它空闲；「立即重启」要先确认
    expect(screen.getByRole("button", { name: "立即重启" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重启" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(agent.id, "restart"));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(agent.id, "stop"));

    rerender(
      <AgentSettingsDialog
        agent={{ ...agent, status: "stopped" }}
        local={props}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "重启" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "启动" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(agent.id, "start"));

    // 日志和删除也在这里（不再单独放一块本机 Agent 列表）
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    expect(await screen.findByText(/已加入 #build/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const confirm = screen.getByRole("alert");
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(props.remove).toHaveBeenCalledWith(agent.id));
  });
});
