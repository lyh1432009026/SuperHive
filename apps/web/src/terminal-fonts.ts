/**
 * 内置终端的字体：英文用各平台自带的等宽字体，中文、日文假名、全角标点交给一个按比例放大的 CJK 字体。
 *
 * 为什么要放大：xterm 把 CJK 字符画成两个单元格宽。等宽英文字体的单元格一般是 0.55–0.6em，
 * 两格就是 1.1–1.2em，而中文字形只有 1em（墨迹还更窄），每个字后面会空出一截，中文看起来像被拉开了字距。
 * 这里用 CSS 的 size-adjust 只把 CJK 字形按「两格宽」放大一点，列宽不变（xterm 仍按单元格排版），
 * 所以 `ls`、表格的对齐不受影响。放大用的字体用 local() 指向系统自带字体，不下载任何东西。
 */

/** 放大后的 CJK 字体族名，排在英文等宽字体后面、普通中文字体前面 */
export const CJK_FONT_FAMILY = "SuperHive Terminal CJK";

/** 只覆盖东亚宽字符：CJK 标点、假名、注音、CJK 字母与月份、扩展 A、统一汉字、兼容汉字、竖排与全角形式、扩展 B 之后 */
export const CJK_UNICODE_RANGE = [
  "U+3000-30FF",
  "U+3100-312F",
  "U+31A0-31FF",
  "U+3200-33FF",
  "U+3400-4DBF",
  "U+4E00-9FFF",
  "U+F900-FAFF",
  "U+FE10-FE1F",
  "U+FE30-FE4F",
  "U+FF00-FF60",
  "U+FFE0-FFE6",
  "U+20000-3134F",
].join(", ");

type PlatformFonts = {
  /** 英文等宽字体，决定单元格宽度 */
  mono: string[];
  /** 中文字体（也是放大字体的来源），按优先级 */
  cjk: string[];
  /** local() 用的完整字体名或 PostScript 名：常规体、粗体 */
  cjkLocal: { regular: string[]; bold: string[] };
  emoji: string[];
};

const FONTS: Record<"darwin" | "win32" | "linux", PlatformFonts> = {
  darwin: {
    mono: ["ui-monospace", "SF Mono", "SFMono-Regular", "Menlo", "Monaco"],
    cjk: ["PingFang SC", "Hiragino Sans GB", "Heiti SC"],
    cjkLocal: {
      regular: ["PingFangSC-Regular", "PingFang SC Regular", "HiraginoSansGB-W3"],
      bold: ["PingFangSC-Semibold", "PingFang SC Semibold", "HiraginoSansGB-W6"],
    },
    emoji: ["Apple Color Emoji"],
  },
  win32: {
    mono: ["Cascadia Mono", "Cascadia Code", "Consolas", "Courier New"],
    cjk: ["Microsoft YaHei", "Microsoft YaHei UI", "SimHei"],
    cjkLocal: {
      regular: ["Microsoft YaHei", "MicrosoftYaHei", "SimHei"],
      bold: ["Microsoft YaHei Bold", "MicrosoftYaHei-Bold", "SimHei"],
    },
    emoji: ["Segoe UI Emoji", "Segoe UI Symbol"],
  },
  linux: {
    mono: ["DejaVu Sans Mono", "Noto Sans Mono", "Ubuntu Mono", "Liberation Mono"],
    cjk: [
      "Noto Sans Mono CJK SC",
      "Noto Sans CJK SC",
      "Source Han Sans SC",
      "WenQuanYi Zen Hei Mono",
      "WenQuanYi Micro Hei Mono",
    ],
    cjkLocal: {
      regular: [
        "Noto Sans Mono CJK SC Regular",
        "NotoSansMonoCJKsc-Regular",
        "Noto Sans CJK SC Regular",
        "NotoSansCJKsc-Regular",
        "WenQuanYi Zen Hei Mono",
      ],
      bold: [
        "Noto Sans Mono CJK SC Bold",
        "NotoSansMonoCJKsc-Bold",
        "Noto Sans CJK SC Bold",
        "NotoSansCJKsc-Bold",
        "WenQuanYi Zen Hei Mono",
      ],
    },
    emoji: ["Noto Color Emoji"],
  },
};

function fontsFor(platform: string): PlatformFonts {
  if (platform === "darwin" || platform === "win32") return FONTS[platform];
  return FONTS.linux;
}

function quote(family: string): string {
  return /^[\w-]+$/.test(family) && !/^\d/.test(family) ? family : JSON.stringify(family);
}

/** 英文等宽字体在前（xterm 用它量单元格宽度），放大的 CJK 字体、普通中文字体、emoji 依次兜底 */
export function terminalFontFamily(platform: string, withScaledCjk = true): string {
  const fonts = fontsFor(platform);
  return [
    ...fonts.mono,
    ...(withScaledCjk ? [CJK_FONT_FAMILY] : []),
    ...fonts.cjk,
    ...fonts.emoji,
    "monospace",
  ]
    .map(quote)
    .join(", ");
}

/**
 * CJK 字形该放大多少：让 1em 的中文字接近两格宽（留 8% 当字间距，和系统终端里中文的疏密差不多），
 * 最多放大 12%，免得字形高过行高、和英文大小差太多；单元格本来就够窄（比如 Consolas）时不放大。
 */
export function cjkSizeAdjust(cellWidth: number, fontSize: number): number {
  if (!(cellWidth > 0) || !(fontSize > 0)) return 1;
  const ratio = (cellWidth * 2 * 0.92) / fontSize;
  return Math.round(Math.min(1.12, Math.max(1, ratio)) * 1000) / 1000;
}

/** 用 canvas 量英文等宽字体一个字符的宽度（和 xterm 量单元格的方式一致） */
export function measureCellWidth(family: string, fontSize: number): number {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext?.("2d");
  if (!context) return 0;
  context.font = `${fontSize}px ${family}`;
  return context.measureText("W").width;
}

/**
 * 关掉 Chromium 对 CJK 的自动排版调整，让每个字的宽度和 xterm 量到的一致。
 *
 * xterm 的 DOM 渲染器先把每个字符连写 32 遍量出平均宽度，再用 letter-spacing 把它补到「格数 × 单元格宽」。
 * Chromium（123 起）默认 `text-spacing-trim: normal`，连着的全角标点会互相挤掉一半宽度，
 * 于是「，，，…」量出来只有半个字宽，渲染单个「，」时却是整字宽，补上的 letter-spacing 多了半个字：
 * 每个全角标点都往右多推约半格，含标点的长行越往右越错位，最右边的字就被终端区域切掉了。
 * `text-autospace`（中英文之间自动加空隙）同理会让实际宽度和格子对不上，一并关掉。
 * 只作用在终端容器内（含 xterm 量字宽用的隐藏元素），不影响聊天区的排版。
 */
export const TERMINAL_TEXT_STYLE: Readonly<Record<string, string>> = {
  "text-spacing-trim": "space-all",
  "text-autospace": "no-autospace",
};

export function applyTerminalTextStyle(element: HTMLElement): void {
  for (const [property, value] of Object.entries(TERMINAL_TEXT_STYLE)) {
    element.style.setProperty(property, value);
  }
}

const prepared = new Map<string, Promise<boolean>>();

/**
 * 注册放大的 CJK 字体（每个平台、字号只做一次），返回是否成功。
 * 系统里找不到对应字体、或环境不支持 FontFace 时返回 false，字体栈里后面的普通中文字体照常兜底。
 */
export function prepareCjkFont(platform: string, fontSize: number): Promise<boolean> {
  const key = `${platform}:${fontSize}`;
  let task = prepared.get(key);
  if (!task) {
    task = loadCjkFont(platform, fontSize).catch(() => false);
    prepared.set(key, task);
  }
  return task;
}

async function loadCjkFont(platform: string, fontSize: number): Promise<boolean> {
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) {
    return false;
  }
  const fonts = fontsFor(platform);
  const cellWidth = measureCellWidth(fonts.mono.map(quote).join(", "), fontSize);
  const sizeAdjust = `${Math.round(cjkSizeAdjust(cellWidth, fontSize) * 1000) / 10}%`;
  const faces = (["regular", "bold"] as const).map(
    (weight) =>
      new FontFace(
        CJK_FONT_FAMILY,
        fonts.cjkLocal[weight].map((name) => `local(${JSON.stringify(name)})`).join(", "),
        {
          weight: weight === "bold" ? "700" : "400",
          unicodeRange: CJK_UNICODE_RANGE,
          // TS 的 lib.dom 还没收 sizeAdjust，Chromium 92 起支持
          ...({ sizeAdjust } as FontFaceDescriptors),
        },
      ),
  );
  const results = await Promise.allSettled(faces.map((face) => face.load()));
  let loaded = false;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      document.fonts.add(faces[index]!);
      loaded = true;
    }
  });
  return loaded;
}
