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
