// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { badgedFaviconSvg, badgedTitle, faviconHref, pickFaviconBadge } from "./favicon-badge";

describe("favicon badge", () => {
  it("按优先级取最重要的一种：需要你处理 > 有任务在跑 > 做完未看", () => {
    expect(pickFaviconBadge({ attention: 1, running: 2, unseen: 3 })).toBe("attention");
    expect(pickFaviconBadge({ attention: 0, running: 2, unseen: 3 })).toBe("running");
    expect(pickFaviconBadge({ attention: 0, running: 0, unseen: 3 })).toBe("unseen");
    expect(pickFaviconBadge({ attention: 0, running: 0, unseen: 0 })).toBeUndefined();
  });

  it("在原图标上叠圆点和描边，没有状态时用原图标", () => {
    expect(faviconHref(undefined)).toBe("/favicon.svg");
    const svg = badgedFaviconSvg("attention");
    expect(svg).toContain('fill="#e5484d"');
    expect(svg).toContain("hive-badge-ring");
    expect(svg.trim().endsWith("</svg>")).toBe(true);
    expect(faviconHref("running")).toMatch(/^data:image\/svg\+xml/);
  });

  it("标题前缀只数需要你处理的，重复设置不会叠加", () => {
    expect(badgedTitle("SuperHive", 2)).toBe("(2) SuperHive");
    expect(badgedTitle("(2) SuperHive", 3)).toBe("(3) SuperHive");
    expect(badgedTitle("(3) SuperHive", 0)).toBe("SuperHive");
    expect(badgedTitle("SuperHive", 120)).toBe("(99+) SuperHive");
  });
});
