#!/usr/bin/env node
// SuperHive 宣传片：一条命令录屏并合成。
//
//   pnpm --filter @superhive/docs promo                      # 构建、录屏、合成全部
//   pnpm --filter @superhive/docs promo --skip-record        # 只按分镜重新合成（改了字幕、剪辑点时用）
//   pnpm --filter @superhive/docs promo --only delegate,im   # 只重录这几个镜头，再合成
//
// 成品在仓库根的 output/promo/（已被 .gitignore 忽略）。详见同目录 README.md。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { launchBrowser } from "./browser.mjs";
import { captionHtml, verticalHeaderHtml } from "./cards.mjs";
import { renderTransparentPng } from "./assets.mjs";
import {
  encodeClip,
  extractFrame,
  joinSegments,
  overlayCaptions,
  probeDuration,
  toVertical,
} from "./render.mjs";
import { MAIN, SHORT } from "./storyboard.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../../..");

const { values } = parseArgs({
  options: {
    out: { type: "string", default: path.join(ROOT, "output/promo") },
    only: { type: "string" },
    "skip-record": { type: "boolean", default: false },
    "no-build": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (values.help) {
  console.log(fs.readFileSync(path.join(import.meta.dirname, "README.md"), "utf8"));
  process.exit(0);
}
const out = path.resolve(values.out);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} 失败`)),
    );
  });
}

/** 录屏在子进程里跑：要用 tsx 直接导入 Server 源码，HOME 指向临时目录，不带本机的 HIVE_* 配置和令牌 */
async function record() {
  if (!values["no-build"]) {
    for (const pkg of ["@superhive/protocol", "@superhive/web", "@superhive/docs"])
      await run("pnpm", ["--filter", pkg, "build"]);
  }
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-promo-")));
  try {
    await run(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(import.meta.dirname, "record.mjs"),
        "--out",
        out,
        ...(values.only ? ["--only", values.only] : []),
      ],
      {
        cwd: path.join(ROOT, "apps/server"),
        env: { PATH: process.env.PATH, HOME: home, HIVE_DEMO_ROOT: home, TZ: "Asia/Shanghai" },
      },
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** 按分镜出一条片子：每段剪好、叠字幕，再用转场连起来 */
async function cut(board, name, cdp) {
  const work = path.join(out, "work", name);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const segments = [];
  const storyboard = [];
  for (const [index, shot] of board.entries()) {
    const raw = path.join(work, `${index}-${shot.clip}-raw.mp4`);
    const duration = encodeClip(path.join(out, "clips", shot.clip), raw, shot);
    const captions = [];
    for (const [k, caption] of shot.captions.entries()) {
      const image = path.join(work, `${index}-caption-${k}.png`);
      fs.writeFileSync(image, await renderTransparentPng(cdp, captionHtml(caption), 1920, 1080));
      captions.push({
        image,
        from: caption.at ?? 0,
        to: Math.min(caption.to ?? duration - 0.2, duration),
      });
    }
    const file = path.join(work, `${index}-${shot.clip}.mp4`);
    overlayCaptions(raw, file, captions);
    segments.push({ file, duration: probeDuration(file) });
    storyboard.push({
      clip: shot.clip,
      duration,
      captions: shot.captions.map((c) => c.text.replace(/<\/?b>/g, "")),
    });
  }
  const file = path.join(out, `${name}.mp4`);
  const total = joinSegments(segments, file);
  // 分镜表：每个镜头在成片里的起止时间
  let t = 0;
  const rows = storyboard.map((row, i) => {
    const start = t;
    t += segments[i].duration - (i < segments.length - 1 ? 0.45 : 0);
    return { ...row, start: +start.toFixed(2), end: +t.toFixed(2) };
  });
  console.log(`[promo] ${path.relative(ROOT, file)}  ${total.toFixed(1)} 秒`);
  return { file, total, rows };
}

async function render() {
  const browser = await launchBrowser({ width: 1920, height: 1080, scale: 1 });
  try {
    const { cdp } = browser;
    const main = await cut(MAIN, "superhive-promo", cdp);
    const mainAudio = path.join(out, "superhive-promo-silent-audio.mp4");
    // 带静音音轨的一版：配乐时直接替换音轨
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      main.file,
      "-f",
      "lavfi",
      "-t",
      main.total.toFixed(3),
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      "-movflags",
      "+faststart",
      mainAudio,
    ]);
    const short = await cut(SHORT, "superhive-promo-30s", cdp);
    const header = path.join(out, "work", "vertical-header.png");
    fs.writeFileSync(header, await renderTransparentPng(cdp, verticalHeaderHtml(), 1080, 1920));
    const vertical = path.join(out, "superhive-promo-30s-vertical.mp4");
    toVertical(short.file, vertical, header);
    console.log(`[promo] ${path.relative(ROOT, vertical)}`);

    // 关键帧：每个镜头中间一张
    const frames = path.join(out, "frames");
    fs.rmSync(frames, { recursive: true, force: true });
    fs.mkdirSync(frames, { recursive: true });
    for (const [i, row] of main.rows.entries())
      extractFrame(
        main.file,
        (row.start + row.end) / 2,
        path.join(frames, `${String(i + 1).padStart(2, "0")}-${row.clip}.jpg`),
      );

    const table = [
      "| # | 时间 | 镜头 | 字幕 |",
      "| --- | --- | --- | --- |",
      ...main.rows.map(
        (row, i) =>
          `| ${i + 1} | ${row.start.toFixed(1)}–${row.end.toFixed(1)} 秒 | ${row.clip} | ${row.captions.join(" / ") || "（结尾卡）"} |`,
      ),
    ];
    fs.writeFileSync(
      path.join(out, "storyboard.md"),
      `# 分镜（主版 ${main.total.toFixed(1)} 秒）\n\n${table.join("\n")}\n`,
    );
    console.log(table.join("\n"));
  } finally {
    await browser.close();
  }
}

try {
  if (!values["skip-record"]) await record();
  await render();
} catch (error) {
  console.error(`[promo] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
