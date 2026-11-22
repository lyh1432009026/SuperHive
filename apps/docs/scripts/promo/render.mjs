// 合成：把录好的帧（clips/<镜头>/frames.json）按分镜剪成片段，叠字幕卡，用转场连起来，导出 mp4。
//
// 字幕卡用 Chrome 把 HTML 渲染成透明 PNG（中文字体和排版都和网页一致），再由 ffmpeg 叠上去、淡入淡出。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const FPS = 60;

function ffmpeg(args, label) {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      stdio: ["ignore", "inherit", "inherit"],
      maxBuffer: 1 << 26,
    });
  } catch {
    throw new Error(`ffmpeg 失败：${label}`);
  }
}

export function probeDuration(file) {
  return Number(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      file,
    ])
      .toString()
      .trim(),
  );
}

/**
 * 一段录屏 → 恒定帧率的无损中间片段。
 * from / to 是录屏里的秒数；speed > 1 加速。录屏只在画面变化时出帧，按时间戳补成恒定帧率。
 */
export function encodeClip(clipDir, out, { from = 0, to, speed = 1, size = [1920, 1080] } = {}) {
  const meta = JSON.parse(fs.readFileSync(path.join(clipDir, "frames.json"), "utf8"));
  const end = Math.min(to ?? meta.duration, meta.duration);
  const frames = meta.frames;
  // 找 from 时刻正在显示的那一帧
  let start = 0;
  for (let i = 0; i < frames.length; i++) if (frames[i].t <= from) start = i;
  const lines = [];
  for (let i = start; i < frames.length && frames[i].t < end; i++) {
    const t0 = Math.max(frames[i].t, from);
    const t1 = Math.min(frames[i + 1]?.t ?? end, end);
    if (t1 <= t0) continue;
    lines.push(`file '${path.join(clipDir, frames[i].file)}'`, `duration ${(t1 - t0).toFixed(5)}`);
  }
  // concat 的最后一项要重复一次，否则它的时长会被忽略
  lines.push(lines.at(-2));
  const list = `${out}.txt`;
  fs.writeFileSync(list, lines.join("\n") + "\n");
  const [w, h] = size;
  ffmpeg(
    [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-vf",
      `setpts=PTS/${speed},fps=${FPS},scale=${w}:${h}:flags=lanczos,format=yuv420p`,
      "-t",
      ((end - from) / speed).toFixed(3),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "10",
      "-an",
      out,
    ],
    `编码片段 ${path.basename(clipDir)}`,
  );
  fs.rmSync(list);
  return (end - from) / speed;
}

/** 静态图片（如字幕之外的卡片）做成一段 */
export function stillClip(image, out, seconds) {
  ffmpeg(
    [
      "-loop",
      "1",
      "-i",
      image,
      "-t",
      String(seconds),
      "-vf",
      `fps=${FPS},format=yuv420p`,
      "-c:v",
      "libx264",
      "-crf",
      "10",
      out,
    ],
    `静态片段 ${path.basename(image)}`,
  );
}

/**
 * 给一段叠字幕卡：captions = [{ image, from, to }]（秒，相对这一段），淡入淡出 0.3 秒。
 */
export function overlayCaptions(input, out, captions) {
  if (!captions.length) {
    fs.copyFileSync(input, out);
    return;
  }
  const args = ["-i", input];
  for (const caption of captions) args.push("-loop", "1", "-i", caption.image);
  const filters = [];
  let last = "[0:v]";
  captions.forEach((caption, index) => {
    const fade = 0.3;
    const length = caption.to - caption.from;
    filters.push(
      `[${index + 1}:v]format=rgba,trim=duration=${length.toFixed(3)},` +
        `fade=t=in:st=0:d=${fade}:alpha=1,fade=t=out:st=${(length - fade).toFixed(3)}:d=${fade}:alpha=1,` +
        `setpts=PTS-STARTPTS+${caption.from.toFixed(3)}/TB[c${index}]`,
      `${last}[c${index}]overlay=0:0:eof_action=pass:format=auto[v${index}]`,
    );
    last = `[v${index}]`;
  });
  ffmpeg(
    [
      ...args,
      "-filter_complex",
      filters.join(";"),
      "-map",
      last,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "10",
      "-pix_fmt",
      "yuv420p",
      "-an",
      out,
    ],
    `叠字幕 ${path.basename(input)}`,
  );
}

/**
 * 片段用转场连起来：segments = [{ file, duration, transition? }]，transition 是 xfade 的效果名，
 * 默认 fade；时长 0.45 秒。最后导出成品（H.264 High、yuv420p、faststart），可选带静音音轨。
 */
export function joinSegments(
  segments,
  out,
  { transition = 0.45, silentAudio = false, crf = 16 } = {},
) {
  const args = [];
  for (const segment of segments) args.push("-i", segment.file);
  const filters = [];
  let last = "[0:v]";
  let offset = segments[0].duration;
  for (let i = 1; i < segments.length; i++) {
    const effect = segments[i].transition ?? "fade";
    const t = effect === "cut" ? 0.02 : transition;
    offset -= t;
    filters.push(
      `${last}[${i}:v]xfade=transition=${effect === "cut" ? "fade" : effect}:duration=${t}:offset=${offset.toFixed(3)}[x${i}]`,
    );
    last = `[x${i}]`;
    offset += segments[i].duration;
  }
  const audio = silentAudio
    ? [
        "-f",
        "lavfi",
        "-t",
        offset.toFixed(3),
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
      ]
    : [];
  ffmpeg(
    [
      ...args,
      ...audio,
      ...(filters.length ? ["-filter_complex", filters.join(";"), "-map", last] : ["-map", "0:v"]),
      ...(silentAudio
        ? ["-map", `${segments.length}:a`, "-c:a", "aac", "-b:a", "128k", "-shortest"]
        : ["-an"]),
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-profile:v",
      "high",
      "-crf",
      String(crf),
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(FPS),
      "-movflags",
      "+faststart",
      out,
    ],
    `合成 ${path.basename(out)}`,
  );
  return offset;
}

/**
 * 横版成片改成 9:16 竖版：上下用同一画面的模糊放大铺底；中间放原画面裁掉左右两边（留中间 1500 像素，
 * 对话区和字幕都在里面）再放大到铺满宽度，手机上字更大；顶部、底部叠标题图。
 */
export function toVertical(input, out, header) {
  ffmpeg(
    [
      "-i",
      input,
      "-loop",
      "1",
      "-i",
      header,
      "-filter_complex",
      [
        "[0:v]split=2[a][b]",
        "[a]scale=-2:1920,crop=1080:1920,boxblur=28:2,eq=brightness=-0.18[bg]",
        "[b]crop=1500:1080:(iw-1500)/2:0,scale=1080:-2:flags=lanczos[fg]",
        "[bg][fg]overlay=0:(H-h)/2[base]",
        "[1:v]format=rgba[h]",
        "[base][h]overlay=0:0:shortest=1,format=yuv420p[v]",
      ].join(";"),
      "-map",
      "[v]",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "17",
      "-c:a",
      "copy",
      "-r",
      String(FPS),
      "-movflags",
      "+faststart",
      out,
    ],
    `竖版 ${path.basename(out)}`,
  );
}

/** 从成片里抽关键帧 */
export function extractFrame(input, seconds, out) {
  ffmpeg(["-ss", seconds.toFixed(2), "-i", input, "-frames:v", "1", out], `抽帧 ${seconds}`);
}
