/**
 * 启动加载画面：蜂巢 logo 动画，铺满主窗口，盖在网页上面的一层 WebContentsView 里。
 *
 * 流程：窗口一打开就显示这一层 → 起本机 Hive / 连上已有的 → 网页在下面加载 →
 * 网页首屏画好后通知主进程 → logo 缩小淡出、背景变透明，露出已经画好的主界面。全程一个窗口、一段动画。
 *
 * - 动画只用 CSS + 内联 SVG，没有外部资源；页面是 data: URL，CSP 只放行内联样式和这一段内联脚本。
 * - 主进程经 executeJavaScript 调页面上的 window.__splash(model) 切状态；页面上的按钮通过改 document.title
 *   告诉主进程（page-title-updated；data: 页面改 hash 不算导航，收不到），页面本身拿不到任何 Node / IPC 能力。
 * - 这里只放纯函数和不碰 Electron 的状态机，方便单测；和窗口打交道的部分在 main.ts。
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Lang } from "./texts.js";
import { text } from "./texts.js";

/** 两套动画：signal = 描边画出、点亮中心、信号往外扩散（默认）；comb = 小六边形一格格拼出再汇成 logo */
export type SplashVariant = "signal" | "comb";
export type SplashTheme = "dark" | "light" | "system";

export function splashVariant(env: Record<string, string | undefined>): SplashVariant {
  return env.SUPERHIVE_DESKTOP_SPLASH === "comb" ? "comb" : "signal";
}

// ---------- 主题 ----------

/** 和网页 tokens.css 的 --bg-main 对齐：窗口底色、加载页底色、网页底色三者一致，切换时不闪 */
export const SPLASH_BACKGROUND = { dark: "#212121", light: "#ffffff" } as const;

export function isDarkColor(hex: string): boolean {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return false;
  const [r, g, b] = match.slice(1).map((part) => Number.parseInt(part, 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.5;
}

/**
 * 上次网页用的主题，下次启动加载页直接用它：网页里手动选了深色、系统是浅色时，不会先白一下再变黑。
 * 上次的主题和当时的系统主题一致，就记成 system，下次跟着系统走。
 */
export type SavedSplashTheme = { theme: SplashTheme };

export function themeFromAppearance(color: string, systemDark: boolean): SplashTheme {
  const dark = isDarkColor(color);
  return dark === systemDark ? "system" : dark ? "dark" : "light";
}

export function loadSplashTheme(file: string): SplashTheme {
  try {
    const value = (JSON.parse(readFileSync(file, "utf8")) as Partial<SavedSplashTheme>).theme;
    return value === "dark" || value === "light" ? value : "system";
  } catch {
    return "system";
  }
}

export function saveSplashTheme(file: string, theme: SplashTheme): void {
  try {
    writeFileSync(file, `${JSON.stringify({ theme } satisfies SavedSplashTheme)}\n`);
  } catch {
    /* 存不下来只影响下次启动的第一帧配色 */
  }
}

export function resolveDark(theme: SplashTheme, systemDark: boolean): boolean {
  return theme === "system" ? systemDark : theme === "dark";
}

// ---------- 状态 ----------

/** starting：自己起本机 Hive；connecting：连已有的；loading：网页加载中 */
export type SplashPhase = "starting" | "connecting" | "loading";

export type SplashModel =
  | { state: "loading"; status: string | null; hint: string | null }
  | { state: "error"; title: string; detail: string; log: string }
  | { state: "leaving" };

export type SplashTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const SPLASH_TIMING = {
  /** 启动快的时候什么字都不出，只有 logo；过了这么久还没好，才在下方淡入一行状态 */
  statusDelayMs: 1800,
  /** 再久一些，补一行「首次启动要多等一会儿」 */
  slowDelayMs: 12_000,
  /** 退场动画的时长（和页面 CSS 一致），播完再把这一层拿掉 */
  leaveMs: 460,
} as const;

/**
 * 加载页的状态机。不管时间从哪来、画到哪去：render 收到的 model 交给页面，done 时主进程拿掉这一层。
 * ready 之后再来的 phase / fail 都不理（网页已经露出来了）；fail 之后可以 restart 重来。
 */
export class SplashController {
  private phase: SplashPhase = "starting";
  private statusVisible = false;
  private slow = false;
  private failed = false;
  private finished = false;
  private statusTimer: unknown;
  private slowTimer: unknown;
  private leaveTimer: unknown;

  constructor(
    private readonly options: {
      lang: Lang;
      render: (model: SplashModel) => void;
      done: () => void;
      timers?: SplashTimers;
      timing?: Partial<typeof SPLASH_TIMING>;
    },
  ) {
    this.restart("starting");
  }

  private get timers(): SplashTimers {
    return (
      this.options.timers ?? {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
      }
    );
  }

  private timing<K extends keyof typeof SPLASH_TIMING>(key: K): number {
    return this.options.timing?.[key] ?? SPLASH_TIMING[key];
  }

  private clearTimers(): void {
    this.timers.clearTimeout(this.statusTimer);
    this.timers.clearTimeout(this.slowTimer);
    this.timers.clearTimeout(this.leaveTimer);
  }

  /** 当前页面应显示的内容 */
  model(): SplashModel {
    if (this.finished) return { state: "leaving" };
    if (this.failed) return this.errorModel ?? { state: "leaving" };
    const t = (key: Parameters<typeof text>[1]) => text(this.options.lang, key);
    const status = this.statusVisible
      ? t(
          this.phase === "starting"
            ? "splashStarting"
            : this.phase === "connecting"
              ? "splashConnecting"
              : "splashLoading",
        )
      : null;
    return { state: "loading", status, hint: this.slow ? t("splashSlow") : null };
  }

  private errorModel: Extract<SplashModel, { state: "error" }> | undefined;

  private render(): void {
    this.options.render(this.model());
  }

  /** 开始（或出错后重试）：动画从头来，状态文字重新计时 */
  restart(phase: SplashPhase = "starting"): void {
    this.clearTimers();
    this.phase = phase;
    this.failed = false;
    this.finished = false;
    this.errorModel = undefined;
    this.statusVisible = false;
    this.slow = false;
    this.statusTimer = this.timers.setTimeout(() => {
      this.statusVisible = true;
      this.render();
    }, this.timing("statusDelayMs"));
    this.slowTimer = this.timers.setTimeout(() => {
      this.slow = true;
      this.render();
    }, this.timing("slowDelayMs"));
  }

  setPhase(phase: SplashPhase): void {
    if (this.finished || this.failed || phase === this.phase) return;
    this.phase = phase;
    if (this.statusVisible) this.render();
  }

  /** 出错：动画停下，写明原因，给重试按钮。不会自己消失 */
  fail(detail: string, log: string): void {
    if (this.finished) return;
    this.clearTimers();
    this.failed = true;
    this.errorModel = {
      state: "error",
      title: text(this.options.lang, "startFailedTitle"),
      detail,
      log,
    };
    this.render();
  }

  get isFailed(): boolean {
    return this.failed;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** 网页画好了：播退场动画，播完通知拿掉这一层。重复调用只算一次 */
  ready(): void {
    if (this.finished || this.failed) return;
    this.clearTimers();
    this.finished = true;
    this.render();
    this.leaveTimer = this.timers.setTimeout(() => this.options.done(), this.timing("leaveMs"));
  }

  dispose(): void {
    this.clearTimers();
  }
}

/** 页面按钮经 document.title 传回来的动作：「superhive-splash:retry:3」→ retry（序号让连点两次也算两次） */
export type SplashAction = "retry" | "logs" | "quit";

export function parseSplashAction(title: string): SplashAction | undefined {
  const action = /^superhive-splash:([a-z]+):\d+$/.exec(title)?.[1];
  return action === "retry" || action === "logs" || action === "quit" ? action : undefined;
}

/** 主进程调页面切状态用的脚本；model 经 JSON 序列化，不拼接任何未转义的文字 */
export function splashUpdateScript(model: SplashModel): string {
  return `window.__splash && window.__splash(${JSON.stringify(model)})`;
}

// ---------- 页面 ----------

const OUTER = "m24 3 18 10.5v21L24 45 6 34.5v-21L24 3Z";
const INNER = "m24 12 10 6v12l-10 6-10-6V18l10-6Z";

/** 尖顶朝上的正六边形（和 logo 同向），中心 (cx, cy)、外接圆半径 r */
export function hexPath(cx: number, cy: number, r: number): string {
  const points = [-90, -30, 30, 90, 150, 210].map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return `${(cx + r * Math.cos(rad)).toFixed(2)} ${(cy + r * Math.sin(rad)).toFixed(2)}`;
  });
  return `M${points.join("L")}Z`;
}

/** comb 方案的七个蜂巢格：中间一格，外面一圈六格，按顺时针一格格出现 */
export function combCells(r = 6.4): { d: string; dx: number; dy: number }[] {
  const step = Math.sqrt(3) * r;
  const centers: [number, number][] = [[0, 0]];
  for (const deg of [-60, 0, 60, 120, 180, 240]) {
    const rad = (deg * Math.PI) / 180;
    centers.push([step * Math.cos(rad), step * Math.sin(rad)]);
  }
  return centers.map(([dx, dy]) => ({ d: hexPath(24 + dx, 24 + dy, r - 0.6), dx, dy }));
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

const CSS = `
:root{color-scheme:light;--bg:${SPLASH_BACKGROUND.light};--text:#0d0d0d;--muted:#5d5d5d;--faint:#8f8f8f;--g1:#0169cc;--g2:#b86e00;--ring:#0169cc;--btn:#0d0d0d;--btn-text:#fff;--line:rgb(0 0 0/.1)}
:root[data-theme=dark]{color-scheme:dark;--bg:${SPLASH_BACKGROUND.dark};--text:#ececec;--muted:#b4b4b4;--faint:#8e8e8e;--g1:#48aaff;--g2:#ffc46b;--ring:#48aaff;--btn:#ececec;--btn-text:#0d0d0d;--line:rgb(255 255 255/.12)}
@media (prefers-color-scheme:dark){:root[data-theme=system]{color-scheme:dark;--bg:${SPLASH_BACKGROUND.dark};--text:#ececec;--muted:#b4b4b4;--faint:#8e8e8e;--g1:#48aaff;--g2:#ffc46b;--ring:#48aaff;--btn:#ececec;--btn-text:#0d0d0d;--line:rgb(255 255 255/.12)}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden}
body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI","Microsoft YaHei",system-ui,sans-serif;-webkit-app-region:drag;user-select:none;cursor:default;display:grid;place-items:center;transition:background-color .42s cubic-bezier(.4,0,.2,1)}
.stage{display:flex;flex-direction:column;align-items:center;gap:22px;margin-top:-4vh}
.logo{width:96px;height:96px;overflow:visible;transition:transform .42s cubic-bezier(.4,0,.2,1),opacity .36s ease-in,filter .3s}
.logo .s1{stop-color:var(--g1)}.logo .s2{stop-color:var(--g2)}
.stroke{fill:none;stroke:url(#g);stroke-width:2.6;stroke-linejoin:round;stroke-linecap:round}
.dot{fill:url(#g);transform-box:fill-box;transform-origin:center}
.ring{fill:none;stroke:var(--ring);stroke-width:1.3;stroke-linejoin:round;vector-effect:non-scaling-stroke;opacity:0;transform-box:fill-box;transform-origin:center}
.glow{fill:var(--ring);opacity:0;filter:blur(2.2px);transform-box:fill-box;transform-origin:center}
/* 外框上绕着走的一道高光：只在深色底上好看，浅色底上像断了一截，不画 */
.sweep{display:none;fill:none;stroke:#fff;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:9 91;opacity:0;mix-blend-mode:overlay}
:root[data-theme=dark] .sweep{display:inline}
@media (prefers-color-scheme:dark){:root[data-theme=system] .sweep{display:inline}}
.status{min-height:52px;text-align:center;opacity:0;transform:translateY(4px);transition:opacity .5s ease,transform .5s ease}
.status p{margin:0;color:var(--muted)}.status small{display:block;margin-top:4px;color:var(--faint);font-size:12.5px}
body.show-status .status{opacity:1;transform:none}
.error{display:none;max-width:min(520px,86vw);text-align:center}
.error h1{margin:0 0 8px;font-size:17px;font-weight:600}
.error .detail{margin:0;color:var(--muted);white-space:pre-wrap;word-break:break-word;user-select:text;-webkit-app-region:no-drag;cursor:text}
.error .log{margin:8px 0 0;color:var(--faint);font:12px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace;word-break:break-all;user-select:text;-webkit-app-region:no-drag;cursor:text}
.actions{display:flex;gap:10px;justify-content:center;margin-top:22px}
button{-webkit-app-region:no-drag;font:inherit;font-size:13.5px;border-radius:999px;padding:7px 16px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer}
button.primary{background:var(--btn);color:var(--btn-text);border-color:transparent}
button:focus-visible{outline:2px solid var(--ring);outline-offset:2px}

/* ---- signal：描边画出 → 点亮中心 → 信号往外扩散 ---- */
.v-signal .outer{stroke-dasharray:100;stroke-dashoffset:100;animation:draw .95s cubic-bezier(.65,0,.35,1) .08s forwards}
.v-signal .inner{opacity:.5;stroke-dasharray:100;stroke-dashoffset:-100;animation:draw .8s cubic-bezier(.65,0,.35,1) .42s forwards}
.v-signal .dot{transform:scale(0);animation:pop .5s cubic-bezier(.34,1.56,.64,1) 1s forwards}
/* ---- comb：七个小六边形一格格拼出，再收拢成 logo ---- */
.cells{display:none}
.v-comb .cells{display:inline}
.cell{fill:none;stroke:url(#g);stroke-width:1.5;stroke-linejoin:round;opacity:0;transform-box:fill-box;transform-origin:center;animation:cell-in .34s cubic-bezier(.34,1.56,.64,1) forwards,cell-merge .42s cubic-bezier(.65,0,.35,1) 1.02s forwards}
.v-comb .outer{opacity:0;transform-box:fill-box;transform-origin:center;animation:frame-in .5s cubic-bezier(.22,1,.36,1) 1.08s forwards}
.v-comb .inner{opacity:0;transform-box:fill-box;transform-origin:center;animation:frame-in-half .5s cubic-bezier(.22,1,.36,1) 1.16s forwards}
.v-comb .dot{transform:scale(0);animation:pop .5s cubic-bezier(.34,1.56,.64,1) 1.22s forwards}
/* ---- 两套共用的等待循环：中心一圈圈往外扩散（Agent 上线的信号），外框上一道光绕着走 ---- */
.v-signal .ring{animation:ring 2.2s cubic-bezier(.2,.6,.35,1) 1.3s infinite}
.v-signal .ring.r2{animation-delay:2.4s}
.v-signal .glow{animation:glow-on .5s ease-out 1s forwards,heartbeat 2.2s ease-in-out 1.5s infinite}
.v-comb .ring{animation:ring 2.2s cubic-bezier(.2,.6,.35,1) 1.6s infinite}
.v-comb .ring.r2{animation-delay:2.7s}
.v-comb .glow{animation:glow-on .5s ease-out 1.22s forwards,heartbeat 2.2s ease-in-out 1.72s infinite}
.sweep{animation:sweep 2.6s linear 1.4s infinite}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes pop{0%{transform:scale(0)}100%{transform:scale(1)}}
@keyframes ring{0%{opacity:.7;transform:scale(1)}100%{opacity:0;transform:scale(9)}}
@keyframes glow-on{from{opacity:0;transform:scale(.4)}to{opacity:.55;transform:scale(1)}}
@keyframes heartbeat{0%,100%{opacity:.55;transform:scale(1)}14%{opacity:.85;transform:scale(1.35)}28%{opacity:.5;transform:scale(1)}42%{opacity:.75;transform:scale(1.2)}}
@keyframes sweep{0%{stroke-dashoffset:100;opacity:0}12%{opacity:.75}88%{opacity:.75}100%{stroke-dashoffset:0;opacity:0}}
@keyframes cell-in{from{opacity:0;transform:scale(.3)}to{opacity:.95;transform:scale(1)}}
@keyframes cell-merge{from{opacity:.95;transform:translate(0,0) scale(1)}to{opacity:0;transform:translate(var(--mx),var(--my)) scale(.35)}}
@keyframes frame-in{from{opacity:0;transform:scale(.82)}to{opacity:1;transform:scale(1)}}
@keyframes frame-in-half{from{opacity:0;transform:scale(.7)}to{opacity:.5;transform:scale(1)}}
@keyframes breathe{from{opacity:.55}to{opacity:1}}

/* ---- 退场：logo 缩小淡出，底色变透明，露出下面已经画好的主界面 ---- */
body[data-state=leaving]{background-color:transparent}
body[data-state=leaving] .logo{transform:scale(.72);opacity:0}
body[data-state=leaving] .status{opacity:0;transition-duration:.2s}
/* ---- 出错：动画停下，logo 变灰静止，写明原因 ---- */
body[data-state=error] .logo{opacity:.4;filter:grayscale(1)}
body[data-state=error] .logo *{animation:none!important}
body[data-state=error] .outer,body[data-state=error] .inner{stroke-dashoffset:0;opacity:1;transform:none}
body[data-state=error] .inner{opacity:.5}
body[data-state=error] .dot{transform:none}
body[data-state=error] .cell,body[data-state=error] .ring,body[data-state=error] .sweep,body[data-state=error] .glow{opacity:0}
body[data-state=error] .status{display:none}
body[data-state=error] .error{display:block}
/* ---- 减少动态效果：静态 logo，只有轻微的明暗变化 ---- */
@media (prefers-reduced-motion:reduce){
  .logo *{animation:none!important}
  .outer,.inner{stroke-dashoffset:0!important;opacity:1!important;transform:none!important}
  .inner{opacity:.5!important}
  .dot{transform:none!important}
  .cell,.ring,.sweep,.glow{display:none!important}
  body[data-state=loading] .logo{animation:breathe 1.6s ease-in-out infinite alternate}
  .logo,.status{transition:opacity .2s linear!important}
  body[data-state=leaving] .logo{transform:none}
}
`;

const SCRIPT = `
(function(){
  var n=0,body=document.body;
  function $(id){return document.getElementById(id)}
  window.__splash=function(m){
    if(m.state==="leaving"&&document.getAnimations){
      // 启动很快、logo 还没画完就要退场：不硬等，把还没播完的入场动画加速播完，边画完边缩小淡出
      document.getAnimations().forEach(function(a){
        var t=a.effect&&a.effect.getTiming?a.effect.getTiming():null;
        if(t&&t.iterations!==Infinity&&a.playState!=="finished")a.updatePlaybackRate(5);
      });
    }
    body.dataset.state=m.state;
    if(m.state==="loading"){
      $("status-text").textContent=m.status||"";
      $("status-hint").textContent=m.hint||"";
      body.classList.toggle("show-status",!!m.status);
    }else if(m.state==="error"){
      $("error-title").textContent=m.title;
      $("error-detail").textContent=m.detail;
      $("error-log").textContent=m.log;
      body.classList.remove("show-status");
      var retry=document.querySelector('[data-action="retry"]');
      if(retry)retry.focus({focusVisible:false});
    }
  };
  document.querySelectorAll("[data-action]").forEach(function(b){
    b.addEventListener("click",function(){document.title="superhive-splash:"+b.getAttribute("data-action")+":"+(++n)});
  });
})();
`;

/** 加载页的完整 HTML（data: URL 载入） */
export function splashHtml(options: {
  lang: Lang;
  theme: SplashTheme;
  variant: SplashVariant;
  initial?: SplashModel;
}): string {
  const t = (key: Parameters<typeof text>[1]) => escapeHtml(text(options.lang, key));
  const cells = combCells()
    .map(
      (cell, index) =>
        `<path class="cell" d="${cell.d}" style="animation-delay:${(0.06 + index * 0.075).toFixed(3)}s,1.02s;--mx:${(-cell.dx * 0.9).toFixed(2)}px;--my:${(-cell.dy * 0.9).toFixed(2)}px"/>`,
    )
    .join("");
  const initial = options.initial ?? { state: "loading", status: null, hint: null };
  return `<!doctype html><html lang="${options.lang === "zh" ? "zh-CN" : "en"}" data-theme="${options.theme}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>SuperHive</title><style>${CSS}</style></head>
<body class="v-${options.variant}" data-state="loading">
<main class="stage" aria-busy="true">
<svg class="logo" viewBox="0 0 48 48" role="img" aria-label="SuperHive">
<defs><linearGradient id="g" x1="6" y1="6" x2="42" y2="42" gradientUnits="userSpaceOnUse"><stop class="s1" offset="0"/><stop class="s2" offset="1"/></linearGradient></defs>
<g class="cells">${cells}</g>
<path class="ring" d="${hexPath(24, 24, 3.4)}"/><path class="ring r2" d="${hexPath(24, 24, 3.4)}"/>
<path class="stroke outer" pathLength="100" d="${OUTER}"/>
<path class="stroke inner" pathLength="100" d="${INNER}"/>
<path class="sweep" pathLength="100" d="${OUTER}"/>
<circle class="glow" cx="24" cy="24" r="4.6"/>
<circle class="dot" cx="24" cy="24" r="3"/>
</svg>
<div class="status" role="status" aria-live="polite"><p id="status-text"></p><small id="status-hint"></small></div>
<section class="error" role="alert"><h1 id="error-title"></h1><p class="detail" id="error-detail"></p><p class="log" id="error-log"></p>
<div class="actions"><button class="primary" data-action="retry">${t("retry")}</button><button data-action="logs">${t("openLogs")}</button><button data-action="quit">${t("quit")}</button></div></section>
</main>
<script>${SCRIPT}window.__splash(${JSON.stringify(initial).replace(/</g, "\\u003c")});</script>
</body></html>`;
}
