// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ImDialog } from "./im-dialog";
import { getLocalePreference, setLocalePreference } from "./i18n";

type Route = { method: string; url: string; body?: unknown };

function mockServer(handler: (route: Route) => unknown) {
  const calls: Route[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const route = {
        method: init.method ?? "GET",
        url: url.replace("http://hive", ""),
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      };
      calls.push(route);
      return new Response(JSON.stringify(handler(route)), { status: 200 });
    }),
  );
  return calls;
}

describe("连接 IM 弹窗", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("个人微信需要先确认风险，扫码时显示二维码", async () => {
    const calls = mockServer((route) => {
      if (route.url === "/api/im/channels")
        return { feishu: { enabled: true }, wechat: { enabled: true } };
      if (route.url === "/api/rooms/build/im") return { connections: [] };
      if (route.url.endsWith("/im/login"))
        return {
          id: "11111111-1111-4111-8111-111111111111",
          channel: "wechat",
          roomId: "build",
          status: "waiting_scan",
          qrDataUrl: "data:image/png;base64,AAAA",
        };
      return {};
    });
    render(
      <ImDialog
        base="http://hive"
        adminToken="t"
        roomId="build"
        ownerName="rd"
        onClose={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByRole("radio", { name: "个人微信" }));
    const start = screen.getByRole("button", { name: "扫码连接个人微信" });
    expect(start).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(start);
    expect(await screen.findByAltText("个人微信扫码二维码")).toBeTruthy();
    expect(calls.find((call) => call.url.endsWith("/im/login"))?.body).toEqual({
      channel: "wechat",
      ownerName: "rd",
      // 机器人先说网页当前的语言
      locale: "zh-CN",
      acceptRisk: true,
    });
  });

  it("关闭个人微信时只显示飞书，并列出已有连接", async () => {
    mockServer((route) => {
      if (route.url === "/api/im/channels")
        return { feishu: { enabled: true }, wechat: { enabled: false } };
      if (route.url === "/api/rooms/build/im")
        return {
          connections: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              roomId: "build",
              channel: "feishu",
              ownerName: "rd",
              label: "SuperHive 助手",
              status: "connected",
              level: "mine",
              delivery: { pending: 0, filtered: 3 },
              createdAt: new Date().toISOString(),
            },
          ],
        };
      return {};
    });
    render(
      <ImDialog
        base="http://hive"
        adminToken="t"
        roomId="build"
        ownerName="rd"
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByText("飞书 · SuperHive 助手")).toBeTruthy());
    expect(screen.queryByRole("radio", { name: "个人微信" })).toBeNull();
    expect(screen.getByRole("radio", { name: "与我相关" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByText(/按档位未推 3 条/)).toBeTruthy();
  });

  it("切换推送档位", async () => {
    const calls = mockServer((route) => {
      if (route.url === "/api/im/channels")
        return { feishu: { enabled: true }, wechat: { enabled: false } };
      if (route.url === "/api/rooms/build/im")
        return {
          connections: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              roomId: "build",
              channel: "feishu",
              ownerName: "rd",
              label: "SuperHive 助手",
              status: "connected",
              level: "mine",
              delivery: { pending: 0, filtered: 0 },
              createdAt: new Date().toISOString(),
            },
          ],
        };
      return {};
    });
    render(
      <ImDialog
        base="http://hive"
        adminToken="t"
        roomId="build"
        ownerName="rd"
        onClose={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByRole("radio", { name: "全部消息" }));
    await waitFor(() =>
      expect(calls.find((call) => call.url.endsWith("/level"))?.body).toEqual({ level: "all" }),
    );
  });
});

describe("连接 IM 弹窗的语言", () => {
  const original = getLocalePreference();
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setLocalePreference(original);
  });

  it("服务端的结构化文案按网页语言显示，没有时用原文；可以切机器人的语言", async () => {
    setLocalePreference("en");
    const connection = {
      id: "22222222-2222-4222-8222-222222222222",
      roomId: "build",
      channel: "wechat",
      ownerName: "rd",
      label: "Personal WeChat",
      status: "error",
      detail: "微信登录已过期，请重新扫码连接。",
      detailText: { key: "error.im.wechatExpired" },
      level: "mine",
      locale: "zh-CN",
      delivery: { pending: 0, failed: 0, sent: 0, filtered: 0 },
      createdAt: "2026-11-10T00:00:00.000Z",
    };
    const calls = mockServer((route) => {
      if (route.url === "/api/im/channels")
        return { feishu: { enabled: true }, wechat: { enabled: true } };
      if (route.url === "/api/rooms/build/im") return { connections: [connection] };
      if (route.url.endsWith("/locale")) return { ...connection, locale: "en" };
      return {};
    });
    render(
      <ImDialog
        base="http://hive"
        adminToken="t"
        roomId="build"
        ownerName="rd"
        onClose={() => undefined}
      />,
    );
    expect(
      await screen.findByText(
        /Your WeChat sign-in expired\. Scan the QR code again to reconnect\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/微信登录已过期/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    await waitFor(() =>
      expect(calls.find((call) => call.url.endsWith("/locale"))?.body).toEqual({ locale: "en" }),
    );
  });
});
