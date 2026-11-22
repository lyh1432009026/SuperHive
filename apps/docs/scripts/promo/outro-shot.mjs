// 结尾卡：npm 安装命令、GitHub 和文档站地址，带出场动画，录 5 秒多。
import { outroHtml } from "./cards.mjs";
import { DOCS_VIEWPORT } from "./docs-shots.mjs";

export const LINKS = {
  github: "github.com/wangrongding/SuperHive",
  docs: "wangrongding.github.io/SuperHive",
};

export async function outroShot(d, docs) {
  await d.setup({ ...DOCS_VIEWPORT });
  await d.place(-50, -50);
  const html = outroHtml(LINKS);
  const rec = await d.record(docs.clipDir("outro"));
  await d.goto(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await d.wait(6000);
  return rec.stop();
}
