import { describe, expect, it } from "vitest";
import { autostartPlan, type AutostartInput } from "./autostart.js";

const base: AutostartInput = {
  platform: "darwin",
  home: "/Users/me",
  node: "/opt/node/bin/node",
  cli: "/opt/lib/node_modules/superhive/dist/cli.js",
  startArgs: ["--port", "9000", "--public-url", "https://hive.example.com/a&b"],
  pathEnv: "/opt/homebrew/bin:/usr/bin",
  logFile: "/Users/me/.superhive/autostart.log",
};

describe("autostartPlan", () => {
  it("writes a per-user LaunchAgent on macOS that runs hive start in the foreground at login", () => {
    const plan = autostartPlan(base);
    expect(plan.file).toBe("/Users/me/Library/LaunchAgents/dev.superhive.server.plist");
    expect(plan.content).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plan.content).toContain(
      [
        "<string>/opt/node/bin/node</string>",
        "<string>/opt/lib/node_modules/superhive/dist/cli.js</string>",
        "<string>start</string>",
        "<string>--foreground</string>",
        "<string>--no-open</string>",
        "<string>--port</string>",
        "<string>9000</string>",
      ].join("\n    "),
    );
    // XML 转义；带上当前 PATH，开机时才找得到 claude、codex
    expect(plan.content).toContain("https://hive.example.com/a&amp;b");
    expect(plan.content).toContain("<string>/opt/homebrew/bin:/usr/bin</string>");
    expect(plan.content).toContain("<key>WorkingDirectory</key>\n  <string>/Users/me</string>");
    // 不立即启动，也不常驻重启（hive stop 之后不会被拉回来）
    expect(plan.content).not.toContain("KeepAlive");
    expect(plan.afterWrite).toEqual([]);
  });

  it("writes and enables a systemd user unit on Linux", () => {
    const plan = autostartPlan({
      ...base,
      platform: "linux",
      home: "/home/me",
      cli: "/home/me/my apps/superhive/dist/cli.js",
    });
    expect(plan.file).toBe("/home/me/.config/systemd/user/superhive.service");
    expect(plan.content).toContain(
      'ExecStart=/opt/node/bin/node "/home/me/my apps/superhive/dist/cli.js" start --foreground --no-open --port 9000',
    );
    expect(plan.content).toContain("WantedBy=default.target");
    expect(plan.afterWrite).toContainEqual(["systemctl", "--user", "enable", "superhive.service"]);
    expect(plan.beforeRemove).toEqual([["systemctl", "--user", "disable", "superhive.service"]]);
  });

  it("drops a launcher into the Startup folder on Windows that starts the background server", () => {
    const plan = autostartPlan({
      ...base,
      platform: "win32",
      home: "C:\\Users\\me",
      appData: "C:\\Users\\me\\AppData\\Roaming",
      node: "C:\\Program Files\\nodejs\\node.exe",
      cli: "C:\\npm\\node_modules\\superhive\\dist\\cli.js",
      startArgs: [],
    });
    expect(plan.file).toMatch(/Startup[\\/]SuperHive\.cmd$/);
    expect(plan.content).toContain(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\superhive\\dist\\cli.js" "start" "--no-open"',
    );
    expect(plan.content).not.toContain("--foreground");
    expect(plan.content).toContain("\r\n");
  });
});
