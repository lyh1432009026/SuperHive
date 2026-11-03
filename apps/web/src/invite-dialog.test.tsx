// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InviteDialog } from "./invite-dialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InviteDialog", () => {
  it("lets guests see agents' activity by default and sends the switch with the invite", async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          return new Response(
            JSON.stringify({
              token: "hvi_x",
              invite: {
                id: "00000000-0000-4000-8000-000000000001",
                roomId: "general",
                createdAt: new Date().toISOString(),
                expiresAt: null,
                allowAgents: false,
                showTrace: false,
                uses: 0,
              },
            }),
            { status: 201 },
          );
        }
        return new Response(JSON.stringify({ invites: [] }), { status: 200 });
      }),
    );
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });
    render(
      <InviteDialog
        base="http://hive"
        adminToken="t"
        roomId="general"
        linkFor={(token) => `http://hive/#invite=${token}`}
        onClose={() => {}}
      />,
    );
    const trace = screen.getByRole("switch", { name: /让对方看到 Agent 的执行过程/ });
    expect(trace.getAttribute("aria-checked")).toBe("true");
    await user.click(trace);
    expect(trace.getAttribute("aria-checked")).toBe("false");
    await user.click(screen.getByRole("button", { name: /生成/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ allowAgents: false, showTrace: false });
  });
});
