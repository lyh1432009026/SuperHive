// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Invocation } from "@superhive/protocol";
import { InvocationChips } from "./invocations";
import { RetryModelDialog } from "./model-picker";

afterEach(cleanup);

const at = "2026-11-14T13:00:00.000Z";
const failed: Invocation = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "general",
  messageId: "m",
  agentId: "a",
  agentName: "rd-codex",
  requesterName: "rd",
  requesterType: "human",
  status: "failed",
  attempts: 1,
  createdAt: at,
  updatedAt: at,
};
const chipProps = {
  participants: [],
  canJumpTo: () => true,
  onJump: vi.fn(),
  onRetry: vi.fn(),
  onCancel: vi.fn(),
  onExtend: vi.fn(),
};

describe("换个模型重试", () => {
  it("shows the button only on failed tasks, and only to the owner", () => {
    const onRetryWithModel = vi.fn();
    const { rerender } = render(
      <InvocationChips {...chipProps} invocations={[failed]} onRetryWithModel={onRetryWithModel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "换个模型重试 @rd-codex" }));
    expect(onRetryWithModel).toHaveBeenCalledWith(failed);
    // 普通「重试」还在
    expect(screen.getByRole("button", { name: /^重试 @rd-codex/ })).toBeTruthy();

    rerender(
      <InvocationChips
        {...chipProps}
        invocations={[failed]}
        isOwner={false}
        onRetryWithModel={onRetryWithModel}
      />,
    );
    expect(screen.queryByRole("button", { name: /换个模型重试/ })).toBeNull();
    rerender(
      <InvocationChips
        {...chipProps}
        invocations={[{ ...failed, status: "completed" }]}
        onRetryWithModel={onRetryWithModel}
      />,
    );
    expect(screen.queryByRole("button", { name: /换个模型重试/ })).toBeNull();
  });

  it("says under the buttons what retrying will do", () => {
    render(
      <InvocationChips
        {...chipProps}
        invocations={[{ ...failed, detail: "x", detailText: { key: "bridge.transientFailed" } }]}
        onRetryWithModel={vi.fn()}
      />,
    );
    const note = screen.getByText("还没开始执行，重试安全");
    expect(note.className).toBe("invocation-consequence");
    // 读屏读按钮时一并读出后果
    expect(
      screen.getByRole("button", { name: /^重试 @rd-codex/ }).getAttribute("aria-describedby"),
    ).toBe(note.id);
    // 悬停提示的说明接在后果后面
    expect(
      screen
        .getByRole("button", { name: "换个模型重试 @rd-codex" })
        .getAttribute("aria-describedby")
        ?.split(" ")[0],
    ).toBe(note.id);
  });

  it("retries once with a model picked from the runtime's list", async () => {
    const onRetry = vi.fn();
    const load = vi.fn(async () => ({
      source: "runtime" as const,
      models: [{ id: "gpt-a", isDefault: true }, { id: "gpt-b" }],
      efforts: [],
    }));
    render(
      <RetryModelDialog
        agentName="rd-codex"
        currentModel="gpt-a"
        load={load}
        onRetry={onRetry}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("只对这一次重试生效，之后还是用它设置里的模型 gpt-a。")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "重试" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const picker = screen.getByRole("combobox", { name: "模型" });
    await waitFor(() => expect((picker as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(picker);
    // 换模型重试没有「运行时默认」这一项
    expect(screen.queryByRole("option", { name: /运行时默认/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /^gpt-b/ }));
    fireEvent.click(screen.getByRole("button", { name: "用 gpt-b 重试" }));
    expect(onRetry).toHaveBeenCalledWith("gpt-b", "");
  });

  it("retries once with only a different reasoning effort", async () => {
    const onRetry = vi.fn();
    const load = vi.fn(async () => ({
      source: "preset" as const,
      models: [{ id: "opus" }],
      efforts: ["low", "medium", "high", "xhigh", "max"],
    }));
    render(
      <RetryModelDialog
        agentName="rd-claude"
        currentModel="opus"
        load={load}
        onRetry={onRetry}
        onClose={() => undefined}
      />,
    );
    const effort = await screen.findByRole("combobox", { name: "思考强度" });
    expect(effort.textContent).toContain("不换");
    fireEvent.click(effort);
    fireEvent.click(screen.getByRole("option", { name: /^最高 · max/ }));
    fireEvent.click(screen.getByRole("button", { name: "用 最高 · max 思考强度重试" }));
    expect(onRetry).toHaveBeenCalledWith("", "max");
  });

  it("asks for a typed model name when the agent is not on this computer", () => {
    const onRetry = vi.fn();
    render(<RetryModelDialog agentName="remote" onRetry={onRetry} onClose={() => undefined} />);
    expect(
      screen.getByText("这个 Agent 不在这台电脑上，拿不到它的模型列表，请手动输入模型名。"),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "模型名" }), {
      target: { value: "claude-opus-5-5" },
    });
    fireEvent.submit(screen.getByRole("dialog"));
    expect(onRetry).toHaveBeenCalledWith("claude-opus-5-5", "");
  });
});
