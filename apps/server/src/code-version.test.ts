import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { codeVersionAt, packageRootOfCli } from "./code-version.js";

const superhiveRoot = path.resolve(import.meta.dirname, "../../../packages/superhive");

describe("codeVersionAt", () => {
  it("computes the same version as the Bridge for this checkout, so fingerprints compare directly", async () => {
    // Bridge 那份在另一个包里（不在本包 rootDir 内）：按路径动态加载，免得类型检查把它算进来
    const bridge = (await import(
      pathToFileURL(path.join(superhiveRoot, "src/code-version.ts")).href
    )) as { codeVersionAt: (root: string) => unknown };
    const server = await codeVersionAt(superhiveRoot);
    expect(server).toEqual(bridge.codeVersionAt(superhiveRoot));
    expect(server?.fingerprint).toMatch(/^[0-9a-f]{16}\.[0-9a-f]{16}$/);
  });

  it("only reports the package version outside a source checkout", async () => {
    const root = path.join(
      mkdtempSync(path.join(tmpdir(), "hive-npm-")),
      "node_modules",
      "superhive",
    );
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.4.0" }));
    const calls: string[][] = [];
    const git = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return "";
    };
    expect(await codeVersionAt(root, git)).toEqual({ package: "0.4.0" });
    expect(calls).toEqual([]);
    // 读不到 package.json：判断不出来
    expect(await codeVersionAt(path.join(root, "missing"), git)).toBeUndefined();
  });

  it("falls back to the package version when git fails", async () => {
    const version = await codeVersionAt(superhiveRoot, async () => {
      throw new Error("git missing");
    });
    expect(version).toEqual({ package: expect.stringMatching(/^\d+\.\d+\.\d+/) });
  });
});

describe("packageRootOfCli", () => {
  it("finds the package from the dev and the packaged entry", () => {
    expect(
      packageRootOfCli([
        "--import",
        "file:///x/tsx/index.mjs",
        "/repo/packages/superhive/src/cli.ts",
      ]),
    ).toBe("/repo/packages/superhive");
    expect(packageRootOfCli(["/usr/lib/node_modules/superhive/dist/cli.js"])).toBe(
      "/usr/lib/node_modules/superhive",
    );
    expect(packageRootOfCli(["--version"])).toBeUndefined();
  });
});
