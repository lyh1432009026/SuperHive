import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeWarmRegistry, claudeMaxWarm } from "./claude-warm-registry.js";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hive-warm-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ClaudeWarmRegistry", () => {
  it("keeps at most max idle processes and evicts the least recently used", () => {
    const dir = scratch();
    let now = 1_000;
    const registry = new ClaudeWarmRegistry({ dir, max: 2, now: () => now });
    const first = registry.park()!;
    now += 10;
    const second = registry.park()!;
    now += 10;
    const third = registry.park()!;
    // 第一个最久没用：被淘汰，主人轮询时会结束它
    expect(first.held()).toBe(false);
    expect(second.held()).toBe(true);
    expect(third.held()).toBe(true);
    third.release();
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("drops entries whose bridge is gone without counting them", () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "dead.json"), JSON.stringify({ pid: 999_999, lastUsedAt: 5 }));
    const registry = new ClaudeWarmRegistry({
      dir,
      max: 1,
      isAlive: (pid) => pid === process.pid,
    });
    const ticket = registry.park()!;
    expect(ticket.held()).toBe(true);
    expect(readdirSync(dir)).toEqual([path.basename(ticket.file)]);
  });

  it("does nothing when unlimited", () => {
    const registry = new ClaudeWarmRegistry({ dir: scratch(), max: 0 });
    expect(registry.park()).toBeUndefined();
  });

  it("reads HIVE_CLAUDE_MAX_WARM: default 8, 0 = unlimited, junk falls back", () => {
    expect(claudeMaxWarm(undefined)).toBe(8);
    expect(claudeMaxWarm("")).toBe(8);
    expect(claudeMaxWarm("3")).toBe(3);
    expect(claudeMaxWarm("0")).toBe(0);
    expect(claudeMaxWarm("-1")).toBe(8);
    expect(claudeMaxWarm("abc")).toBe(8);
  });
});
