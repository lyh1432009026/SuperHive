import { common, createLowlight } from "lowlight";

/**
 * 工作区面板里 diff 与代码预览的纯逻辑：解析 git 的统一格式 diff、排成统一视图或左右对照的行、
 * 折叠未改动的区块、按扩展名选语言并逐行高亮（lowlight，和消息里的代码块用同一套 highlight.js 语法）。
 */

export type DiffLineKind = "context" | "add" | "del";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldNumber?: number;
  newNumber?: number;
  /** 这一行后面跟着「\ No newline at end of file」 */
  noNewline?: boolean;
};

export type DiffHunk = {
  oldStart: number;
  newStart: number;
  header: string;
  lines: DiffLine[];
};

/** 解析 hunk 部分（从第一个 @@ 起）；合并冲突的组合格式（@@@）返回 undefined，按原文显示 */
export function parsePatch(patch: string): DiffHunk[] | undefined {
  if (/^@@@/m.test(patch)) return undefined;
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  let oldNumber = 0;
  let newNumber = 0;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (header) {
      oldNumber = Number(header[1]);
      newNumber = Number(header[2]);
      hunk = { oldStart: oldNumber, newStart: newNumber, header: header[3] ?? "", lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "\\") {
      const last = hunk.lines.at(-1);
      if (last) last.noNewline = true;
    } else if (marker === "+") hunk.lines.push({ kind: "add", text, newNumber: newNumber++ });
    else if (marker === "-") hunk.lines.push({ kind: "del", text, oldNumber: oldNumber++ });
    else
      hunk.lines.push({
        kind: "context",
        text,
        oldNumber: oldNumber++,
        newNumber: newNumber++,
      });
  }
  return hunks;
}

export function diffStats(hunks: DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      if (line.kind === "add") additions++;
      else if (line.kind === "del") deletions++;
    }
  return { additions, deletions };
}

/** 改动前后各留几行上下文，再多的未改动行折叠起来 */
export const CONTEXT_LINES = 3;

export type Gap = { id: string; count: number };

/** 一个可显示的片段：一串行，或折叠起来的一段未改动行 */
export type DiffBlock =
  | { type: "lines"; lines: DiffLine[] }
  | { type: "gap"; gap: Gap; lines: DiffLine[] }
  | { type: "hunk"; header: string; oldStart: number; newStart: number };

/**
 * 把 hunk 排成显示片段：连续超过 2×上下文 的未改动行只留两头，中间折成可展开的一段。
 * expanded 里是已经展开的段（或 "all"）。整份上下文的 diff（只有一个 hunk）照样折叠。
 */
export function diffBlocks(
  hunks: DiffHunk[],
  expanded: ReadonlySet<string> | "all",
  options: { showHunkHeaders: boolean },
): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    if (options.showHunkHeaders)
      blocks.push({
        type: "hunk",
        header: hunk.header,
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
      });
    let pending: DiffLine[] = [];
    const flush = (runStart: number, run: DiffLine[], atStart: boolean, atEnd: boolean) => {
      const keepHead = atStart ? 0 : CONTEXT_LINES;
      const keepTail = atEnd ? 0 : CONTEXT_LINES;
      const id = `${hunkIndex}:${runStart}`;
      const hidden = run.length - keepHead - keepTail;
      if (hidden < 4 || expanded === "all" || expanded.has(id)) {
        pending.push(...run);
        return;
      }
      pending.push(...run.slice(0, keepHead));
      if (pending.length) blocks.push({ type: "lines", lines: pending });
      pending = [];
      blocks.push({
        type: "gap",
        gap: { id, count: hidden },
        lines: run.slice(keepHead, run.length - keepTail),
      });
      pending.push(...run.slice(run.length - keepTail));
    };
    let run: DiffLine[] = [];
    let runStart = 0;
    hunk.lines.forEach((line, index) => {
      if (line.kind === "context") {
        if (!run.length) runStart = index;
        run.push(line);
        return;
      }
      if (run.length) flush(runStart, run, runStart === 0, false);
      run = [];
      pending.push(line);
    });
    if (run.length) flush(runStart, run, runStart === 0, true);
    if (pending.length) blocks.push({ type: "lines", lines: pending });
  });
  return blocks;
}

/** 左右对照的一行：左边是旧版本，右边是新版本；一串删除和紧跟的新增按顺序配对 */
export type SplitRow = { left?: DiffLine; right?: DiffLine };

export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      index++;
      continue;
    }
    const deleted: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (index < lines.length && lines[index]!.kind === "del") deleted.push(lines[index++]!);
    while (index < lines.length && lines[index]!.kind === "add") added.push(lines[index++]!);
    for (let row = 0; row < Math.max(deleted.length, added.length); row++) {
      const left = deleted[row];
      const right = added[row];
      rows.push({ ...(left ? { left } : {}), ...(right ? { right } : {}) });
    }
  }
  return rows;
}

/* ---------- 语法高亮 ---------- */

const lowlight = createLowlight(common);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  astro: "xml",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  sql: "sql",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  m: "objectivec",
  lua: "lua",
  pl: "perl",
  r: "r",
  graphql: "graphql",
  gql: "graphql",
  diff: "diff",
  patch: "diff",
};

const LANGUAGE_BY_NAME: Record<string, string> = {
  makefile: "makefile",
  gnumakefile: "makefile",
  ".gitignore": "bash",
  ".npmrc": "ini",
  ".editorconfig": "ini",
};

/** 按文件名选高亮语言；认不出的返回 undefined（按纯文本显示） */
export function languageFor(filePath: string): string | undefined {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
  const byName = LANGUAGE_BY_NAME[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const language = LANGUAGE_BY_EXTENSION[name.slice(dot + 1)];
  return language && lowlight.registered(language) ? language : undefined;
}

/** 一段带高亮类名的文字 */
export type Token = { text: string; className?: string };

type HastNode =
  | { type: "text"; value: string }
  | { type: "element"; properties?: { className?: unknown }; children: HastNode[] }
  | { type: "root"; children: HastNode[] };

/** 高亮太长的内容很慢，超过就按纯文本（30 万字符的 TS 约 100ms） */
const HIGHLIGHT_LIMIT = 1_000_000;

/**
 * 整段高亮后按行拆开：跨行的注释、字符串也能着色正确。
 * 返回的行数和 text.split("\n") 一致。
 */
export function highlightLines(text: string, language: string | undefined): Token[][] {
  const plain = () => text.split("\n").map((line) => (line ? [{ text: line }] : []));
  if (!language || text.length > HIGHLIGHT_LIMIT) return plain();
  let tree: HastNode;
  try {
    tree = lowlight.highlight(language, text) as HastNode;
  } catch {
    return plain();
  }
  const lines: Token[][] = [[]];
  const visit = (node: HastNode, classes: string[]) => {
    if (node.type === "text") {
      const parts = node.value.split("\n");
      parts.forEach((part, index) => {
        if (index > 0) lines.push([]);
        if (part)
          lines
            .at(-1)!
            .push(classes.length ? { text: part, className: classes.join(" ") } : { text: part });
      });
      return;
    }
    const own =
      node.type === "element" && Array.isArray(node.properties?.className)
        ? (node.properties.className as string[])
        : [];
    for (const child of node.children) visit(child, own.length ? [...classes, ...own] : classes);
  };
  visit(tree, []);
  return lines;
}

/**
 * 给 diff 的每一行配上高亮：把旧版本（未改动 + 删除）和新版本（未改动 + 新增）各自拼起来整段高亮，
 * 再按行放回去，这样多行注释、模板字符串在 diff 里也能正确着色。
 */
export function highlightHunks(
  hunks: DiffHunk[],
  language: string | undefined,
): Map<DiffLine, Token[]> {
  const tokens = new Map<DiffLine, Token[]>();
  for (const hunk of hunks) {
    const before = hunk.lines.filter((line) => line.kind !== "add");
    const after = hunk.lines.filter((line) => line.kind !== "del");
    const beforeTokens = highlightLines(before.map((line) => line.text).join("\n"), language);
    const afterTokens = highlightLines(after.map((line) => line.text).join("\n"), language);
    before.forEach((line, index) => tokens.set(line, beforeTokens[index] ?? []));
    after.forEach((line, index) => {
      if (line.kind === "add") tokens.set(line, afterTokens[index] ?? []);
    });
  }
  return tokens;
}

/** 很多行的 diff 不渲染，只给提示（浏览器一次画太多行会卡） */
export const MAX_RENDERED_DIFF_LINES = 20_000;

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
