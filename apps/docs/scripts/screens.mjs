#!/usr/bin/env node
// 重截文档里的界面配图（public/media/screens/*.{light,dark}.png）：一条命令起演示 Server、截图、压缩。
//
//   pnpm --filter @superhive/docs screens                    # 全部重截
//   pnpm --filter @superhive/docs screens --only overview,progress
//
// 演示 Server（screens/demo-server.mjs）在临时目录里起：独立 HOME、独立数据库、演示仓库，只监听 127.0.0.1，
// 不连 IM、不拉起真实 Agent、不联网；截完关掉并删除临时目录。截图用独立的无头 Chrome（仓库根
// scripts/screenshot.mjs 的同一套），按 2 倍像素截，再转成 8 位调色板 PNG。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { HELPERS, findChrome, initialStorage, launchChrome } from "../../../scripts/screenshot.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const OUT_DIR = path.resolve(import.meta.dirname, "../public/media/screens");
const SCALE = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 每张图：打开哪个房间、视口多大、先做什么、截哪一块。
 * prepare / clip 是在页面里执行的脚本；clip 返回 CSS 像素的矩形，pad 往外留白。
 * 消息在 .message-list 的 shadow DOM 里，用 __shot.deep 找。
 */
export const SHOTS = [
  {
    name: "overview",
    room: "shop-web",
    // 合入可清理的提示条要等任务目录状态算完
    prepare: [`__shot.find(".worktree-batch")`],
  },
  {
    name: "sidebar",
    room: "shop-web",
    clip: `__shot.rect(".rooms-panel")`,
  },
  {
    name: "mention",
    // 没有聊天记录的房间：弹窗背后是空白，不压在消息上
    room: "mobile",
    // 视口高一些：空房间居中的「开始第一条消息」离输入框远，不进截图
    height: 1400,
    prepare: [
      `__shot.focus(".rich-composer-content")`,
      { type: "@" },
      `__shot.find(".mention-menu, [role=listbox]")`,
    ],
    clip: `__shot.union([".composer", ".mention-menu, [role=listbox]"], { x: 12, y: 12 })`,
  },
  {
    name: "running",
    room: "shop-web",
    clip: `__shot.rect("article.thinking-card", { x: 12, y: 12 }, true)`,
  },
  {
    name: "ask",
    room: "shop-web",
    clip: `__shot.rect("article.message.question", { x: 12, y: 12 }, true)`,
  },
  {
    name: "decide",
    room: "ops",
    clip: `__shot.rect("article.message:has(.invocation-chip.failed)", { x: 12, y: 12 }, true)`,
  },
  {
    name: "progress",
    room: "shop-web",
    prepare: [`__shot.click("#side-tab-whiteboard")`],
    clip: `__shot.until(".members-panel", ".progress-board", 12)`,
  },
  {
    name: "worktrees",
    room: "shop-web",
    prepare: [
      `__shot.click('.room-item-manage[aria-label$=" shop-web"]')`,
      `__shot.find(".worktree-panel .worktree-entry")`,
      `__shot.scrollIntoView(".worktree-panel")`,
    ],
    clip: `__shot.from(".worktree-panel", "[role=dialog]", 18)`,
  },
  {
    name: "onboard",
    room: "shop-web",
    prepare: [`__shot.click(".sidebar-agent-entry")`, `__shot.find("[role=dialog]")`],
    clip: `__shot.rect("[role=dialog]")`,
  },
  {
    name: "clis",
    room: "shop-web",
    prepare: [
      `__shot.click(".sidebar-user-chip")`,
      `__shot.click('[role="menuitem"]', (el) => /^(设置|Settings)$/.test(el.textContent.trim()))`,
      `__shot.click('[aria-controls="settings-panel-runtimes"]')`,
      `__shot.find("#settings-panel-runtimes .agent-cli-path")`,
      // 滚到「已安装的 Agent CLI」，一屏能看到全部 CLI
      `__shot.find("#settings-panel-runtimes .agent-cli").then((el) => el.closest(".settings-group").scrollIntoView({ block: "start" }))`,
    ],
    clip: `__shot.rect("[role=dialog]")`,
  },
];

/** 截图页面里的辅助函数：在 shadow DOM 里也能找；量位置前先滚到可见 */
const SHOT_HELPERS = `${HELPERS}
Object.assign(window.__shot, {
  deep(selector, match) {
    const roots = [document, ...[...document.querySelectorAll("*")].filter((el) => el.shadowRoot).map((el) => el.shadowRoot)];
    for (const root of roots) {
      const found = [...root.querySelectorAll(selector)].filter((el) => !match || match(el));
      if (found.length) return found[found.length - 1];
    }
  },
  async find(selector, match) {
    const deadline = Date.now() + 15000;
    for (;;) {
      const found = this.deep(selector, match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("没找到元素：" + selector);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  },
  async focus(selector) {
    (await this.find(selector)).focus();
  },
  async scrollIntoView(selector) {
    (await this.find(selector)).scrollIntoView({ block: "start" });
  },
  async rect(selector, pad = { x: 0, y: 0 }, scroll = false) {
    const el = await this.find(selector);
    if (scroll) el.scrollIntoView({ block: "center" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const r = el.getBoundingClientRect();
    return { x: r.left - pad.x, y: r.top - pad.y, width: r.width + pad.x * 2, height: r.height + pad.y * 2 };
  },
  async union(selectors, pad = { x: 0, y: 0 }) {
    const rects = await Promise.all(selectors.map(async (selector) => (await this.find(selector)).getBoundingClientRect()));
    const left = Math.min(...rects.map((r) => r.left)) - pad.x;
    const top = Math.min(...rects.map((r) => r.top)) - pad.y;
    const right = Math.max(...rects.map((r) => r.right)) + pad.x;
    const bottom = Math.max(...rects.map((r) => r.bottom)) + pad.y;
    return { x: left, y: top, width: right - left, height: bottom - top };
  },
  /** 把页面（含 shadow DOM）文字里的演示 HOME 换成 ~；之后新渲染的也换 */
  tildeHome(home) {
    const fix = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (node.nodeValue.includes(home)) node.nodeValue = node.nodeValue.replaceAll(home, "~");
    };
    const all = () => {
      fix(document.body);
      for (const el of document.querySelectorAll("*")) if (el.shadowRoot) fix(el.shadowRoot);
    };
    all();
    if (!this.homeObserver) {
      this.homeObserver = new MutationObserver(all);
      this.homeObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
    }
  },
  /** 取 container 的左右和上沿，下沿截到 last 元素下方 pad 处（去掉底部空白） */
  async until(container, last, pad = 0) {
    const c = (await this.find(container)).getBoundingClientRect();
    const l = (await this.find(last)).getBoundingClientRect();
    return { x: c.left, y: c.top, width: c.width, height: Math.min(c.bottom, l.bottom + pad) - c.top };
  },
  /** 从 start 元素上方 gap 处截到 container 底部，宽度取 container */
  async from(start, container, gap = 0) {
    const s = (await this.find(start)).getBoundingClientRect();
    const c = (await this.find(container)).getBoundingClientRect();
    const top = Math.max(c.top, s.top - gap);
    return { x: c.left, y: top, width: c.width, height: c.bottom - top };
  },
});`;

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      only: { type: "string" },
      theme: { type: "string", default: "light,dark" },
      "no-build": { type: "boolean", default: false },
      out: { type: "string", default: OUT_DIR },
      keep: { type: "boolean", default: false },
      chrome: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const names = values.only?.split(",").map((name) => name.trim());
  for (const name of names ?? [])
    if (!SHOTS.some((shot) => shot.name === name)) throw new Error(`没有这张图：${name}`);
  const themes = values.theme.split(",").map((theme) => theme.trim());
  for (const theme of themes)
    if (!["light", "dark"].includes(theme))
      throw new Error(`--theme 只能是 light / dark：${theme}`);
  return {
    help: values.help,
    shots: names ? SHOTS.filter((shot) => names.includes(shot.name)) : SHOTS,
    themes,
    build: !values["no-build"],
    out: path.resolve(values.out),
    keep: values.keep,
    chrome: values.chrome,
  };
}

const HELP = `用法：pnpm --filter @superhive/docs screens [选项]

  --only <名字,...>   只截这几张（${SHOTS.map((shot) => shot.name).join("、")}）
  --theme <主题>      light、dark 或 light,dark（默认两套都截）
  --no-build          不重新构建 protocol 与网页，直接用现有的 apps/web/dist
  --out <目录>        输出目录（默认 public/media/screens）
  --keep              保留演示 Server 的临时目录（会打印路径）
  --chrome <路径>     Chrome 可执行文件（也可用环境变量 CHROME_PATH）`;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} 失败`)),
    );
  });
}

/** 起演示 Server：HOME 指向临时目录，等它打印 DEMO_READY */
async function startDemo(home) {
  const log = path.join(home, "demo-server.log");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(import.meta.dirname, "screens/demo-server.mjs")],
    {
      cwd: path.join(ROOT, "apps/server"),
      env: {
        // 只带运行要用的环境：不把本机的 HIVE_* 配置、令牌带进演示 Server
        PATH: process.env.PATH,
        HOME: home,
        HIVE_DEMO_ROOT: home,
        TZ: process.env.TZ ?? "Asia/Shanghai",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = fs.createWriteStream(log);
  child.stderr.pipe(output);
  // 失败时把日志末尾带进报错：临时目录随后会被删掉
  const tail = () => {
    output.end();
    const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    return text.trim().split("\n").slice(-15).join("\n");
  };
  const ready = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`演示 Server 启动超时：\n${tail()}`)), 90_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      output.write(chunk);
      const line = buffer.split("\n").find((item) => item.startsWith("DEMO_READY "));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line.slice("DEMO_READY ".length)));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      // 等日志写完再读
      setTimeout(() => reject(new Error(`演示 Server 退出（退出码 ${code}）：\n${tail()}`)), 200);
    });
  });
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      child.kill("SIGTERM");
    });
  return { ...ready, stop };
}

/** returnValue=false 时丢掉结果：按值回传 DOM 元素会报「Object reference chain is too long」 */
async function evaluate(cdp, script, label, returnValue = false) {
  try {
    return await cdp.evaluate(
      returnValue ? `(async () => await (${script}))()` : `(async () => { await (${script}); })()`,
    );
  } catch (error) {
    throw new Error(`${label}：${error.message}`);
  }
}

async function captureShot(cdp, demo, shot, theme, file) {
  const width = shot.width ?? 1440;
  const height = shot.height ?? 900;
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  const url = new URL(demo.url);
  url.hash = shot.room;
  const storage = initialStorage({ user: demo.owner, theme, room: shot.room });
  const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `${SHOT_HELPERS}
      if (location.origin === ${JSON.stringify(url.origin)}) {
        // 输入框草稿按房间存在 localStorage：上一张图（如浅色版）敲的「@」会留到下一张，再敲就成了「@@」
        for (const key of Object.keys(localStorage)) if (key.startsWith("superhive.draft.")) localStorage.removeItem(key);
        for (const [key, value] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(key, value);
      }`,
  });
  try {
    await cdp.send("Page.navigate", { url: "about:blank" });
    await cdp.send("Page.navigate", { url: url.href });
    await evaluate(
      cdp,
      `(async () => {
        await __shot.find(".app-shell");
        await __shot.find(".message-list");
        await document.fonts.ready;
      })()`,
      `${shot.name} 页面没加载出来`,
    );
    await sleep(1500);
    // 演示目录显示成 ~（和平时在自己电脑上看到的一样），不露出临时目录
    await evaluate(cdp, `__shot.tildeHome(${JSON.stringify(demo.home)})`, "替换演示目录");
    for (const [index, step] of (shot.prepare ?? []).entries()) {
      if (typeof step === "string") await evaluate(cdp, step, `${shot.name} 第 ${index + 1} 步`);
      else await cdp.send("Input.insertText", { text: step.type });
      await sleep(500);
    }
    const clip = shot.clip
      ? await evaluate(cdp, shot.clip, `${shot.name} 量截图范围`, true)
      : { x: 0, y: 0, width, height };
    await evaluate(cdp, `__shot.tildeHome(${JSON.stringify(demo.home)})`, "替换演示目录");
    // 截到整像素，避免 2 倍图边缘出现半像素的模糊
    const rounded = {
      x: Math.max(0, Math.round(clip.x)),
      y: Math.max(0, Math.round(clip.y)),
      width: Math.round(clip.width),
      height: Math.round(clip.height),
      scale: 1,
    };
    const shotData = await cdp.send("Page.captureScreenshot", { format: "png", clip: rounded });
    await sharp(Buffer.from(shotData.data, "base64"))
      .png({ palette: true, colors: 256, effort: 10, compressionLevel: 9 })
      .toFile(file);
    console.log(
      `${path.relative(process.cwd(), file)}  ${rounded.width * SCALE}×${rounded.height * SCALE}`,
    );
  } finally {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`[screens] ${error.message}\n\n${HELP}`);
    process.exit(1);
  }
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.build) {
    for (const pkg of ["@superhive/protocol", "@superhive/web"])
      await run("pnpm", ["--filter", pkg, "build"]);
  }
  if (!fs.existsSync(path.join(ROOT, "apps/web/dist/index.html")))
    throw new Error("没有网页构建产物（apps/web/dist），去掉 --no-build 重新构建");

  // realpath：macOS 的临时目录经 /var → /private/var 软链，HOME 要和真实路径一致，界面上才显示成 ~
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-docs-screens-")));
  let demo;
  let chrome;
  try {
    demo = await startDemo(home);
    chrome = await launchChrome(findChrome(options.chrome));
    const { cdp } = chrome;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    fs.mkdirSync(options.out, { recursive: true });
    for (const shot of options.shots)
      for (const theme of options.themes)
        await captureShot(
          cdp,
          demo,
          shot,
          theme,
          path.join(options.out, `${shot.name}.${theme}.png`),
        );
    cdp.close();
  } finally {
    await chrome?.close();
    await demo?.stop();
    if (options.keep) console.log(`[screens] 保留临时目录：${home}`);
    else fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    await main();
  } catch (error) {
    console.error(`[screens] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
