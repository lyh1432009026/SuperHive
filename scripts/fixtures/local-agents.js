/* global window, location, URL, Response, MessageEvent */
// 截图用的测试替身：沙箱里不起本机 Agent，/api/local/* 都是关的。
// 用法：pnpm screenshot --url $SANDBOX_URL --init-script scripts/fixtures/local-agents.js --action settings:computer
// 在页面加载前拦截 fetch 和房间快照，假装页面开在 Server 所在电脑上，并给出几个本机 Agent（忙、空闲、旧版本、已停止）。
(() => {
  const now = new Date().toISOString();
  const current = {
    package: "0.3.1",
    commit: "8c41d0e9a7b2c3d4e5f60718293a4b5c6d7e8f90",
    fingerprint: "a1b2c3d4e5f60718.0718293a4b5c6d7e",
  };
  const agent = (n, name, provider, extra) => ({
    id: `0000000${n}-0000-4000-8000-000000000000`,
    provider,
    name,
    access: "full",
    cwd: "/Users/rd/Coding/ai-hive",
    model: null,
    status: "running",
    pid: 1000 + n,
    startedAt: now,
    lastExitCode: null,
    lastError: null,
    restarts: 0,
    createdAt: now,
    mcpDisabled: [],
    autoSteer: false,
    ...extra,
  });
  let autoUpdate = true;
  const agents = [
    agent(1, "rd-claude", "claude", {
      busy: true,
      outdated: true,
      restartWhenIdle: true,
      version: {
        ...current,
        commit: "277e2c5f00d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5",
        fingerprint: "old",
      },
    }),
    agent(2, "rd-codex", "codex", { busy: false, version: current }),
    agent(3, "rd-claude3", "claude", { busy: false, outdated: true, restartWhenIdle: true }),
    agent(4, "glm2", "omp", { status: "stopped", pid: null }),
  ];
  const json = (body) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  // 成员列表：房间快照里补上这几个在线的本机 Agent，rd-claude 和 rd-claude3 跑的是旧代码
  const members = agents
    .filter((item) => item.status === "running")
    .map((item, index) => ({
      id: `1000000${index}-0000-4000-8000-000000000000`,
      username: item.name,
      type: "agent",
      status: item.busy ? "busy" : "online",
      provider: item.provider,
      persona: "通用协作 Agent",
      joinedAt: now,
      lastSeenAt: now,
      ...(item.version ? { version: item.version } : {}),
      ...(item.outdated ? { outdated: true } : {}),
    }));
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    addEventListener(type, listener, options) {
      if (type !== "message") return super.addEventListener(type, listener, options);
      return super.addEventListener(
        type,
        (event) => {
          const data = JSON.parse(event.data);
          if (data.type !== "room.snapshot") return listener.call(this, event);
          const roomId = data.self.roomId;
          data.participants = [
            ...data.participants,
            ...members.map((member) => ({ ...member, roomId })),
          ];
          listener.call(this, new MessageEvent("message", { data: JSON.stringify(data) }));
        },
        options,
      );
    }
  };
  const original = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href).pathname;
    const method = (init.method ?? "GET").toUpperCase();
    if (url === "/api/local/session") {
      return json({ enabled: true, mode: "local", ownerToken: "fixture", hostLabel: "sandbox" });
    }
    if (url === "/api/local/agents" && method === "GET") {
      return json({
        agents,
        autoUpdate,
        ...(autoUpdate !== undefined ? { currentVersion: current } : {}),
      });
    }
    // 用户菜单「在其他设备登录」：两台已登录的设备
    if (url === "/api/local/owner-devices" && method === "GET") {
      return json({
        devices: [
          { id: "d1", name: "iPhone", source: "pair", createdAt: now, lastSeenAt: now },
          { id: "d2", name: "MacBook Air", source: "im", createdAt: now, lastSeenAt: now },
        ],
      });
    }
    if (url === "/api/local/host-approvers" && method === "GET") return json({ approvers: [] });
    if (url === "/api/local/agents/auto-update") {
      autoUpdate = JSON.parse(String(init.body ?? "{}")).enabled ?? autoUpdate;
      return json({ autoUpdate });
    }
    return original(input, init);
  };
})();
