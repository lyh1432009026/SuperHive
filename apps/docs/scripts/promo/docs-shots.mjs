// 文档站部分的镜头：首页出场、两张协作流转图。
// 轮播用页面自己的节奏（每步 2 秒、连续接力），不再改计时。

export const DOCS_VIEWPORT = { width: 1600, height: 900, scale: 1.2 };

/** 首页出场：标题依次浮出、协作图外框展开、卡片和连线出场 */
export async function heroShot(d, docs) {
  await d.setup({ ...DOCS_VIEWPORT, origin: docs.url, storage: { "starlight-theme": "dark" } });
  await d.place(1500, 1100);
  const rec = await d.record(docs.clipDir("hero"));
  await d.goto(docs.url + "/");
  await d.wait(5200);
  await d.move(820, 470, 1200);
  await d.wait(900);
  return rec.stop();
}

/** 某张协作图：滚到它、等出场、看轮播 */
async function diagramShot(d, docs, { name, index, seconds }) {
  await d.setup({ ...DOCS_VIEWPORT, origin: docs.url, storage: { "starlight-theme": "dark" } });
  // 加载时就把这张图滚到视口正中：出场动画由「进入视口」触发，录下来的就是从头开始的出场
  const { identifier } = await d.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `      document.addEventListener("DOMContentLoaded", () => {
        const figure = document.querySelectorAll(".cm")[${index}];
        const r = figure.getBoundingClientRect();
        scrollTo({ top: scrollY + r.top - Math.max(0, (innerHeight - r.height) / 2), behavior: "instant" });
      });`,
  });
  try {
    await d.place(1500, 1100);
    const rec = await d.record(docs.clipDir(name));
    await d.goto(docs.url + "/");
    await d.wait(seconds * 1000);
    return rec.stop();
  } finally {
    await d.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}

export const soloShot = (d, docs) => diagramShot(d, docs, { name: "solo", index: 0, seconds: 17 });

export const teamShot = (d, docs) => diagramShot(d, docs, { name: "team", index: 1, seconds: 16 });
