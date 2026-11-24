// 首页实景窗口用的截图：从 public/media/screens/ 的演示环境截图（studio 的中英、明暗四份）
// 缩成 960、1600、2400 宽的 WebP，放到 public/media/home/。重截 docs:screens 后跑一次 pnpm home:media。
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const screens = new URL("../public/media/screens/", import.meta.url);
const output = new URL("../public/media/home/", import.meta.url);
mkdirSync(output, { recursive: true });

for (const name of ["studio"]) {
  for (const lang of ["", "en."]) {
    for (const theme of ["dark", "light"]) {
      for (const width of [960, 1600, 2400]) {
        const source = new URL(`${name}.${lang}${theme}.png`, screens);
        const target = new URL(`${name}.${lang}${theme}.${width}.webp`, output);
        await sharp(source.pathname)
          .resize({ width })
          .webp({ quality: width > 1600 ? 72 : 78, effort: 6 })
          .toFile(target.pathname);
      }
    }
  }
}
console.log("home media written to public/media/home/");
