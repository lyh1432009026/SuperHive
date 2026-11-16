// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalAgent } from "@superhive/protocol";
import { LocalLaunch, type LocalAgentsState } from "./local-agents";

function makeLocal() {
  const create = vi.fn(async () => ({ id: "a1" }) as LocalAgent);
  const local = {
    enabled: true,
    mode: "local",
    canManage: true,
    providers: [{ provider: "claude", command: "claude", installed: true, version: "1" }],
    agents: [],
    create,
    mcpCandidates: vi.fn(),
    directories: vi.fn(),
  } as unknown as LocalAgentsState;
  return { create, local };
}

function nameField(): HTMLInputElement {
  return screen.getByLabelText("Agent 名称") as HTMLInputElement;
}

describe("LocalLaunch 默认名建议", () => {
  afterEach(cleanup);

  it("用户手改名字后，重名自增的新建议不再覆盖输入", () => {
    const { local } = makeLocal();
    const view = render(
      <LocalLaunch
        local={local}
        provider="claude"
        access="read-only"
        defaultName="rd-claude"
        providerLabel="Claude Code"
      >
        <span />
      </LocalLaunch>,
    );
    fireEvent.change(nameField(), { target: { value: "my-agent" } });
    // 房间里加入同名成员后建议自增，但不应动用户的手动输入
    view.rerender(
      <LocalLaunch
        local={local}
        provider="claude"
        access="read-only"
        defaultName="rd-claude2"
        providerLabel="Claude Code"
      >
        <span />
      </LocalLaunch>,
    );
    expect(nameField().value).toBe("my-agent");
  });

  it("没手改过时跟随最新建议；切换 provider 重新采用建议", () => {
    const { local } = makeLocal();
    const view = render(
      <LocalLaunch
        local={local}
        provider="claude"
        access="read-only"
        defaultName="rd-claude"
        providerLabel="Claude Code"
      >
        <span />
      </LocalLaunch>,
    );
    expect(nameField().value).toBe("rd-claude");
    view.rerender(
      <LocalLaunch
        local={local}
        provider="claude"
        access="read-only"
        defaultName="rd-claude2"
        providerLabel="Claude Code"
      >
        <span />
      </LocalLaunch>,
    );
    expect(nameField().value).toBe("rd-claude2");

    fireEvent.change(nameField(), { target: { value: "custom" } });
    view.rerender(
      <LocalLaunch
        local={local}
        provider="codex"
        access="read-only"
        defaultName="rd-codex"
        providerLabel="Codex"
      >
        <span />
      </LocalLaunch>,
    );
    expect(nameField().value).toBe("rd-codex");
  });
});

describe("LocalLaunch 一次接入多个", () => {
  afterEach(cleanup);

  it("按数量依次启动，名字从第一个往后自增并跳过房间里已有的", async () => {
    let next = 0;
    const { local, create } = makeLocal();
    create.mockImplementation(async () => ({ id: `a${++next}` }) as LocalAgent);
    render(
      <LocalLaunch
        local={local}
        provider="claude"
        access="read-only"
        defaultName="rd-claude"
        takenNames={new Set(["rd-claude2"])}
        providerLabel="Claude Code"
      >
        <span />
      </LocalLaunch>,
    );
    // 步进器：点两次「+」到 3，方向键也能调，到上限后「+」不可点
    fireEvent.click(screen.getByRole("button", { name: "增加" }));
    fireEvent.click(screen.getByRole("button", { name: "增加" }));
    const spin = screen.getByRole("spinbutton", { name: "一次接入几个" });
    expect(spin.getAttribute("aria-valuenow")).toBe("3");
    fireEvent.keyDown(spin, { key: "End" });
    expect(spin.getAttribute("aria-valuenow")).toBe("5");
    expect((screen.getByRole("button", { name: "增加" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(spin, { key: "ArrowDown" });
    fireEvent.keyDown(spin, { key: "ArrowDown" });
    expect(screen.getByText("将依次启动：rd-claude、rd-claude3、rd-claude4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /在本机启动 ×3/ }));
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    expect(
      (create.mock.calls as unknown as Array<[{ name: string }]>).map(([body]) => body.name),
    ).toEqual(["rd-claude", "rd-claude3", "rd-claude4"]);
  });
});
