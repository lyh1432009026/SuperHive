import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  combCells,
  isDarkColor,
  loadSplashTheme,
  parseSplashAction,
  resolveDark,
  saveSplashTheme,
  SPLASH_TIMING,
  SplashController,
  splashHtml,
  splashUpdateScript,
  splashVariant,
  themeFromAppearance,
  type SplashModel,
} from "./splash.js";

function setup(lang: "zh" | "en" = "zh") {
  vi.useFakeTimers();
  const renders: SplashModel[] = [];
  const done = vi.fn();
  const controller = new SplashController({
    lang,
    render: (model) => renders.push(model),
    done,
  });
  return { controller, renders, done };
}

describe("SplashController", () => {
  it("启动快时不出任何文字，ready 后播完退场动画再收起", () => {
    const { controller, renders, done } = setup();
    expect(controller.model()).toEqual({ state: "loading", status: null, hint: null });
    controller.setPhase("loading");
    vi.advanceTimersByTime(300);
    controller.ready();
    expect(renders.at(-1)).toEqual({ state: "leaving" });
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SPLASH_TIMING.leaveMs);
    expect(done).toHaveBeenCalledTimes(1);
    // 之后的计时不会再把状态文字画出来
    vi.advanceTimersByTime(SPLASH_TIMING.slowDelayMs);
    expect(renders.filter((model) => model.state === "loading")).toHaveLength(0);
    controller.ready();
    vi.advanceTimersByTime(SPLASH_TIMING.leaveMs);
    expect(done).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("加载久了才淡入状态文字，跟着阶段变；再久补一行提示", () => {
    const { controller, renders } = setup();
    vi.advanceTimersByTime(SPLASH_TIMING.statusDelayMs - 1);
    expect(renders).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(renders.at(-1)).toEqual({ state: "loading", status: "正在启动本机 Hive…", hint: null });
    controller.setPhase("connecting");
    expect(renders.at(-1)).toMatchObject({ status: "正在连接本机 Hive…" });
    controller.setPhase("loading");
    expect(renders.at(-1)).toMatchObject({ status: "正在打开界面…" });
    vi.advanceTimersByTime(SPLASH_TIMING.slowDelayMs);
    expect((renders.at(-1) as { hint: string }).hint).toContain("第一次启动");
    vi.useRealTimers();
  });

  it("英文文案", () => {
    const { controller } = setup("en");
    vi.advanceTimersByTime(SPLASH_TIMING.statusDelayMs);
    expect(controller.model()).toMatchObject({ status: "Starting the local Hive…" });
    vi.useRealTimers();
  });

  it("出错时停下：写明原因和日志位置，不会自己消失，ready 也不收起；重试后从头来", () => {
    const { controller, renders, done } = setup();
    controller.fail("Server exited (code 1)", "日志：/tmp/server.log");
    expect(renders.at(-1)).toEqual({
      state: "error",
      title: "SuperHive 没能启动",
      detail: "Server exited (code 1)",
      log: "日志：/tmp/server.log",
    });
    expect(controller.isFailed).toBe(true);
    const count = renders.length;
    vi.advanceTimersByTime(SPLASH_TIMING.slowDelayMs * 2);
    controller.setPhase("loading");
    controller.ready();
    expect(renders).toHaveLength(count);
    expect(done).not.toHaveBeenCalled();

    controller.restart("starting");
    expect(controller.isFailed).toBe(false);
    expect(controller.model()).toEqual({ state: "loading", status: null, hint: null });
    controller.ready();
    vi.advanceTimersByTime(SPLASH_TIMING.leaveMs);
    expect(done).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("收起之后再出错不再盖回来", () => {
    const { controller, renders } = setup();
    controller.ready();
    controller.fail("boom", "log");
    expect(renders.at(-1)).toEqual({ state: "leaving" });
    vi.useRealTimers();
  });
});

describe("页面", () => {
  it("两套动画、主题标记、减少动态效果和出错画面都在页面里", () => {
    const html = splashHtml({ lang: "zh", theme: "dark", variant: "signal" });
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('class="v-signal"');
    expect(html).toContain("prefers-reduced-motion:reduce");
    expect(html).toContain("@keyframes breathe");
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain('data-action="retry">重试</button>');
    expect(html).toContain('data-action="logs">打开日志目录</button>');
    // CSP：不加载任何外部资源
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/https?:\/\//);
    expect(splashHtml({ lang: "en", theme: "system", variant: "comb" })).toMatch(
      /class="v-comb"[\s\S]*data-action="retry">Retry</,
    );
  });

  it("初始状态写进页面，第一帧就对", () => {
    const html = splashHtml({
      lang: "zh",
      theme: "light",
      variant: "signal",
      initial: { state: "error", title: "<x>", detail: "</script><b>", log: "l" },
    });
    // 内联脚本里的数据转义过，拼不出 </script>
    expect(html).not.toContain("</script><b>");
    expect(html).toContain("\\u003c/script>");
  });

  it("页面按钮的动作只认三种", () => {
    expect(parseSplashAction("superhive-splash:retry:1")).toBe("retry");
    expect(parseSplashAction("superhive-splash:logs:12")).toBe("logs");
    expect(parseSplashAction("superhive-splash:quit:3")).toBe("quit");
    expect(parseSplashAction("superhive-splash:retry")).toBeUndefined();
    expect(parseSplashAction("superhive-splash:rm:1")).toBeUndefined();
    expect(parseSplashAction("SuperHive")).toBeUndefined();
    expect(parseSplashAction("x superhive-splash:retry:1")).toBeUndefined();
  });

  it("主进程切状态的脚本只传 JSON", () => {
    const script = splashUpdateScript({
      state: "error",
      title: "a",
      detail: '"); evil("',
      log: "",
    });
    expect(script).toBe(
      'window.__splash && window.__splash({"state":"error","title":"a","detail":"\\"); evil(\\"","log":""})',
    );
  });

  it("comb 方案七个格子：中间一格加一圈六格，都在 logo 范围内", () => {
    const cells = combCells();
    expect(cells).toHaveLength(7);
    expect(cells[0]).toMatchObject({ dx: 0, dy: 0 });
    for (const cell of cells) {
      for (const [, x, y] of cell.d.matchAll(/([\d.]+) ([\d.]+)/g)) {
        expect(Number(x)).toBeGreaterThanOrEqual(3);
        expect(Number(x)).toBeLessThanOrEqual(45);
        expect(Number(y)).toBeGreaterThanOrEqual(3);
        expect(Number(y)).toBeLessThanOrEqual(45);
      }
    }
  });

  it("用环境变量切换方案，默认 signal", () => {
    expect(splashVariant({})).toBe("signal");
    expect(splashVariant({ SUPERHIVE_DESKTOP_SPLASH: "comb" })).toBe("comb");
    expect(splashVariant({ SUPERHIVE_DESKTOP_SPLASH: "x" })).toBe("signal");
  });
});

describe("主题", () => {
  it("按网页顶栏底色判断深浅，和系统一致时记成跟随系统", () => {
    expect(isDarkColor("#212121")).toBe(true);
    expect(isDarkColor("#ffffff")).toBe(false);
    expect(isDarkColor("oops")).toBe(false);
    expect(themeFromAppearance("#212121", true)).toBe("system");
    expect(themeFromAppearance("#212121", false)).toBe("dark");
    expect(themeFromAppearance("#ffffff", true)).toBe("light");
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("light", true)).toBe(false);
    expect(resolveDark("dark", false)).toBe(true);
  });

  it("存取上次的主题，坏文件按跟随系统", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "splash-theme-"));
    const file = path.join(dir, "splash-theme.json");
    expect(loadSplashTheme(file)).toBe("system");
    saveSplashTheme(file, "dark");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ theme: "dark" });
    expect(loadSplashTheme(file)).toBe("dark");
    writeFileSync(file, '{"theme":"neon"}');
    expect(loadSplashTheme(file)).toBe("system");
    writeFileSync(file, "nope");
    expect(loadSplashTheme(file)).toBe("system");
  });
});
