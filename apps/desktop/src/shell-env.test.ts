import { describe, expect, it } from "vitest";
import {
  loginShellEnv,
  loginShellPath,
  mergePath,
  mergeProxyEnv,
  parseEnvDump,
} from "./shell-env.js";

describe("mergePath", () => {
  it("puts the shell PATH first and de-duplicates", () => {
    expect(mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin", ":")).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
    expect(mergePath(undefined, "/usr/bin", ":")).toBe("/usr/bin");
  });
});

describe("loginShellPath", () => {
  it("is skipped on Windows", async () => {
    expect(await loginShellPath({}, "win32")).toBeUndefined();
  });

  it("reads PATH from the login shell even when it prints noise", async () => {
    if (process.platform === "win32") return;
    const value = await loginShellPath(
      { ...process.env, SHELL: "/bin/sh", PATH: "/usr/bin:/bin" },
      process.platform,
    );
    expect(value).toContain("/usr/bin");
  });
});

describe("login shell proxy variables", () => {
  it("picks PATH and proxy variables out of an env dump with noise around it", () => {
    const dump = [
      "Welcome to zsh!",
      "__SUPERHIVE_PATH_START__",
      "HOME=/Users/me",
      "PATH=/opt/homebrew/bin:/usr/bin",
      "https_proxy=http://127.0.0.1:7890",
      "ALL_PROXY=socks5://127.0.0.1:7890",
      "NO_PROXY=localhost,127.0.0.1",
      "GREETING=multi",
      "line value",
      "__SUPERHIVE_PATH_END__",
    ].join("\n");
    expect(parseEnvDump(dump)).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      https_proxy: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5://127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1",
    });
    expect(parseEnvDump("zsh: command not found")).toBeUndefined();
  });

  it("only fills proxy variables when the app has none of its own", () => {
    const target: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    expect(
      mergeProxyEnv(target, { https_proxy: "http://p:1", NO_PROXY: "x", PATH: "/bin" }),
    ).toEqual(["https_proxy", "NO_PROXY"]);
    expect(target).toEqual({ PATH: "/usr/bin", https_proxy: "http://p:1", NO_PROXY: "x" });
    const already: NodeJS.ProcessEnv = { HTTP_PROXY: "http://mine:2" };
    expect(mergeProxyEnv(already, { https_proxy: "http://p:1" })).toEqual([]);
    expect(already).toEqual({ HTTP_PROXY: "http://mine:2" });
  });

  it("reads exported proxy variables from a real shell", async () => {
    if (process.platform === "win32") return;
    const value = await loginShellEnv(
      {
        ...process.env,
        SHELL: "/bin/sh",
        PATH: "/usr/bin:/bin",
        HTTPS_PROXY: "http://127.0.0.1:9",
      },
      process.platform,
    );
    expect(value?.HTTPS_PROXY).toBe("http://127.0.0.1:9");
  });
});
