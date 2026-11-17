import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const card = await readFile(new URL("../src/assets/social-card.svg", import.meta.url), "utf8");
const mark = await readFile(new URL("../src/assets/hive-mark.svg", import.meta.url), "utf8");
const embeddedMark = Buffer.from(
  mark.replace('<g stroke="currentColor"', '<g color="#0d0d0d" stroke="currentColor"'),
).toString("base64");
const image = card.replace(
  'href="hive-mark.svg"',
  `href="data:image/svg+xml;base64,${embeddedMark}"`,
);

await sharp(Buffer.from(image))
  .png()
  .toFile(fileURLToPath(new URL("../public/social-card.png", import.meta.url)));
console.log("Generated public/social-card.png (1200 × 630)");
