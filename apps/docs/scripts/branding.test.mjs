import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "cheerio";

const mark = readFileSync(new URL("../src/assets/hive-mark.svg", import.meta.url), "utf8");

test("documentation mark retains the main application's HiveLogo geometry and treatment", () => {
  const app = readFileSync(new URL("../../web/src/app-icons.tsx", import.meta.url), "utf8");
  const logo = app.match(/function HiveLogo\([\s\S]*?\n}\n/)?.[0];
  assert.ok(logo, "main application HiveLogo exists");
  const paths = [...logo.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
  const svg = load(mark, { xmlMode: true });
  assert.deepEqual(
    svg("path")
      .toArray()
      .map((path) => svg(path).attr("d")),
    paths,
  );
  assert.equal(svg("svg").attr("viewBox"), "0 0 48 48");
  assert.equal(svg("g").attr("stroke"), "currentColor");
  assert.equal(svg("g").attr("stroke-width"), "2.4");
  assert.equal(svg("path").eq(1).attr("opacity"), "0.45");
  assert.equal(svg("circle").attr("r"), logo.match(/<circle[^>]+r="([^"]+)"/)?.[1]);
  assert.equal(svg("circle").attr("fill"), "currentColor");
  assert.equal(svg("rect").length, 0, "no separate rounded-square brand container");
});

test("header uses the shared mark and inherits the current document theme", () => {
  const title = readFileSync(new URL("../src/components/SiteTitle.astro", import.meta.url), "utf8");
  assert.ok(title.includes('import HiveMark from "../assets/hive-mark.svg"'));
  assert.ok(title.includes('<HiveMark width={32} height={32} aria-hidden="true"'));
  assert.doesNotMatch(mark, /#[0-9a-f]{3,8}/i);
});

test("documentation favicon is byte-identical to the main project's favicon", () => {
  assert.deepEqual(
    readFileSync(new URL("../public/favicon.svg", import.meta.url)),
    readFileSync(new URL("../../web/public/favicon.svg", import.meta.url)),
  );
});

test("social card reuses the header asset rather than drawing a separate logo", () => {
  const card = readFileSync(new URL("../src/assets/social-card.svg", import.meta.url), "utf8");
  const svg = load(card, { xmlMode: true });
  assert.equal(svg('image[href="hive-mark.svg"]').length, 1);
  assert.doesNotMatch(card, /m100 83 17 10/);
  const script = readFileSync(new URL("./social-image.mjs", import.meta.url), "utf8");
  assert.ok(script.includes('new URL("../src/assets/hive-mark.svg", import.meta.url)'));
  assert.ok(script.includes("data:image/svg+xml;base64,"));
  const png = readFileSync(new URL("../public/social-card.png", import.meta.url));
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});
