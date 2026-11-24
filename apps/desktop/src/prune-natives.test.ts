import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { nativeExtras, prune } = require("../scripts/prune-natives.cjs") as {
  nativeExtras: (list: (dir: string) => string[], platform: string, arch: string) => string[];
  prune: (args: { buildPath: string; platform: string; arch: string }) => Promise<void>;
};

const tree: Record<string, string[]> = {
  "node-pty/prebuilds": ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"],
  "node-pty/prebuilds/win32-x64": ["pty.node", "pty.pdb", "conpty", "winpty.dll", "winpty.pdb"],
  "better-sqlite3/prebuilds": ["darwin-arm64.node", "linuxmusl-x64.node", "win32-x64.node"],
};

describe("prune-natives", () => {
  it("keeps only the target platform's prebuilds and drops debug symbols and sources", () => {
    const removed = nativeExtras((dir) => tree[dir] ?? [], "win32", "x64");
    expect(removed).toEqual(
      expect.arrayContaining([
        "node-pty/prebuilds/darwin-arm64",
        "node-pty/prebuilds/win32-arm64",
        "node-pty/prebuilds/win32-x64/pty.pdb",
        "node-pty/prebuilds/win32-x64/winpty.pdb",
        "better-sqlite3/prebuilds/darwin-arm64.node",
        "better-sqlite3/prebuilds/linuxmusl-x64.node",
        "node-pty/third_party",
        "better-sqlite3/deps",
      ]),
    );
    for (const kept of [
      "node-pty/prebuilds/win32-x64",
      "node-pty/prebuilds/win32-x64/pty.node",
      "node-pty/prebuilds/win32-x64/conpty",
      "node-pty/prebuilds/win32-x64/winpty.dll",
      "better-sqlite3/prebuilds/win32-x64.node",
    ]) {
      expect(removed).not.toContain(kept);
    }
  });

  it("deletes the files in a copied app and tolerates missing modules", async () => {
    const buildPath = mkdtempSync(path.join(tmpdir(), "prune-natives-"));
    try {
      const modules = path.join(buildPath, "node_modules");
      for (const [dir, names] of Object.entries(tree)) {
        for (const name of names) {
          const file = path.join(modules, dir, name);
          if (name.includes(".")) {
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, "");
          } else mkdirSync(file, { recursive: true });
        }
      }
      await prune({ buildPath, platform: "darwin", arch: "arm64" });
      expect(readdirSync(path.join(modules, "node-pty/prebuilds"))).toEqual(["darwin-arm64"]);
      expect(readdirSync(path.join(modules, "better-sqlite3/prebuilds"))).toEqual([
        "darwin-arm64.node",
      ]);
      await prune({ buildPath: path.join(buildPath, "missing"), platform: "linux", arch: "x64" });
    } finally {
      rmSync(buildPath, { recursive: true, force: true });
    }
  });
});
