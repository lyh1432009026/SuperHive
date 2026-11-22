// 录屏用的浏览器：独立的无头 Chrome + 带事件的最小 CDP 客户端，外加页面里的「导演」工具：
// 可见的鼠标指针、平滑移动和点击、逐字输入、镜头推近（缩放 body）、高亮框。
//
// 录屏走 Page.startScreencast：Chrome 每画一帧就推一张 JPEG 和时间戳，存到 frames/ 下，
// 合成时按时间戳换成恒定帧率（见 render.mjs 的 encodeClip）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { findChrome } from "../../../../scripts/screenshot.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 画面上不该出现的：本机路径、临时目录、本机用户名 */
const LEAK_PATTERN = ["/Users/", "/private/", "/var/folders", "hive-promo-", os.userInfo().username]
  .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

/** 带事件订阅的 CDP 客户端 */
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("连不上 Chrome DevTools")), {
      once: true,
    });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) ?? []) listener(message.params);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const next = ++id;
      pending.set(next, { resolve, reject, method });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  const on = (method, listener) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(listener);
    return () => listeners.get(method).delete(listener);
  };
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      // DOM 元素不能按值回传（会报 Object reference chain is too long），换成 true
      expression: `(async () => { const value = await (${expression}); return value instanceof Node ? true : value; })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    return result.result?.value;
  };
  return { send, on, evaluate, close: () => socket.close() };
}

/**
 * scale 要在启动参数里也给：录屏（screencast）按窗口的像素比出图，只在 Emulation 里设的话出来还是 CSS 像素大小。
 */
export async function launchBrowser({
  executable = findChrome(),
  width = 1280,
  height = 720,
  scale = 1.5,
} = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hive-promo-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--hide-scrollbars",
      "--mute-audio",
      "--force-color-profile=srgb",
      // 不碰系统钥匙串：临时 profile 第一次启动时 macOS 会弹「找不到用于储存 Chrome 的钥匙串」
      "--use-mock-keychain",
      "--password-store=basic",
      "--font-render-hinting=none",
      `--force-device-scale-factor=${scale}`,
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const close = async () => {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("exit", () => {
          clearTimeout(force);
          resolve();
        });
        child.kill();
      });
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, "utf8").includes("\n")) {
      if (child.exitCode !== null) throw new Error(`Chrome 启动失败（退出码 ${child.exitCode}）`);
      if (Date.now() > deadline) throw new Error("Chrome 启动超时");
      await sleep(100);
    }
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chrome 没有可用的页面");
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // 「生成并复制链接」要写剪贴板：无头模式下不授权会一直等
    await cdp
      .send("Browser.grantPermissions", {
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      })
      .catch(() => undefined);
    // 页面弹出 alert / confirm / prompt 时会卡住所有 Runtime.evaluate：记下来、直接关掉
    cdp.on("Page.javascriptDialogOpening", ({ type, message }) => {
      console.warn(`[promo] 页面弹出 ${type}：${message}`);
      cdp.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
    });
    return { cdp, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * 注入每个页面的导演工具（window.__promo）。
 * 指针挂在 <html> 下、不在 body 里：镜头推近时缩放的是 body，指针保持原大小、跟着真实鼠标坐标走。
 */
export const DIRECTOR = String.raw`
(() => {
  if (window.__promo) return;
  const roots = () => [document, ...[...document.querySelectorAll("*")].filter((el) => el.shadowRoot).map((el) => el.shadowRoot)];
  const STYLE = ${"`"}
    #promo-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647;
      pointer-events: none; transform: translate(-100px, -100px); will-change: transform; }
    #promo-cursor svg { width: 26px; height: 26px; filter: drop-shadow(0 2px 4px rgba(0,0,0,.45)); transition: transform .12s ease; transform-origin: 3px 2px; }
    #promo-cursor.down svg { transform: scale(.86); }
    .promo-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 44px; height: 44px;
      margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid rgba(255, 196, 64, .95);
      animation: promo-ripple .55s ease-out forwards; }
    @keyframes promo-ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
    .promo-hl { position: fixed; z-index: 2147483640; pointer-events: none; border-radius: 12px;
      border: 3px solid #ffc440; box-shadow: 0 0 0 4px rgba(255,196,64,.22), 0 0 32px rgba(255,196,64,.45);
      opacity: 0; transition: opacity .35s ease; }
    .promo-hl.on { opacity: 1; }
    .promo-hl-label { position: absolute; left: -3px; top: -38px; white-space: nowrap; padding: 4px 12px; border-radius: 8px;
      background: #ffc440; color: #1a1406; font: 600 15px/1.5 "PingFang SC", system-ui, sans-serif; }
    .promo-hl-label.below { top: auto; bottom: -38px; }
    .promo-hl-label.inside { top: 8px; left: 8px; }
    body.promo-camera { transition: transform var(--promo-ms, 900ms) cubic-bezier(.65,0,.35,1); transform-origin: 0 0; }
    body.promo-camera-instant { transition: none !important; }
  ${"`"};
  const install = () => {
    if (document.getElementById("promo-cursor")) return;
    const style = document.createElement("style");
    style.id = "promo-style";
    style.textContent = STYLE;
    document.documentElement.append(style);
    const cursor = document.createElement("div");
    cursor.id = "promo-cursor";
    cursor.innerHTML = '<svg viewBox="0 0 26 26"><path d="M3 2 L3 21 L8 16.5 L11.5 24 L15 22.5 L11.6 15.2 L18 15 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.append(cursor);
    const pos = window.__promoPos || { x: -100, y: -100 };
    cursor.style.transform = "translate(" + pos.x + "px," + pos.y + "px)";
    window.addEventListener("mousemove", (event) => {
      window.__promoPos = { x: event.clientX, y: event.clientY };
      cursor.style.transform = "translate(" + event.clientX + "px," + event.clientY + "px)";
    }, true);
    window.addEventListener("mousedown", (event) => {
      cursor.classList.add("down");
      const ripple = document.createElement("div");
      ripple.className = "promo-ripple";
      ripple.style.left = event.clientX + "px";
      ripple.style.top = event.clientY + "px";
      document.documentElement.append(ripple);
      setTimeout(() => ripple.remove(), 700);
    }, true);
    window.addEventListener("mouseup", () => cursor.classList.remove("down"), true);
  };
  // 不碰系统剪贴板：「复制链接」「复制命令」在无头 Chrome 里会卡住页面，也不该改掉你剪贴板里的内容
  try {
    const fake = { writeText: async () => undefined, write: async () => undefined, readText: async () => "", read: async () => [] };
    Object.defineProperty(navigator, "clipboard", { value: fake, configurable: true });
    const exec = document.execCommand.bind(document);
    document.execCommand = (command, ...rest) => (command === "copy" ? true : exec(command, ...rest));
  } catch {}
  // 泄露检查：页面上（含 shadow DOM 和输入框）出现本机路径、本机用户名就记下来，录完由 record.mjs 报错
  const LEAK = new RegExp(${JSON.stringify(LEAK_PATTERN)});
  window.__promoLeaks = [];
  setInterval(() => {
    if (!document.body) return;
    const texts = [document.body.innerText];
    for (const el of document.querySelectorAll("*")) if (el.shadowRoot) texts.push(el.shadowRoot.textContent);
    for (const el of document.querySelectorAll("input, textarea")) texts.push(el.value);
    for (const text of texts) {
      const hit = LEAK.exec(text ?? "");
      if (hit && window.__promoLeaks.length < 5) window.__promoLeaks.push(text.slice(Math.max(0, hit.index - 40), hit.index + 80));
    }
  }, 400);
  if (document.documentElement) install();
  document.addEventListener("DOMContentLoaded", install);

  window.__promo = {
    deep(selector, match) {
      for (const root of roots()) {
        const found = [...root.querySelectorAll(selector)].filter((el) => {
          if (match && !match(el)) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (found.length) return found[found.length - 1];
      }
    },
    async find(selector, match, timeout = 15000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = this.deep(selector, match);
        if (found) return found;
        if (Date.now() > deadline) throw new Error("没找到元素：" + selector);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    },
    async rect(selector, match, { scroll = true } = {}) {
      const el = await this.find(selector, match);
      if (scroll) {
        const r = el.getBoundingClientRect();
        if (r.top < 0 || r.bottom > innerHeight) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      }
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
    /** 镜头推近：把视口里的 rect 放大到铺满（留边），null 复位 */
    camera(rect, ms = 900, pad = 40) {
      const body = document.body;
      body.style.setProperty("--promo-ms", ms + "ms");
      body.classList.toggle("promo-camera-instant", ms === 0);
      body.classList.add("promo-camera");
      if (!rect) {
        body.style.transform = "";
        return;
      }
      // 先算出未缩放时的坐标：当前已缩放的话换算回去
      const current = new DOMMatrixReadOnly(getComputedStyle(body).transform === "none" ? undefined : getComputedStyle(body).transform);
      const inv = current.inverse();
      const p1 = inv.transformPoint(new DOMPoint(rect.x - pad, rect.y - pad));
      const p2 = inv.transformPoint(new DOMPoint(rect.x + rect.width + pad, rect.y + rect.height + pad));
      const w = p2.x - p1.x, h = p2.y - p1.y;
      const scale = Math.min(innerWidth / w, innerHeight / h);
      // 居中，且不露出页面外
      let tx = -p1.x * scale + (innerWidth - w * scale) / 2;
      let ty = -p1.y * scale + (innerHeight - h * scale) / 2;
      tx = Math.min(0, Math.max(innerWidth - innerWidth * scale, tx));
      ty = Math.min(0, Math.max(innerHeight - innerHeight * scale, ty));
      body.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
    },
    /** 高亮框：跟着元素走，返回 id，用 unhighlight(id) 收起 */
    highlight(selector, label, options = {}) {
      const { match, pad = 6 } = options;
      const box = document.createElement("div");
      box.className = "promo-hl";
      if (label) {
        const tag = document.createElement("div");
        tag.className = "promo-hl-label";
        tag.textContent = label;
        box.append(tag);
      }
      document.documentElement.append(box);
      const id = Math.random().toString(36).slice(2);
      let alive = true;
      const tick = () => {
        if (!alive) return;
        const el = this.deep(selector, match);
        if (el) {
          const r = el.getBoundingClientRect();
          // 框不出视口；顶上放不下标签就放到框下沿
          const left = Math.max(4, r.left - pad), top = Math.max(4, r.top - pad);
          const right = Math.min(innerWidth - 4, r.right + pad), bottom = Math.min(innerHeight - 4, r.bottom + pad);
          Object.assign(box.style, { left: left + "px", top: top + "px", width: right - left + "px", height: bottom - top + "px" });
          const tag = box.firstChild;
          if (tag) {
            const below = !!options.below || top < 44;
            tag.classList.toggle("below", below && bottom + 44 < innerHeight);
            tag.classList.toggle("inside", below && bottom + 44 >= innerHeight);
            tag.style.left = "";
            tag.style.right = "";
            if (left + tag.offsetWidth > innerWidth - 8) tag.style.right = "-3px", tag.style.left = "auto";
          }
          box.classList.add("on");
        }
        requestAnimationFrame(tick);
      };
      tick();
      (this.boxes ??= new Map()).set(id, () => {
        alive = false;
        box.classList.remove("on");
        setTimeout(() => box.remove(), 400);
      });
      return id;
    },
    ripple(x, y) {
      const ripple = document.createElement("div");
      ripple.className = "promo-ripple";
      ripple.style.left = x + "px";
      ripple.style.top = y + "px";
      document.documentElement.append(ripple);
      setTimeout(() => ripple.remove(), 700);
    },
    unhighlight(id) {
      if (id) { this.boxes?.get(id)?.(); this.boxes?.delete(id); return; }
      for (const off of this.boxes?.values() ?? []) off();
      this.boxes?.clear();
    },
  };
})();
`;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** 导演：在一页上平滑地动鼠标、点击、输入，并录屏 */
export class Director {
  constructor(cdp) {
    this.cdp = cdp;
    this.mouse = { x: 960, y: 1200 };
  }

  async setup({ width, height, scale, storage, origin, reduceMotion = false }) {
    await this.teardown();
    this.width = width;
    this.height = height;
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    await this.cdp.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-motion", value: reduceMotion ? "reduce" : "no-preference" },
        { name: "prefers-color-scheme", value: "dark" },
      ],
    });
    const { identifier } = await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `${DIRECTOR}
        if (${JSON.stringify(origin ?? "")} && location.origin === ${JSON.stringify(origin ?? "")}) {
          for (const [key, value] of Object.entries(${JSON.stringify(storage ?? {})})) localStorage.setItem(key, value);
        }`,
    });
    this.scriptId = identifier;
  }

  async teardown() {
    if (this.scriptId)
      await this.cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: this.scriptId,
      });
    this.scriptId = undefined;
  }

  async goto(url, ready) {
    await this.cdp.send("Page.navigate", { url: "about:blank" });
    await this.cdp.send("Page.navigate", { url });
    if (ready) await this.eval(ready);
  }

  eval(script) {
    return this.cdp.evaluate(script);
  }

  wait(ms) {
    return sleep(ms);
  }

  /** 平滑移动指针 */
  async move(x, y, ms = 650) {
    const from = { ...this.mouse };
    const steps = Math.max(2, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      const px = from.x + (x - from.x) * t;
      const py = from.y + (y - from.y) * t;
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
      await sleep(ms / steps);
    }
    this.mouse = { x, y };
  }

  /** 把指针放到某处（不动画，用在镜头开头） */
  async place(x, y) {
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    this.mouse = { x, y };
  }

  async rect(selector, match) {
    return this.eval(`__promo.rect(${JSON.stringify(selector)}${match ? `, ${match}` : ""})`);
  }

  /** 移到元素上（可指定元素内的相对位置 0～1） */
  async hover(selector, { match, ms = 700, at = [0.5, 0.5] } = {}) {
    if (process.env.PROMO_DEBUG) console.log(`[promo]   → ${selector}`);
    const r = await this.rect(selector, match);
    const x = r.x + r.width * at[0];
    const y = r.y + r.height * at[1];
    await this.move(x, y, ms);
    return r;
  }

  /**
   * js: true 时不发鼠标事件，直接在页面里 el.click()（画面上照样有点击波纹）：
   * 个别按钮（如邀请弹窗的「生成并复制链接」）被无头 Chrome 的鼠标事件点下去后，页面的输入会一直卡住。
   */
  async click(selector, options = {}) {
    await this.hover(selector, options);
    await sleep(options.pause ?? 220);
    if (options.js) {
      const { x, y } = this.mouse;
      await this.eval(`(() => {
        __promo.ripple(${x}, ${y});
        // 放到下一轮事件循环里点：同步点的话，点击引起的渲染会让这次 evaluate 一直不返回
        const el = __promo.deep(${JSON.stringify(selector)}${options.match ? `, ${options.match}` : ""});
        setTimeout(() => el.click(), 0);
      })()`);
    } else await this.press();
    await sleep(options.after ?? 450);
  }

  async press() {
    const { x, y } = this.mouse;
    // 点击偶尔会让 Input.dispatchMouseEvent 迟迟不返回（页面在处理同步弹窗等），最多等 3 秒
    const send = (type) => {
      let done = false;
      return Promise.race([
        this.cdp
          .send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 })
          .then(() => (done = true)),
        sleep(3000).then(() => done || console.warn(`[promo] ${type} 3 秒没返回`)),
      ]);
    };
    await send("mousePressed");
    await sleep(90);
    await send("mouseReleased");
  }

  /** 逐字输入，像人在打字 */
  async type(text, { delay = 55 } = {}) {
    for (const char of text) {
      await this.cdp.send("Input.insertText", { text: char });
      await sleep(delay + Math.random() * delay * 0.6);
    }
  }

  async key(key, code = key, keyCode) {
    if (process.env.PROMO_DEBUG) console.log(`[promo]   ⌨ ${key}`);
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...base,
      ...(key === "Enter" ? { text: "\r" } : {}),
    });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async scroll(selector, deltaY, ms = 800) {
    const r = await this.rect(selector);
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    await this.move(x, y, 400);
    const steps = Math.max(2, Math.round(ms / 16));
    for (let i = 0; i < steps; i++) {
      await this.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY: deltaY / steps,
      });
      await sleep(ms / steps);
    }
  }

  async camera(selectorOrRect, { ms = 900, pad = 40, match } = {}) {
    if (!selectorOrRect) {
      await this.eval(`__promo.camera(null, ${ms})`);
      return sleep(ms);
    }
    const rect =
      typeof selectorOrRect === "string"
        ? await this.eval(
            `__promo.rect(${JSON.stringify(selectorOrRect)}${match ? `, ${match}` : ", null"}, { scroll: false })`,
          )
        : selectorOrRect;
    await this.eval(`__promo.camera(${JSON.stringify(rect)}, ${ms}, ${pad})`);
    await sleep(ms);
  }

  highlight(selector, label, options = {}) {
    const { match, ...rest } = options;
    return this.eval(
      `__promo.highlight(${JSON.stringify(selector)}, ${JSON.stringify(label ?? "")}, { ...${JSON.stringify(rest)}${match ? `, match: ${match}` : ""} })`,
    );
  }

  unhighlight(id) {
    return this.eval(`__promo.unhighlight(${JSON.stringify(id ?? "")})`);
  }

  /** 开始录屏：帧写进 dir，stop() 返回 [{file, t}]（t 为秒） */
  async record(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const frames = [];
    const writes = [];
    let first;
    const off = this.cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      this.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
      const t = metadata.timestamp ?? Date.now() / 1000;
      first ??= t;
      const file = path.join(dir, `${String(frames.length).padStart(6, "0")}.jpg`);
      frames.push({ file, t: t - first });
      writes.push(fs.promises.writeFile(file, Buffer.from(data, "base64")));
    });
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 92,
      maxWidth: 3840,
      maxHeight: 2160,
      everyNthFrame: 1,
    });
    const started = Date.now();
    // 光标抖一下，保证开头就有一帧
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: this.mouse.x,
      y: this.mouse.y,
    });
    return {
      elapsed: () => (Date.now() - started) / 1000,
      stop: async () => {
        // 收尾也补一帧，让最后一张图停够时间
        await this.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: this.mouse.x + 0.5,
          y: this.mouse.y,
        });
        await sleep(120);
        await this.cdp.send("Page.stopScreencast");
        off();
        await Promise.all(writes);
        const duration = (Date.now() - started) / 1000;
        fs.writeFileSync(
          path.join(dir, "frames.json"),
          JSON.stringify({
            duration,
            frames: frames.map((f) => ({ file: path.basename(f.file), t: f.t })),
          }),
        );
        return { duration, frames };
      },
    };
  }
}
