// 字幕卡、结尾卡、竖版标题的 HTML：字幕和竖版标题渲染成透明 PNG，结尾卡带出场动画、直接录屏。
const FONT = `"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", system-ui, sans-serif`;
const MONO = `"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace`;

const escape = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );

/** HiveMark 同款六边形标志 */
const MARK = `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 4 41.3 14v20L24 44 6.7 34V14Z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M24 15.5 31.4 19.8v8.4L24 32.5l-7.4-4.3v-8.4Z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><circle cx="24" cy="24" r="2.6" fill="currentColor"/></svg>`;

/**
 * 底部字幕条（1920×1080 透明画布，CSS 像素 = 输出像素）：
 * chapter 是左侧的小标签（如「协作」），text 一句话说清这个镜头。
 */
export function captionHtml({
  chapter,
  text,
  width = 1920,
  height = 1080,
  bottom = 64,
  size = 34,
}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${width}px; height: ${height}px; background: transparent; }
  .bar { position: absolute; left: 50%; bottom: ${bottom}px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 18px; max-width: ${width - 160}px;
    padding: 16px 30px 16px 18px; border-radius: 18px;
    background: rgba(12, 14, 20, 0.84); border: 1px solid rgba(255,255,255,0.12);
    box-shadow: 0 18px 48px rgba(0,0,0,0.45); backdrop-filter: blur(8px); }
  .chapter { flex: none; padding: 6px 14px; border-radius: 10px; background: #ffc440; color: #1a1406;
    font: 700 ${Math.round(size * 0.66)}px/1.3 ${FONT}; letter-spacing: 0.04em; }
  .text { color: #f5f6f8; font: 600 ${size}px/1.4 ${FONT}; letter-spacing: 0.01em; white-space: nowrap; }
  .text b { color: #ffd56b; font-weight: 700; }
  </style></head><body><div class="bar">${chapter ? `<span class="chapter">${escape(chapter)}</span>` : ""}<span class="text">${text}</span></div></body></html>`;
}

/** 竖版顶部标题（1080×1920 透明画布） */
export function verticalHeaderHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1080px; height: 1920px; background: transparent; }
  .top { position: absolute; top: 150px; left: 0; right: 0; text-align: center; color: #f5f6f8; }
  .brand { display: inline-flex; align-items: center; gap: 18px; font: 800 76px/1.1 ${FONT}; letter-spacing: -0.01em; }
  .brand svg { width: 78px; height: 78px; color: #ffc440; }
  .line { margin-top: 26px; font: 600 44px/1.4 ${FONT}; color: #e8e9ee; }
  .bottom { position: absolute; bottom: 170px; left: 0; right: 0; text-align: center; }
  .cmd { display: inline-block; padding: 18px 34px; border-radius: 18px; background: rgba(12,14,20,.86);
    border: 1px solid rgba(255,255,255,.14); color: #ffd56b; font: 600 40px/1.3 ${MONO}; }
  .url { margin-top: 22px; color: #c9ccd6; font: 500 32px/1.4 ${FONT}; }
  </style></head><body>
  <div class="top"><div class="brand">${MARK}SuperHive</div><div class="line">把人和 Agent，带进同一间工作室</div></div>
  <div class="bottom"><div class="cmd">npm i -g superhive</div><div class="url">github.com/wangrongding/SuperHive</div></div>
  </body></html>`;
}

/** 结尾卡（录屏用，1280×720 CSS 像素，带出场动画） */
export function outroHtml({ docs, github }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
  body { background: radial-gradient(ellipse at 50% 38%, #1d2333 0%, #11131a 55%, #0b0c10 100%); color: #f5f6f8;
    display: grid; place-items: center; font-family: ${FONT}; }
  .wrap { text-align: center; }
  .brand { display: inline-flex; align-items: center; gap: 16px; font-weight: 800; font-size: 64px; letter-spacing: -0.01em; }
  .brand svg { width: 64px; height: 64px; color: #ffc440; }
  .tag { margin-top: 14px; font-size: 26px; font-weight: 600; color: #d6d8e0; }
  .cmd { margin: 42px auto 0; display: inline-flex; align-items: center; gap: 14px; padding: 16px 28px; border-radius: 16px;
    background: #0d0f14; border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 20px 50px rgba(0,0,0,.45);
    font: 600 30px/1.2 ${MONO}; color: #f5f6f8; }
  .cmd .p { color: #ffc440; }
  .links { margin-top: 34px; display: flex; gap: 40px; justify-content: center; font-size: 21px; color: #c9ccd6; }
  .links span { display: inline-flex; align-items: center; gap: 10px; }
  .links b { color: #8f95a8; font-weight: 600; font-size: 16px; letter-spacing: .08em; }
  .in { opacity: 0; transform: translateY(18px); animation: in .7s cubic-bezier(.2,.7,.2,1) forwards; }
  .d1 { animation-delay: .15s } .d2 { animation-delay: .45s } .d3 { animation-delay: .85s } .d4 { animation-delay: 1.2s }
  @keyframes in { to { opacity: 1; transform: none; } }
  .caret { display: inline-block; width: 14px; height: 30px; background: #ffc440; animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  </style></head><body><div class="wrap">
    <div class="brand in d1">${MARK}SuperHive</div>
    <div class="tag in d2">把人和 Agent，带进同一间工作室</div>
    <div class="cmd in d3"><span class="p">$</span>npm i -g superhive<span class="caret"></span></div>
    <div class="links in d4"><span><b>GITHUB</b>${escape(github)}</span><span><b>文档</b>${escape(docs)}</span></div>
  </div></body></html>`;
}
