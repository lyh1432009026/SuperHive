// 演示数据里 Agent 交付的附件：压测报告图、两版结算页设计稿、一份 Markdown 规范。
// 图片用 Chrome 现场把 HTML 渲染成 PNG，不放二进制文件进仓库。
const FONT = `"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", system-ui, sans-serif`;

export const PRICE_SPEC = `# 结算页金额显示规范

## 存储与计算

- 金额一律按**分**存成整数，计算过程中不出现小数。
- 只在显示时格式化，接口返回的也是分。

## 显示

| 场景 | 示例 | 写法 |
| --- | --- | --- |
| 普通金额 | ¥1,299.00 | \`formatPrice(129900)\` |
| 优惠、退款 | -¥20.00 | 负号放在货币符号前 |
| 免费 | ¥0.00 | 不写成「免费」，避免和活动文案混淆 |

- 千分位和货币符号统一用 \`Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" })\`。
- 移动端和 PC 端共用 \`src/checkout/price.ts\` 里的 \`formatPrice\`，不各自手拼。

## 舍入

- 优惠分摊到每件商品时按分四舍五入，差额记到最后一件，合计和订单服务一致。
`;

const page = (
  width,
  height,
  body,
  style = "",
) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width}px;height:${height}px;font-family:${FONT};}
${style}</style></head><body>${body}</body></html>`;

function loadtestHtml() {
  // 一条平稳的 P99 曲线
  const points = Array.from({ length: 40 }, (_, i) => {
    const y = 182 + Math.sin(i * 0.7) * 14 + Math.cos(i * 1.9) * 8 - (i < 4 ? (4 - i) * 12 : 0);
    return [40 + i * 18, 300 - y];
  });
  const line = points
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  return page(
    800,
    450,
    `<div class="card">
      <div class="head"><b>结算接口压测</b><span>500 并发 · 10 分钟</span></div>
      <div class="stats"><div><i>P99</i><b>182ms</b></div><div><i>P50</i><b>64ms</b></div><div><i>错误率</i><b>0%</b></div><div><i>QPS</i><b>2,340</b></div></div>
      <svg viewBox="0 0 780 300" width="760" height="250">
        <line x1="40" y1="100" x2="760" y2="100" class="grid"/><line x1="40" y1="160" x2="760" y2="160" class="grid"/><line x1="40" y1="220" x2="760" y2="220" class="grid"/>
        <line x1="40" y1="60" x2="760" y2="60" class="limit"/><text x="700" y="52" class="lt">SLO 240ms</text>
        <path d="${line} L742,300 L40,300 Z" class="area"/><path d="${line}" class="line"/>
      </svg>
    </div>`,
    `body{background:#f6f7f9}.card{margin:16px;padding:20px 22px;background:#fff;border-radius:14px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
    .head{display:flex;justify-content:space-between;align-items:baseline;color:#222}.head b{font-size:22px}.head span{color:#888;font-size:15px}
    .stats{display:flex;gap:36px;margin:14px 0 4px}.stats i{display:block;font-style:normal;color:#888;font-size:13px}.stats b{font-size:24px;color:#1b6ef3}
    .grid{stroke:#eceef2}.limit{stroke:#f08c2a;stroke-dasharray:6 6}.lt{fill:#f08c2a;font-size:13px}.area{fill:rgba(27,110,243,.12)}.line{fill:none;stroke:#1b6ef3;stroke-width:3}`,
  );
}

/** 手机结算页设计稿：expanded=明细展开、合计吸底 */
function designHtml(expanded) {
  const rows = [
    ["无线降噪耳机", "¥1,299.00"],
    ["耳机保护壳 ×2", "¥98.00"],
    ["运费", "¥0.00"],
  ];
  const off = [
    ["满 1000 减 100", "-¥100.00"],
    ["新人券", "-¥20.00"],
  ];
  return page(
    600,
    900,
    `<div class="phone"><div class="bar"><span>9:41</span><b>确认订单</b><span>•••</span></div>
      <div class="addr"><b>林夏 138****0000</b><span>上海市徐汇区演示路 88 号</span></div>
      <div class="block">${rows.map(([a, b]) => `<div class="row"><span>${a}</span><span>${b}</span></div>`).join("")}</div>
      ${
        expanded
          ? `<div class="block off"><div class="title">优惠明细</div>${off.map(([a, b]) => `<div class="row"><span>${a}</span><span class="neg">${b}</span></div>`).join("")}</div>
             <div class="sticky"><div><span class="small">已优惠 ¥120.00</span><b>¥1,277.00</b></div><button>提交订单</button></div>`
          : `<div class="block"><div class="row"><span>合计</span><b class="big">¥1,277.00</b></div><div class="fold">优惠明细（2 项，共 -¥120.00）▾</div></div>
             <button class="inline">提交订单</button>`
      }
      <div class="tag">${expanded ? "方案 B" : "方案 A"}</div>
    </div>`,
    `body{background:${expanded ? "#e9eefb" : "#f3ede6"};display:grid;place-items:center}
    .phone{position:relative;width:390px;height:820px;border-radius:44px;background:#f5f6f8;border:10px solid #16181d;overflow:hidden;color:#1d1f24}
    .bar{display:flex;justify-content:space-between;padding:16px 22px 10px;font-size:14px;background:#fff}.bar b{font-size:17px}
    .addr{margin:12px;padding:14px 16px;border-radius:14px;background:#fff;display:flex;flex-direction:column;gap:4px;font-size:14px}.addr span{color:#777;font-size:13px}
    .block{margin:12px;padding:6px 16px;border-radius:14px;background:#fff}.row{display:flex;justify-content:space-between;padding:10px 0;font-size:15px}
    .title{font-weight:700;padding:10px 0 2px}.neg{color:#e5484d}.big{font-size:22px;color:#e5484d}
    .fold{padding:6px 0 12px;color:#1b6ef3;font-size:14px}
    .sticky{position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:space-between;align-items:center;padding:16px 18px 30px;background:#fff;box-shadow:0 -4px 16px rgba(0,0,0,.06)}
    .sticky b{display:block;font-size:24px;color:#e5484d}.small{font-size:12px;color:#888}
    button{border:0;border-radius:999px;background:#e5484d;color:#fff;font:600 16px ${FONT};padding:13px 26px}
    button.inline{display:block;margin:20px auto;width:calc(100% - 24px)}
    .tag{position:absolute;top:70px;right:16px;padding:4px 12px;border-radius:999px;background:#16181d;color:#fff;font-size:13px;font-weight:700}`,
  );
}

/** 用录屏浏览器把 HTML 渲染成 PNG（2 倍像素） */
async function renderPng(cdp, html, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  const loaded = new Promise((resolve) => {
    const off = cdp.on("Page.loadEventFired", () => {
      off();
      resolve();
    });
  });
  await cdp.send("Page.navigate", {
    url: `data:text/html;base64,${Buffer.from(html).toString("base64")}`,
  });
  await loaded;
  await cdp.evaluate("document.fonts.ready.then(() => true)");
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  return Buffer.from(shot.data, "base64");
}

export async function renderAssets(cdp) {
  return {
    spec: PRICE_SPEC,
    loadtest: await renderPng(cdp, loadtestHtml(), 800, 450),
    designA: await renderPng(cdp, designHtml(false), 600, 900),
    designB: await renderPng(cdp, designHtml(true), 600, 900),
  };
}

/** 透明背景的 PNG（字幕卡、竖版标题） */
export async function renderTransparentPng(cdp, html, width, height) {
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const loaded = new Promise((resolve) => {
      const off = cdp.on("Page.loadEventFired", () => {
        off();
        resolve();
      });
    });
    await cdp.send("Page.navigate", {
      url: `data:text/html;base64,${Buffer.from(html).toString("base64")}`,
    });
    await loaded;
    await cdp.evaluate("document.fonts.ready.then(() => true)");
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    return Buffer.from(shot.data, "base64");
  } finally {
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", {});
  }
}
