/* global window, localStorage, Response, URL */
// 截图用的测试替身：沙箱不连飞书、微信，「连接 IM」弹窗的各个状态都由这里造。
// 用法：pnpm screenshot --url $SANDBOX_URL --init-script scripts/fixtures/im.js \
//   --action eval:"localStorage.setItem('im-fixture','list')" --action "click:.sidebar-action[aria-haspopup=dialog]"
// 场景放在 localStorage 的 im-fixture 里（页面加载前读一次，之后改了要刷新）：
//   empty        还没有连接
//   list         三个连接：正常、需要重新扫码、推送暂停
//   waiting_scan / scanned / need_code / connecting / failed / succeeded
//                「新增连接」里点扫码后停在这个状态（二维码是占位图）
(() => {
  const scene = localStorage.getItem("im-fixture") ?? "list";
  const now = Date.now();
  const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const json = (body, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  const delivery = (extra = {}) => ({ pending: 0, filtered: 0, ...extra });
  const connection = (n, extra) => ({
    id: `2000000${n}-0000-4000-8000-000000000000`,
    roomId: "build",
    roomName: "build",
    ownerName: "rd",
    level: "mine",
    locale: "zh-CN",
    scope: "all",
    status: "connected",
    createdAt: iso(60 * 24 * 3),
    delivery: delivery({ lastSentAt: iso(4) }),
    lastInboundAt: iso(12),
    ...extra,
  });
  const connections =
    scene === "empty"
      ? []
      : [
          connection(1, { channel: "feishu", label: "SuperHive 助手" }),
          connection(2, {
            channel: "feishu",
            label: "研发群机器人",
            status: "error",
            attention: "relogin",
            detail: "飞书凭据已过期",
          }),
          connection(3, {
            channel: "wechat",
            label: "个人微信",
            attention: "needs_message",
            heldSince: iso(25),
            delivery: delivery({ lastSentAt: iso(40), pending: 3 }),
          }),
        ];
  // 二维码占位：黑白格子的 SVG，只看排版
  const cells = Array.from({ length: 21 * 21 }, (_, i) =>
    (i * 7919) % 5 < 2
      ? `<rect x="${i % 21}" y="${Math.floor(i / 21)}" width="1" height="1"/>`
      : "",
  ).join("");
  const qr = `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 25 25" shape-rendering="crispEdges"><rect x="-2" y="-2" width="25" height="25" fill="#fff"/>${cells}</svg>`,
  )}`;
  let login;
  const loginView = (channel) => {
    const status = scene === "list" || scene === "empty" ? "waiting_scan" : scene;
    return {
      id: "30000000-0000-4000-8000-000000000000",
      channel,
      roomId: "build",
      status,
      ...(["waiting_scan", "scanned", "need_code", "connecting"].includes(status)
        ? { qrDataUrl: qr, qrUrl: "https://example.com/qr" }
        : {}),
      ...(status === "failed" ? { error: "二维码已过期，请重新扫码" } : {}),
    };
  };
  const original = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const path = new URL(url, window.location.href).pathname;
    const method = (init.method ?? "GET").toUpperCase();
    if (path === "/api/im/channels")
      return json({ feishu: { enabled: true }, wechat: { enabled: true } });
    if (path === "/api/im/connections") return json({ connections });
    if (/^\/api\/rooms\/[^/]+\/im$/.test(path)) return json({ connections });
    if (/^\/api\/rooms\/[^/]+\/im\/login$/.test(path) && method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      login = loginView(body.channel ?? "feishu");
      return json(login);
    }
    if (path.startsWith("/api/im/logins/")) {
      if (method === "DELETE" && login) login = { ...login, status: "cancelled" };
      return json(login ?? { error: "not found" }, login ? 200 : 404);
    }
    if (path.startsWith("/api/im/connections/")) return json(connections[0]);
    return original(input, init);
  };
})();
