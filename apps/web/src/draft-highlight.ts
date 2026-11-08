/**
 * 输入框里的 Markdown 实时着色：叠在 textarea 下面的高亮层用它分段上色。
 * 只改颜色和「描边加粗」（text-shadow），不改字号、字重、字距——高亮层的每个字必须和
 * textarea 里的字一样宽，否则光标会和看到的字错位。
 */

export type DraftTokenKind =
  | "mention"
  | "code"
  | "fence"
  | "mark"
  | "heading"
  | "strong"
  | "emphasis"
  | "strike"
  | "link"
  | "quote";

export type DraftToken = { text: string; kind?: DraftTokenKind };

const mentionPattern = /(?<![A-Za-z0-9_.])@[\p{L}\p{N}_.-]+/gu;

export function highlightDraft(value: string): DraftToken[] {
  const kinds: Array<DraftTokenKind | undefined> = new Array(value.length);
  const paint = (start: number, end: number, kind: DraftTokenKind) => {
    for (let index = start; index < end; index += 1) kinds[index] ??= kind;
  };

  // 代码优先：代码块、行内代码里的东西都不再当成别的语法
  for (const match of value.matchAll(
    /^([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\2[`~]*[ \t]*$|(?![\s\S]))/gm,
  )) {
    const start = match.index;
    const end = start + match[0].length;
    const firstLine = value.indexOf("\n", start);
    // 围栏那两行标灰，中间的代码单独上色
    paint(start, firstLine < 0 ? end : firstLine, "fence");
    const lastLine = value.lastIndexOf("\n", end - 1);
    if (lastLine > firstLine) paint(lastLine + 1, end, "fence");
    paint(start, end, "code");
  }
  for (const match of value.matchAll(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) {
    const start = match.index;
    if (kinds[start]) continue;
    const ticks = match[1]!.length;
    paint(start, start + ticks, "mark");
    paint(start + match[0].length - ticks, start + match[0].length, "mark");
    paint(start, start + match[0].length, "code");
  }

  for (const match of value.matchAll(mentionPattern)) {
    if (!kinds[match.index]) paint(match.index, match.index + match[0].length, "mention");
  }

  const line = (pattern: RegExp, mark: DraftTokenKind, rest?: DraftTokenKind) => {
    for (const match of value.matchAll(pattern)) {
      if (kinds[match.index]) continue;
      const markerEnd = match.index + match[1]!.length;
      paint(match.index, markerEnd, mark);
      if (rest) paint(markerEnd, match.index + match[0].length, rest);
    }
  };
  line(/^(#{1,6}[ \t]+)[^\n]*/gm, "mark", "heading");
  line(/^([ \t]*>[ \t]?)[^\n]*/gm, "mark", "quote");
  line(/^([ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/gm, "mark");

  const wrapped = (pattern: RegExp, size: number, kind: DraftTokenKind) => {
    for (const match of value.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (kinds[start] || kinds[end - 1]) continue;
      paint(start, start + size, "mark");
      paint(end - size, end, "mark");
      paint(start + size, end - size, kind);
    }
  };
  wrapped(/\*\*(?=\S)[^\n]*?\S\*\*|__(?=\S)[^\n]*?\S__/g, 2, "strong");
  wrapped(/~~(?=\S)[^\n]*?\S~~/g, 2, "strike");
  wrapped(
    /(?<![*\w])\*(?=[^\s*])[^\n*]*?[^\s*]\*(?![*\w])|(?<![_\w])_(?=[^\s_])[^\n_]*?[^\s_]_(?![_\w])/g,
    1,
    "emphasis",
  );

  for (const match of value.matchAll(/!?\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    const start = match.index;
    if (kinds[start]) continue;
    const textEnd = start + match[0].indexOf("](");
    const open = match[0].startsWith("!") ? 2 : 1;
    paint(start, start + open, "mark");
    paint(start + open, textEnd, "link");
    paint(textEnd, start + match[0].length, "mark");
  }

  const tokens: DraftToken[] = [];
  let cursor = 0;
  for (let index = 1; index <= value.length; index += 1) {
    if (index === value.length || kinds[index] !== kinds[cursor]) {
      const kind = kinds[cursor];
      tokens.push(
        kind ? { text: value.slice(cursor, index), kind } : { text: value.slice(cursor, index) },
      );
      cursor = index;
    }
  }
  return tokens;
}
