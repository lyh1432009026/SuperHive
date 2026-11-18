// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCredentialsWithAgents } from "./local-agents";
import { REVEAL_MS, RuntimeCredentialsGroup } from "./runtime-credentials";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SECRET = "sk-ant-claude-secret-0123456789";

const runtime = (
  provider: "claude" | "codex",
  overrides: Partial<RuntimeCredentialsWithAgents> = {},
): RuntimeCredentialsWithAgents => ({
  provider,
  files: [provider === "claude" ? "~/.claude/settings.json" : "~/.codex/config.toml"],
  baseUrl: {
    set: true,
    masked: "https://clau••••.com",
    editable: true,
    location: "~/.claude/settings.json → env.ANTHROPIC_BASE_URL",
  },
  apiKey: {
    set: true,
    masked: "sk-a••••6789",
    editable: provider === "claude",
    location: "~/.claude/settings.json → env.ANTHROPIC_AUTH_TOKEN",
    ...(provider === "codex" ? { note: "密钥从环境变量 GW_KEY 读取" } : {}),
  },
  agents: provider === "claude" ? [{ id: "a1", name: "rd-claude", status: "running" }] : [],
  ...overrides,
});

const api = () => ({
  runtimeCredentials: vi.fn(async () => [runtime("claude"), runtime("codex")]),
  revealRuntimeCredential: vi.fn(async () => SECRET),
  updateRuntimeCredentials: vi.fn(async () =>
    runtime("claude", {
      apiKey: {
        set: true,
        masked: "sk-n••••0000",
        editable: true,
        location: "~/.claude/settings.json → env.ANTHROPIC_AUTH_TOKEN",
      },
    }),
  ),
  act: vi.fn(async () => undefined),
});

const claudeKeyValue = () => screen.getAllByLabelText("API key 的值")[0]!;

describe("RuntimeCredentialsGroup", () => {
  it("shows masked values and marks keys that can't be edited", async () => {
    const client = api();
    render(<RuntimeCredentialsGroup api={client} />);
    await screen.findByText("Claude Code");
    expect(claudeKeyValue().textContent).toBe("sk-a••••6789");
    expect(screen.getByText("密钥从环境变量 GW_KEY 读取")).toBeTruthy();
    // Claude 两项可改，Codex 只有地址能改
    expect(screen.getAllByText("修改")).toHaveLength(3);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("reveals the full value only after confirming, and hides it again after 30 seconds", async () => {
    const client = api();
    render(<RuntimeCredentialsGroup api={client} />);
    await screen.findByText("Claude Code");
    vi.useFakeTimers();
    fireEvent.click(screen.getAllByText("显示")[1]!);
    expect(client.revealRuntimeCredential).not.toHaveBeenCalled();
    // 取消不取值
    fireEvent.click(screen.getByText("取消"));
    expect(client.revealRuntimeCredential).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByText("显示")[1]!);
    const dialog = screen.getByRole("dialog", { name: "确认显示完整的 API key" });
    await act(async () => {
      fireEvent.click(dialog.querySelector("button.primary")!);
    });
    expect(client.revealRuntimeCredential).toHaveBeenCalledWith("claude", "apiKey");
    expect(claudeKeyValue().textContent).toBe(SECRET);
    act(() => {
      vi.advanceTimersByTime(REVEAL_MS);
    });
    expect(claudeKeyValue().textContent).toBe("sk-a••••6789");
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("warns about the terminal CLI before saving, then offers to restart the affected agents", async () => {
    const client = api();
    render(<RuntimeCredentialsGroup api={client} />);
    await screen.findByText("Claude Code");
    fireEvent.click(screen.getAllByText("修改")[1]!);
    fireEvent.change(screen.getByLabelText("新的 API key"), {
      target: { value: "sk-new-0000" },
    });
    fireEvent.click(screen.getByText("保存"));
    expect(client.updateRuntimeCredentials).not.toHaveBeenCalled();
    const confirm = screen.getByRole("dialog", { name: "确认修改 API key" });
    expect(confirm.textContent).toContain("会同时影响终端里的 Claude Code");
    await act(async () => {
      fireEvent.click(confirm.querySelector("button.primary")!);
    });
    expect(client.updateRuntimeCredentials).toHaveBeenCalledWith("claude", {
      apiKey: "sk-new-0000",
    });
    expect(screen.getByText("已保存。需要重启这些 Agent 才生效：rd-claude")).toBeTruthy();
    expect(claudeKeyValue().textContent).toBe("sk-n••••0000");

    fireEvent.click(screen.getByText("重启这 1 个 Agent"));
    await waitFor(() => expect(client.act).toHaveBeenCalledWith("a1", "restart"));
    await screen.findByText("已重启 1 个 Agent");
  });

  it("does not submit an invalid URL and shows server errors", async () => {
    const client = api();
    client.updateRuntimeCredentials.mockRejectedValueOnce(new Error("写入失败，原文件没有改动"));
    render(<RuntimeCredentialsGroup api={client} />);
    await screen.findByText("Claude Code");
    fireEvent.click(screen.getAllByText("修改")[0]!);
    const input = screen.getByLabelText("新的 接口地址（base URL）");
    fireEvent.change(input, { target: { value: "not a url" } });
    expect((screen.getByText("保存") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "https://new.example.com" } });
    fireEvent.click(screen.getByText("保存"));
    await act(async () => {
      fireEvent.click(
        screen
          .getByRole("dialog", { name: "确认修改 接口地址（base URL）" })
          .querySelector("button.primary")!,
      );
    });
    expect(await screen.findByText("写入失败，原文件没有改动")).toBeTruthy();
  });
});
